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
//               Returns every site a posting can be applied on (`applyOptions`), plus highlights.
//   Randstad     — no public API found. NOT connected (the frontend offers a search link).
// Each result also carries employmentType, category, tags, applyOptions, highlights, companyUrl
// where the source provides them, so the app can show the full job details and apply links.
//   Remote listings limited to other countries ("USA only", "Europe", ...) are hidden, and the
//   response reports how many (hiddenOtherCountry).
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
const COUNTRY_NAME = { ca: 'Canada', us: 'United States', gb: 'United Kingdom', de: 'Germany', fr: 'France', at: 'Austria', au: 'Australia', nz: 'New Zealand', in: 'India', pl: 'Poland', br: 'Brazil', za: 'South Africa' };
const ARBEITNOW_COUNTRIES = new Set(['de', 'at', 'fr', 'pl', 'gb']);   // Arbeitnow lists mostly European jobs
const DEFAULT_JSEARCH_URL = 'https://api.openwebninja.com/jsearch/search';
const envTrim = n => String(process.env[n] || '').trim().replace(/^["']|["']$/g, '');
const DEFAULT_JSEARCH_RAPID_URL = 'https://jsearch.p.rapidapi.com/search';
// The JSearch key may be stored under JSEARCH_API_KEY (+ JSEARCH_PROVIDER=rapidapi for RapidAPI keys), or under
// a RapidAPI-style name: a key stored that way is automatically treated as a RapidAPI key.
const RAPID_KEY_VARS = ['X_RapidAPI_Key', 'X_RAPIDAPI_KEY', 'RAPIDAPI_KEY', 'RapidAPI_Key', 'X_RAPID_API_KEY'];
function jsearchCredentials() {
  const trim = v => String(v || '').trim().replace(/^["']|["']$/g, '');
  const main = trim(process.env.JSEARCH_API_KEY);
  if (main) return { key: main, rapid: String(process.env.JSEARCH_PROVIDER || '').trim().toLowerCase() === 'rapidapi' };
  for (const name of RAPID_KEY_VARS) {
    const v = trim(process.env[name]);
    if (v) return { key: v, rapid: true };
  }
  return { key: '', rapid: false };
}

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
    adzuna: !!(envTrim('ADZUNA_APP_ID') && envTrim('ADZUNA_APP_KEY')),
    jooble: !!envTrim('JOOBLE_API_KEY'),
    jsearch: !!jsearchCredentials().key
  };
  REMOTE_BOARDS.forEach(name => { out[name] = true; });   // keyless — always available
  return out;
}

function clip(value, max) {
  const s = value == null ? '' : String(value);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function stripHtml(value, max = 2000) {
  const once = v => String(v || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => { const c = parseInt(n, 10); return c > 0 && c < 65536 ? String.fromCharCode(c) : ' '; })
    .replace(/&amp;/g, '&');
  // Some feeds (e.g. We Work Remotely) HTML-escape their HTML, so tags only appear after decoding: strip again.
  let out = once(value);
  for (let i = 0; i < 2 && /<\/?[a-z][^>]*>/i.test(out); i++) out = once(out);
  return clip(out.replace(/\s+/g, ' ').trim(), max);
}
// Full job descriptions (the details view) can be long; allow more than the short-field default.
const stripDesc = value => stripHtml(value, 6000);

function strList(value, maxItems, maxLen) {
  return (Array.isArray(value) ? value : []).map(v => clip(stripHtml(v, maxLen || 300), maxLen || 300)).filter(Boolean).slice(0, maxItems || 12);
}
const EMPLOYMENT_LABELS = { FULLTIME: 'Full time', PARTTIME: 'Part time', CONTRACTOR: 'Contract', INTERN: 'Internship', TEMPORARY: 'Temporary' };
function prettyEnum(value) {
  if (EMPLOYMENT_LABELS[String(value || '').toUpperCase()]) return EMPLOYMENT_LABELS[String(value).toUpperCase()];
  return clip(String(value || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()), 60);
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

const WORLDWIDE_TERMS = ['worldwide', 'global', 'international', 'any location', 'all countries', 'earth', 'anywhere in the world', 'work from anywhere'];
const REGION_TERMS = {
  ca: ['canada', 'canadian', 'north america', 'americas', 'toronto', 'montreal', 'montréal', 'vancouver', 'ottawa', 'calgary', 'edmonton', 'winnipeg', 'quebec', 'québec', 'ontario', 'british columbia', 'alberta', 'manitoba', 'saskatchewan', 'nova scotia', 'new brunswick'],
  us: ['us', 'usa', 'united states', 'u.s.', 'north america', 'americas'],
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
// Every region/country word we know, so a location can be recognised as naming somewhere else.
const ALL_REGION_TERMS = Array.from(new Set(Object.values(REGION_TERMS).flat().concat(['asia', 'africa', 'middle east', 'mena', 'latam', 'usa', 'us', 'u.s.', 'uk', 'eu', 'europe', 'emea', 'apac', 'germany', 'france', 'spain', 'italy', 'netherlands', 'ireland', 'portugal', 'mexico', 'philippines', 'pakistan', 'nigeria', 'kenya', 'argentina', 'colombia', 'singapore', 'japan', 'china'])));
// Words that carry no place information ("Remote", "Remote job", "Work from home").
const GENERIC_LOCATION = /\b(remote|remotely|job|jobs|work|working|from|home|wfh|fully|full|position|positions|role|hybrid|virtual|telecommute|and|or|the|a|in|of)\b/g;

// Heuristic only: remote boards describe who may apply as free text ("USA Only", "Worldwide",
// "Europe"). Plain words match on word boundaries (so "eu" doesn't match "neustadt"); terms with
// punctuation like "u.s." fall back to a substring check.
function hasTerm(loc, term) {
  return /^[a-z ]+$/.test(term) ? new RegExp('\\b' + term + '\\b').test(loc) : loc.includes(term);
}
function eligibleFor(locationText, country) {
  const loc = String(locationText || '').toLowerCase().trim();
  if (!loc) return true;                                   // no restriction stated
  const own = REGION_TERMS[country] || [country];
  if (own.some(term => hasTerm(loc, term))) return true;  // names the candidate's country/region
  if (WORLDWIDE_TERMS.some(term => hasTerm(loc, term))) return true;
  const leftover = loc.replace(GENERIC_LOCATION, ' ').replace(/[^\p{L}]+/gu, ' ').trim();
  if (!leftover) return true;                              // just "Remote" / "Remote job"
  if (/^anywhere$/.test(leftover)) return true;
  return false;                                            // names some other place or "X only"
}
// Remote job descriptions often say who may apply even when the location field doesn't
// ("Headquarters: Remote, US", "must be located in the United States").
const OWN_NAME_IN_TEXT = { ca: /\bcanad/i, us: /\b(united states|usa|u\.s\.|us)\b/i };
function descriptionRestricts(description, country) {
  const text = String(description || '').slice(0, 1500);
  if (!text) return false;
  const own = OWN_NAME_IN_TEXT[country] || new RegExp('\\b' + (COUNTRY_NAME[country] || country) + '\\b', 'i');
  if (own.test(text)) return false;
  const patterns = [
    /\b(?:US|USA|U\.S\.|U\.S\.A\.)[\s-]+(?:only|based|residents?|citizens?)\b/,
    /\bUnited States[\s-]+(?:only|based|residents?|citizens?)\b/i,
    /\bRemote,?\s*\(?(?:in the )?(?:US|USA|U\.S\.|United States)\b/,
    /\bRemote\s*[-\u2013\u2014:|]\s*(?:US|USA|U\.S\.|United States)\b/i,
    /\b(?:candidates|applicants|employees)\s+(?:who are\s+)?(?:based|located|residing)\s+in\s+(?:the\s+)?(?:US|USA|U\.S\.|United States|[A-Z][a-z]+ (?:Jersey|York|Carolina|Dakota|Hampshire|Mexico)|Texas|Florida|California|Ohio|Georgia|Illinois|Virginia)\b/,
    /\b(?:must|required to|need to)\s+(?:be\s+)?(?:located|based|reside|residing|live|living)\s+(?:in|within)\s+(?:the\s+)?(?:US|USA|U\.S\.|United States|UK|EU|Europe)\b/i,
    /\bauthorized to work in the (?:US|USA|U\.S\.|United States)\b/i,
    /\b(?:Europe|EU|EMEA|UK)[\s-]+(?:only|based)\b/
  ];
  return patterns.some(re => re.test(text));
}

function remoteJob(source, label, fields, country) {
  const location = clip(fields.location || '', 200);
  return {
    id: source + ':' + (fields.id || fields.url),
    title: clip(stripHtml(fields.title), 200),
    company: clip(stripHtml(fields.company), 200),
    location,
    description: stripDesc(fields.description),
    employmentType: prettyEnum(fields.employmentType),
    tags: strList(fields.tags, 8, 40),
    url: safeUrl(fields.url),
    postedAt: toIsoDate(fields.postedAt),
    salary: clip(fields.salary || '', 100),
    provider: label,
    publisher: label,
    remote: true,
    eligible: eligibleFor(location, country) && !descriptionRestricts(stripDesc(fields.description), country),
    _tags: Array.isArray(fields.tags) ? fields.tags.join(' ') : ''
  };
}

// ---------- keyed providers ----------

async function searchAdzuna({ q, location, country, page, minSalary, days, types }) {
  if (!ADZUNA_COUNTRIES.has(country)) {
    const err = new Error('country not supported by Adzuna');
    err.status = 400;
    throw err;
  }
  const params = new URLSearchParams({
    app_id: envTrim('ADZUNA_APP_ID'),
    app_key: envTrim('ADZUNA_APP_KEY'),
    what: q,
    results_per_page: String(PER_PROVIDER_LIMIT)
  });
  if (location) params.set('where', location);
  if (minSalary) params.set('salary_min', String(minSalary));
  if (days) params.set('max_days_old', String(days));
  if (types && types.length === 1) {
    const flag = { full: 'full_time', part: 'part_time', contract: 'contract' }[types[0]];
    if (flag) params.set(flag, '1');
  }
  const data = await fetchJson(
    'https://api.adzuna.com/v1/api/jobs/' + country + '/search/' + page + '?' + params.toString(),
    { headers: { Accept: 'application/json' } }
  );
  return (data.results || []).map(j => ({
    id: 'adzuna:' + j.id,
    title: clip(j.title && stripHtml(j.title), 200),
    company: clip(j.company && j.company.display_name, 200),
    location: clip(j.location && j.location.display_name, 200),
    description: stripDesc(j.description),
    employmentType: [j.contract_time, j.contract_type].filter(Boolean).map(prettyEnum).join(', '),
    category: clip(j.category && j.category.label, 80),
    url: safeUrl(j.redirect_url),
    postedAt: toIsoDate(j.created),
    salary: salaryText(j.salary_min, j.salary_max, COUNTRY_CURRENCY[country] || ''),
    provider: 'Adzuna',
    publisher: 'Adzuna',
    remote: false,
    eligible: true
  }));
}

async function searchJooble({ q, location, country, page, minSalary, days }) {
  const body = { keywords: q, page: String(page) };
  if (minSalary) body.salary = String(minSalary);
  if (days) body.datecreatedfrom = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  // Without a location Jooble returns jobs from everywhere — scope it to the chosen country.
  const where = location || COUNTRY_NAME[country] || '';
  if (where) body.location = where;
  const data = await fetchJson('https://jooble.org/api/' + encodeURIComponent(envTrim('JOOBLE_API_KEY')), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  return (data.jobs || []).slice(0, PER_PROVIDER_LIMIT).map(j => ({
    id: 'jooble:' + (j.id || j.link),
    title: clip(stripHtml(j.title), 200),
    company: clip(j.company, 200),
    location: clip(j.location, 200),
    description: stripDesc(j.snippet),
    employmentType: prettyEnum(j.type),
    url: safeUrl(j.link),
    postedAt: toIsoDate(j.updated),
    salary: clip(stripHtml(j.salary), 100),
    provider: 'Jooble',
    publisher: clip(j.source, 100) || 'Jooble',
    remote: false,
    eligible: true
  }));
}

async function searchJSearch({ q, location, country, page, remoteOnly, days, types }) {
  const query = location ? q + ' in ' + location : q;
  const params = new URLSearchParams({ query, page: String(page), num_pages: '1', country });
  if (remoteOnly) params.set('work_from_home', 'true');
  if (days) params.set('date_posted', days <= 1 ? 'today' : days <= 3 ? '3days' : days <= 7 ? 'week' : 'month');
  if (types && types.length) {
    const map = { full: 'FULLTIME', part: 'PARTTIME', contract: 'CONTRACTOR', intern: 'INTERN' };
    const list = types.map(t => map[t]).filter(Boolean);
    if (list.length) params.set('employment_types', list.join(','));
  }
  // Two ways to get the same JSearch service. JSEARCH_PROVIDER=rapidapi (or a JSEARCH_API_URL that
  // contains "rapidapi.com") uses the RapidAPI marketplace: key in X-RapidAPI-Key plus the host header.
  // Otherwise the OpenWeb Ninja endpoint with an x-api-key header is used.
  const customUrl = process.env.JSEARCH_API_URL || '';
  const cred = jsearchCredentials();
  const viaRapid = cred.rapid || /rapidapi\.com/i.test(customUrl);
  const base = customUrl || (viaRapid ? DEFAULT_JSEARCH_RAPID_URL : DEFAULT_JSEARCH_URL);
  let headers;
  if (viaRapid) {
    let host = 'jsearch.p.rapidapi.com';
    try { host = new URL(base).host; } catch (e) { /* keep default */ }
    headers = { Accept: 'application/json', 'X-RapidAPI-Key': cred.key, 'X-RapidAPI-Host': host };
  } else {
    const headerName = process.env.JSEARCH_AUTH_HEADER || 'x-api-key';
    headers = { Accept: 'application/json', [headerName]: cred.key };
  }
  // RapidAPI's current JSearch version names the endpoint differently from older ones, so when no custom URL is
  // set and the first path answers 404, the next likely path is tried (a 404 costs no quota).
  const candidates = (customUrl || !viaRapid) ? [base] : [base, base.replace(/\/search$/, '/job-search'), base.replace(/\/search$/, '/search-v2')];
  let data, lastErr;
  for (const u of candidates) {
    try {
      data = await fetchJson(u + (u.includes('?') ? '&' : '?') + params.toString(), { headers });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (!(e && e.status === 404)) throw e;
    }
  }
  if (lastErr) throw lastErr;
  // Older JSearch versions return data: [ ...jobs ]; v5 returns data: { jobs: [ ...jobs ] }.
  const d = data && data.data;
  const rawJobs = Array.isArray(d) ? d : (d && (d.jobs || d.results)) || (data && (data.jobs || data.results)) || [];
  return rawJobs.filter(j => !j.job_country || String(j.job_country).toLowerCase() === country).slice(0, PER_PROVIDER_LIMIT).map(j => {
    const place = [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ');
    // JSearch lists every site a posting is available on (often including LinkedIn, Indeed,
    // Glassdoor and the employer's own careers page) as `apply_options`.
    const applyOptions = (Array.isArray(j.apply_options) ? j.apply_options : [])
      .map(o => ({ publisher: clip(o && o.publisher, 60), url: safeUrl(o && o.apply_link), direct: !!(o && o.is_direct) }))
      .filter(o => o.url).slice(0, 6);
    const hl = j.job_highlights || {};
    const period = j.job_salary_period ? '/' + String(j.job_salary_period).toLowerCase() : '';
    const salary = salaryText(j.job_min_salary, j.job_max_salary, j.job_salary_currency || '');
    return {
      id: 'jsearch:' + (j.job_id || j.job_apply_link),
      title: clip(stripHtml(j.job_title), 200),
      company: clip(j.employer_name, 200),
      location: clip(place || (j.job_is_remote ? 'Remote' : ''), 200),
      description: stripDesc(j.job_description),
      url: safeUrl(j.job_apply_link) || (applyOptions[0] && applyOptions[0].url) || safeUrl(j.job_google_link),
      postedAt: toIsoDate(j.job_posted_at_datetime_utc),
      salary: salary ? salary + period : '',
      employmentType: Array.isArray(j.job_employment_types) && j.job_employment_types.length ? j.job_employment_types.map(prettyEnum).join(', ') : prettyEnum(j.job_employment_type),
      applyOptions,
      highlights: { qualifications: strList(hl.Qualifications, 10), responsibilities: strList(hl.Responsibilities, 10), benefits: strList(hl.Benefits, 10) },
      companyUrl: safeUrl(j.employer_website),
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
  if (!ARBEITNOW_COUNTRIES.has(country)) return [];
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
  // Optional search-time filters (also re-applied in the browser, since not every source honours them).
  const minSalary = Math.max(0, Math.min(parseInt(query.minSalary, 10) || 0, 1000000));
  const days = [1, 3, 7, 14, 30].includes(parseInt(query.days, 10)) ? parseInt(query.days, 10) : 0;
  const types = String(query.types || '').split(',').map(x => x.trim().toLowerCase()).filter(x => ['full', 'part', 'contract', 'intern', 'temp'].includes(x));

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

  const ctx = { q, location, country, page, remoteOnly, minSalary, days, types };
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
      let detail = '';
      if (status === 401 || status === 403) {
        // Non-secret hints only: which service the key was sent to and how long the stored value is.
        if (name === 'jsearch') {
          const c = jsearchCredentials();
          const viaRapid = c.rapid || /rapidapi\.com/i.test(process.env.JSEARCH_API_URL || '');
          detail = ' - key rejected by ' + (viaRapid ? 'RapidAPI' : 'OpenWeb Ninja') + ' (stored value: ' + c.key.length + ' characters; RapidAPI keys are about 50)';
        } else if (name === 'jooble') {
          detail = ' - key rejected (stored value: ' + envTrim('JOOBLE_API_KEY').length + ' characters; Jooble keys are 36)';
        } else {
          detail = ' - key rejected, check it in Vercel';
        }
      }
      providerErrors[name] = status ? 'HTTP ' + status + detail : 'request failed';
    }
  });

  // Jobs the candidate can plausibly take first (by the remote boards' location restriction),
  // newest first within each group. Internal helper fields never leave the server.
  const deduped = dedupe(jobs);
  const results = deduped
    .filter(j => j.eligible !== false)
    .sort((a, b) => (Number(b.eligible !== false) - Number(a.eligible !== false)) || ((Date.parse(b.postedAt) || 0) - (Date.parse(a.postedAt) || 0)))
    .map(({ _tags, ...rest }) => ({ employmentType: '', category: '', tags: [], applyOptions: [], highlights: null, companyUrl: '', ...rest }));
  const hiddenOtherCountry = deduped.length - results.length;
  return res.status(200).json({ results, providers: configured, searched: enabled, providerErrors, hiddenOtherCountry });
}
