// Vercel serverless function: GET /api/jobs-search
//
// Searches live job listings across the job-data sources that actually offer open/legitimate
// access, and returns them in one normalized shape. Provider keys live ONLY in server
// environment variables — never in the frontend — and the endpoint requires a signed-in
// Parcourai user, so rate-limited provider quotas can't be burned by anonymous traffic.
//
// What is (and isn't) connected — verified against each source's own docs/terms:
//   * LinkedIn   — no public job-search API (partner-only, for posting jobs). NOT connected.
//   * Indeed     — Publisher search API shut down. NOT connected.
//   * Glassdoor  — its partner API has returned HTTP 410 Gone since Aug 2025. NOT connected.
//   * Guichet-Emplois / Job Bank — no live public API (its XML feed is only for approved job
//                  boards with a Canadian Business Number; open data is monthly CSV). NOT connected.
//   * Jobillico  — no public developer API found. NOT connected.
//   The frontend offers pre-filled search links to those sites instead (nothing is scraped).
//
// Connected sources:
//   Keyed (enabled only when env vars are set):
//     Adzuna  — ADZUNA_APP_ID, ADZUNA_APP_KEY        (https://developer.adzuna.com/signup)
//     Jooble  — JOOBLE_API_KEY                        (request at https://jooble.org/api/about)
//     JSearch — JSEARCH_API_KEY (+ optional JSEARCH_API_URL, JSEARCH_AUTH_HEADER)
//               aggregates Google for Jobs, which includes listings from LinkedIn/Indeed/Glassdoor.
//   Keyless remote-job boards (always on, each requires attribution — every result links back to
//   the source's own listing page and names the source):
//     Remotive, Remote OK, Jobicy, Himalayas, We Work Remotely (RSS), Arbeitnow (remote listings)
//
// Query params:  q (required), location, country (default "ca"), page (default 1),
//                remote=only (remote-capable sources only), providers (comma list filter),
//                status=1 (returns which providers are available; no search performed)

import admin from 'firebase-admin';

if (!admin.apps.length) {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (encoded) {
    const serviceAccount = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
}

const TIMEOUT_MS = 9000;
const PER_PROVIDER_LIMIT = 20;
const MAX_BODY_CHARS = 6 * 1024 * 1024;
const USER_AGENT = 'ParcourAI-JobSearch/1.0 (+https://parcourai.com)';
const ADZUNA_COUNTRIES = new Set(['gb', 'us', 'ca', 'de', 'fr', 'au', 'nz', 'in', 'pl', 'br', 'at', 'za']);
const COUNTRY_CURRENCY = { ca: 'CAD', us: 'USD', gb: 'GBP', de: 'EUR', fr: 'EUR', at: 'EUR', au: 'AUD', nz: 'NZD', in: 'INR', pl: 'PLN', br: 'BRL', za: 'ZAR' };
const DEFAULT_JSEARCH_URL = 'https://api.openwebninja.com/jsearch/search';

const KEYED_PROVIDERS = ['adzuna', 'jooble', 'jsearch'];
const REMOTE_BOARDS = ['remotive', 'remoteok', 'jobicy', 'himalayas', 'weworkremotely', 'arbeitnow'];
// Sources that can honour a "remote only" search.
const REMOTE_CAPABLE = new Set([...REMOTE_BOARDS, 'jsearch']);

// ---------- small utilities ----------

// Best-effort per-user throttle. Serverless instances don't share memory, so this only slows
// a runaway client hitting one warm instance — it is not a hard quota.
const recentCalls = new Map();
const THROTTLE_WINDOW_MS = 10 * 60 * 1000;
const THROTTLE_MAX = 40;
function throttled(uid) {
  const now = Date.now();
  const calls = (recentCalls.get(uid) || []).filter(ts => now - ts < THROTTLE_WINDOW_MS);
  calls.push(now);
  recentCalls.set(uid, calls);
  return calls.length > THROTTLE_MAX;
}

// Tiny TTL cache so the free remote-job feeds (some of which ask integrators to call them only
// a few times a day) aren't hit on every keystroke-driven search.
const cache = new Map();
const CACHE_MAX_ENTRIES = 60;
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) { cache.delete(key); return undefined; }
  return hit.value;
}
function cacheSet(key, value, ttlMs) {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + ttlMs });
}
async function cached(key, ttlMs, loader) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  cacheSet(key, value, ttlMs);
  return value;
}

// Minimum gap between real upstream calls per source (Remotive blocks bursts above ~2/minute).
const lastUpstreamCall = new Map();
function enforceCooldown(source, ms) {
  const last = lastUpstreamCall.get(source) || 0;
  if (Date.now() - last < ms) {
    const err = new Error('cooldown');
    err.status = 429;
    throw err;
  }
  lastUpstreamCall.set(source, Date.now());
}

function configuredProviders() {
  const out = {
    adzuna: !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY),
    jooble: !!process.env.JOOBLE_API_KEY,
    jsearch: !!process.env.JSEARCH_API_KEY
  };
  REMOTE_BOARDS.forEach(name => { out[name] = true; });   // keyless — always available
  return out;
}

function clip(value, max) {
  const s = value == null ? '' : String(value);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function stripHtml(value) {
  return clip(
    String(value || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (m, n) => { const c = parseInt(n, 10); return c > 0 && c < 65536 ? String.fromCharCode(c) : ' '; })
      .replace(/\s+/g, ' ')
      .trim(),
    2000
  );
}

// Only ever hand the browser http(s) links — a provider response must never be able to inject
// a javascript: or data: URL into an href.
function safeUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
  } catch (e) {
    return '';
  }
}

function toIsoDate(value) {
  if (value === null || value === undefined || value === '') return '';
  let v = value;
  if (typeof v === 'number') v = v < 1e12 ? v * 1000 : v;      // unix seconds → ms
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

function salaryText(min, max, currency) {
  const fmt = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const hasMin = typeof min === 'number' && min > 0;
  const hasMax = typeof max === 'number' && max > 0;
  if (!hasMin && !hasMax) return '';
  const prefix = currency ? currency + ' ' : '';
  if (hasMin && hasMax && min !== max) return prefix + fmt(min) + '–' + fmt(max);
  return prefix + fmt(hasMin ? min : max);
}

async function fetchRaw(url, options, asText) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    if (!resp.ok) {
      const err = new Error('HTTP ' + resp.status);
      err.status = resp.status;
      throw err;
    }
    if (asText) return (await resp.text()).slice(0, MAX_BODY_CHARS);
    return await resp.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('timeout');
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
const fetchJson = (url, options) => fetchRaw(url, options, false);
const fetchText = (url, options) => fetchRaw(url, options, true);

// ---------- remote-board helpers ----------

const STOPWORDS = new Set(['and', 'the', 'in', 'of', 'for', 'a', 'an', 'to', 'at', 'or', '&', '-', '/']);
function queryTokens(q) {
  return String(q || '').toLowerCase().split(/[\s,;]+/)
    .map(s => s.replace(/^[^\p{L}\p{N}+#]+|[^\p{L}\p{N}+#]+$/gu, ''))
    .filter(s => s.length > 1 && !STOPWORDS.has(s));
}
// Boards without a server-side search (or whose search is loose) are filtered here: every
// meaningful word of the query must appear in the title / company / tags / description.
function matchesQuery(job, tokens) {
  if (tokens.length === 0) return true;
  const hay = (job.title + ' ' + job.company + ' ' + (job._tags || '') + ' ' + job.description).toLowerCase();
  return tokens.every(tok => hay.includes(tok));
}

const WORLDWIDE_TERMS = ['worldwide', 'anywhere', 'global', 'international', 'any location', 'all countries', 'earth', 'remote'];
const REGION_TERMS = {
  ca: ['canada', 'north america', 'americas'],
  us: ['usa', 'united states', 'u.s.', 'north america', 'americas'],
  gb: ['uk', 'united kingdom', 'england', 'great britain', 'europe', 'emea'],
  de: ['germany', 'europe', 'emea', 'eu'],
  fr: ['france', 'europe', 'emea', 'eu'],
  at: ['austria', 'europe', 'emea', 'eu'],
  pl: ['poland', 'europe', 'emea', 'eu'],
  au: ['australia', 'apac', 'oceania'],
  nz: ['new zealand', 'apac', 'oceania'],
  in: ['india', 'asia', 'apac'],
  br: ['brazil', 'latam', 'latin america', 'south america', 'americas'],
  za: ['south africa', 'africa', 'emea']
};
// Heuristic only: remote boards describe who may apply as free text ("USA Only", "Worldwide",
// "Europe"). An empty restriction counts as open. The raw text is always shown to the user.
function hasTerm(loc, term) {
  // Plain words match on word boundaries (so "eu" doesn't match "neustadt"); terms with
  // punctuation like "u.s." fall back to a substring check.
  return /^[a-z ]+$/.test(term) ? new RegExp('\\b' + term + '\\b').test(loc) : loc.includes(term);
}
function eligibleFor(locationText, country) {
  const loc = String(locationText || '').toLowerCase().trim();
  if (!loc) return true;
  const countryTerms = REGION_TERMS[country] || [country];
  if (countryTerms.some(term => hasTerm(loc, term))) return true;
  // "USA Only", "Remote (EU only)" etc. name a region that isn't the candidate's.
  if (/\bonly\b/.test(loc)) return false;
  return WORLDWIDE_TERMS.some(term => hasTerm(loc, term));
}

function remoteJob(source, label, fields, country) {
  const location = clip(fields.location || '', 200);
  return {
    id: source + ':' + (fields.id || fields.url),
    title: clip(stripHtml(fields.title), 200),
    company: clip(stripHtml(fields.company), 200),
    location,
    description: stripHtml(fields.description),
    url: safeUrl(fields.url),
    postedAt: toIsoDate(fields.postedAt),
    salary: clip(fields.salary || '', 100),
    provider: label,
    publisher: label,
    remote: true,
    eligible: eligibleFor(location, country),
    _tags: Array.isArray(fields.tags) ? fields.tags.join(' ') : ''
  };
}

// ---------- keyed providers ----------

async function searchAdzuna({ q, location, country, page }) {
  if (!ADZUNA_COUNTRIES.has(country)) {
    const err = new Error('country not supported by Adzuna');
    err.status = 400;
    throw err;
  }
  const params = new URLSearchParams({
    app_id: process.env.ADZUNA_APP_ID,
    app_key: process.env.ADZUNA_APP_KEY,
    what: q,
    results_per_page: String(PER_PROVIDER_LIMIT)
  });
  if (location) params.set('where', location);
  const data = await fetchJson(
    'https://api.adzuna.com/v1/api/jobs/' + country + '/search/' + page + '?' + params.toString(),
    { headers: { Accept: 'application/json' } }
  );
  return (data.results || []).map(j => ({
    id: 'adzuna:' + j.id,
    title: clip(j.title && stripHtml(j.title), 200),
    company: clip(j.company && j.company.display_name, 200),
    location: clip(j.location && j.location.display_name, 200),
    description: stripHtml(j.description),
    url: safeUrl(j.redirect_url),
    postedAt: toIsoDate(j.created),
    salary: salaryText(j.salary_min, j.salary_max, COUNTRY_CURRENCY[country] || ''),
    provider: 'Adzuna',
    publisher: 'Adzuna',
    remote: false,
    eligible: true
  }));
}

async function searchJooble({ q, location, page }) {
  const body = { keywords: q, page: String(page) };
  if (location) body.location = location;
  const data = await fetchJson('https://jooble.org/api/' + encodeURIComponent(process.env.JOOBLE_API_KEY), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  return (data.jobs || []).slice(0, PER_PROVIDER_LIMIT).map(j => ({
    id: 'jooble:' + (j.id || j.link),
    title: clip(stripHtml(j.title), 200),
    company: clip(j.company, 200),
    location: clip(j.location, 200),
    description: stripHtml(j.snippet),
    url: safeUrl(j.link),
    postedAt: toIsoDate(j.updated),
    salary: clip(stripHtml(j.salary), 100),
    provider: 'Jooble',
    publisher: clip(j.source, 100) || 'Jooble',
    remote: false,
    eligible: true
  }));
}

async function searchJSearch({ q, location, country, page, remoteOnly }) {
  const query = location ? q + ' in ' + location : q;
  const params = new URLSearchParams({ query, page: String(page), num_pages: '1', country });
  if (remoteOnly) params.set('work_from_home', 'true');
  const base = process.env.JSEARCH_API_URL || DEFAULT_JSEARCH_URL;
  const headerName = process.env.JSEARCH_AUTH_HEADER || 'x-api-key';
  const data = await fetchJson(base + (base.includes('?') ? '&' : '?') + params.toString(), {
    headers: { Accept: 'application/json', [headerName]: process.env.JSEARCH_API_KEY }
  });
  return (data.data || []).slice(0, PER_PROVIDER_LIMIT).map(j => {
    const place = [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ');
    return {
      id: 'jsearch:' + (j.job_id || j.job_apply_link),
      title: clip(stripHtml(j.job_title), 200),
      company: clip(j.employer_name, 200),
      location: clip(place || (j.job_is_remote ? 'Remote' : ''), 200),
      description: stripHtml(j.job_description),
      url: safeUrl(j.job_apply_link || j.job_google_link),
      postedAt: toIsoDate(j.job_posted_at_datetime_utc),
      salary: salaryText(j.job_min_salary, j.job_max_salary, j.job_salary_currency || ''),
      provider: 'JSearch',
      publisher: clip(j.job_publisher, 100) || 'JSearch',
      remote: !!j.job_is_remote,
      eligible: true
    };
  });
}

// ---------- keyless remote-job boards ----------

// Remotive — https://github.com/remotive-com/remote-jobs-api  (asks for few calls/day; bursts
// above ~2/minute are blocked → long cache + cooldown). Must link back and name Remotive.
async function searchRemotive({ q, country, page }) {
  if (page > 1) return [];
  const data = await cached('remotive:' + q.toLowerCase(), 6 * 3600 * 1000, async () => {
    enforceCooldown('remotive', 30 * 1000);
    return fetchJson('https://remotive.com/api/remote-jobs?limit=100&search=' + encodeURIComponent(q), { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
  });
  const tokens = queryTokens(q);
  return (data.jobs || []).map(j => remoteJob('remotive', 'Remotive', {
    id: j.id, title: j.title, company: j.company_name, location: j.candidate_required_location,
    description: j.description, url: j.url, postedAt: j.publication_date, salary: j.salary,
    tags: [j.category].concat(Array.isArray(j.tags) ? j.tags : [])
  }, country)).filter(j => matchesQuery(j, tokens)).slice(0, PER_PROVIDER_LIMIT);
}

// Remote OK — https://remoteok.com/api  (first array element is a legal notice; requires a
// followed link back to the listing and mention of Remote OK, which every result provides).
async function searchRemoteOK({ q, country, page }) {
  if (page > 1) return [];
  const data = await cached('remoteok', 3600 * 1000, () => fetchJson('https://remoteok.com/api', { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }));
  const tokens = queryTokens(q);
  return (Array.isArray(data) ? data : []).filter(j => j && j.position).map(j => remoteJob('remoteok', 'Remote OK', {
    id: j.id, title: j.position, company: j.company, location: j.location, description: j.description,
    url: j.url, postedAt: j.date, tags: j.tags,
    salary: salaryText(j.salary_min, j.salary_max, 'USD')
  }, country)).filter(j => matchesQuery(j, tokens)).slice(0, PER_PROVIDER_LIMIT);
}

// Jobicy — https://jobicy.com/api/v2/remote-jobs  (7-day window; keep Jobicy as the source and
// the canonical Jobicy URL).
async function searchJobicy({ q, country, page }) {
  if (page > 1) return [];
  const data = await cached('jobicy:' + q.toLowerCase(), 30 * 60 * 1000, () =>
    fetchJson('https://jobicy.com/api/v2/remote-jobs?count=50&tag=' + encodeURIComponent(q), { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }));
  const tokens = queryTokens(q);
  return (data.jobs || []).map(j => remoteJob('jobicy', 'Jobicy', {
    id: j.id, title: j.jobTitle, company: j.companyName, location: j.jobGeo, description: j.jobDescription,
    url: j.url, postedAt: j.pubDate, tags: [j.jobIndustry].concat(Array.isArray(j.jobType) ? j.jobType : [j.jobType]).filter(Boolean),
    salary: salaryText(Number(j.salaryMin), Number(j.salaryMax), j.salaryCurrency || '') + (j.salaryPeriod && (j.salaryMin || j.salaryMax) ? '/' + j.salaryPeriod : '')
  }, country)).filter(j => matchesQuery(j, tokens)).slice(0, PER_PROVIDER_LIMIT);
}

// Himalayas — https://himalayas.app/jobs/api/search  (must link back to Himalayas and name it
// as the source).
async function searchHimalayas({ q, country, page }) {
  const data = await cached('himalayas:' + q.toLowerCase() + ':' + page, 30 * 60 * 1000, () =>
    fetchJson('https://himalayas.app/jobs/api/search?sort=recent&page=' + page + '&q=' + encodeURIComponent(q), { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }));
  return (data.jobs || []).slice(0, PER_PROVIDER_LIMIT).map(j => remoteJob('himalayas', 'Himalayas', {
    id: j.guid, title: j.title, company: j.companyName,
    location: Array.isArray(j.locationRestrictions) ? j.locationRestrictions.join(', ') : '',
    description: j.description || j.excerpt, url: j.guid && safeUrl(j.guid) ? j.guid : j.applicationLink,
    postedAt: j.pubDate, tags: [].concat(j.categories || [], j.seniority || []),
    salary: salaryText(j.minSalary, j.maxSalary, j.currency || '')
  }, country));
}

// We Work Remotely — public RSS (https://weworkremotely.com/remote-jobs.rss). "Anyone can use
// the feed; we ask that you attribute the links back to We Work Remotely."
function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null && items.length < 200) {
    const block = m[1];
    const tag = name => {
      const r = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>', 'i').exec(block);
      return r ? r[1].trim() : '';
    };
    items.push({ title: tag('title'), link: tag('link') || tag('guid'), description: tag('description'),
      pubDate: tag('pubDate'), region: tag('region') || tag('country'), category: tag('category'), type: tag('type') });
  }
  return items;
}
async function searchWeWorkRemotely({ q, country, page }) {
  if (page > 1) return [];
  const xml = await cached('wwr', 3600 * 1000, () => fetchText('https://weworkremotely.com/remote-jobs.rss', { headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': USER_AGENT } }));
  const tokens = queryTokens(q);
  return parseRssItems(xml).map(it => {
    const title = stripHtml(it.title);
    // WWR titles look like "Company: Job Title".
    const idx = title.indexOf(': ');
    const company = idx > 0 ? title.slice(0, idx) : '';
    const jobTitle = idx > 0 ? title.slice(idx + 2) : title;
    return remoteJob('weworkremotely', 'We Work Remotely', {
      id: it.link, title: jobTitle, company, location: stripHtml(it.region), description: it.description,
      url: it.link, postedAt: it.pubDate, tags: [stripHtml(it.category), stripHtml(it.type)].filter(Boolean)
    }, country);
  }).filter(j => matchesQuery(j, tokens)).slice(0, PER_PROVIDER_LIMIT);
}

// Arbeitnow — https://www.arbeitnow.com/api/job-board-api (no key; mostly Europe). Only listings
// flagged remote are returned.
async function searchArbeitnow({ q, country, page }) {
  const data = await cached('arbeitnow:' + page, 3600 * 1000, () =>
    fetchJson('https://www.arbeitnow.com/api/job-board-api?page=' + page, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }));
  const tokens = queryTokens(q);
  return (data.data || []).filter(j => j && j.remote).map(j => remoteJob('arbeitnow', 'Arbeitnow', {
    id: j.slug, title: j.title, company: j.company_name, location: j.location, description: j.description,
    url: j.url, postedAt: j.created_at, tags: [].concat(j.tags || [], j.job_types || [])
  }, country)).filter(j => matchesQuery(j, tokens)).slice(0, PER_PROVIDER_LIMIT);
}

const PROVIDER_FNS = {
  adzuna: searchAdzuna, jooble: searchJooble, jsearch: searchJSearch,
  remotive: searchRemotive, remoteok: searchRemoteOK, jobicy: searchJobicy,
  himalayas: searchHimalayas, weworkremotely: searchWeWorkRemotely, arbeitnow: searchArbeitnow
};

function dedupe(jobs) {
  const seen = new Set();
  return jobs.filter(j => {
    if (!j.title || !j.url) return false;
    const key = [j.title, j.company, j.location].map(s => s.toLowerCase().replace(/\s+/g, ' ').trim()).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!admin.apps.length) {
    return res.status(500).json({ error: 'Server misconfigured: FIREBASE_SERVICE_ACCOUNT_BASE64 is not set.' });
  }

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session — please sign in again.' });
  }

  const configured = configuredProviders();
  const query = req.query || {};

  if (query.status) {
    return res.status(200).json({ providers: configured });
  }

  const q = String(query.q || '').trim().slice(0, 150);
  if (!q) {
    return res.status(400).json({ error: 'q (job title or keywords) is required.' });
  }
  const location = String(query.location || '').trim().slice(0, 100);
  const country = /^[a-z]{2}$/i.test(String(query.country || '')) ? String(query.country).toLowerCase() : 'ca';
  const page = Math.min(Math.max(parseInt(query.page, 10) || 1, 1), 10);
  const remoteOnly = String(query.remote || '') === 'only';

  const requested = String(query.providers || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const enabled = Object.keys(PROVIDER_FNS).filter(name =>
    configured[name] &&
    (requested.length === 0 || requested.includes(name)) &&
    (!remoteOnly || REMOTE_CAPABLE.has(name))
  );
  if (enabled.length === 0) {
    return res.status(503).json({
      error: 'No matching job-search provider is available. Add ADZUNA_APP_ID + ADZUNA_APP_KEY, JOOBLE_API_KEY, and/or JSEARCH_API_KEY to your server environment variables, or remove the provider filter.',
      providers: configured
    });
  }

  if (throttled(decodedToken.uid)) {
    return res.status(429).json({ error: 'Too many searches in a short time — please wait a few minutes and try again.' });
  }

  const ctx = { q, location, country, page, remoteOnly };
  const settled = await Promise.allSettled(enabled.map(name => PROVIDER_FNS[name](ctx)));
  const jobs = [];
  const providerErrors = {};
  settled.forEach((result, i) => {
    const name = enabled[i];
    if (result.status === 'fulfilled') {
      jobs.push(...result.value);
    } else {
      // Log the detail server-side; the browser only gets a short, non-sensitive reason.
      console.error('[jobs-search] ' + name + ' failed:', result.reason && result.reason.message);
      const status = result.reason && result.reason.status;
      providerErrors[name] = status ? 'HTTP ' + status : 'request failed';
    }
  });

  // Jobs the candidate can plausibly take first (by the remote boards' location restriction),
  // newest first within each group. Internal helper fields never leave the server.
  const results = dedupe(jobs)
    .sort((a, b) => (Number(b.eligible !== false) - Number(a.eligible !== false)) || ((Date.parse(b.postedAt) || 0) - (Date.parse(a.postedAt) || 0)))
    .map(({ _tags, ...rest }) => rest);
  return res.status(200).json({ results, providers: configured, searched: enabled, providerErrors });
}
