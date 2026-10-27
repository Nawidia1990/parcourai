// Connect-your-email and send from the app: /api/mail?a=<action>
//   GET  status      - is a mailbox connected (provider, address)
//   POST connect     - { provider: 'google' | 'microsoft' } -> { url } to open the consent screen
//   GET  (with code) - OAuth callback; stores the encrypted refresh token, redirects back to the app
//   POST send        - { to, subject, body, attachments:[{filename, base64, mime}] }
//   POST disconnect  - forget the stored token
// Only a send-only permission is requested (gmail.send / Mail.Send); the app can never read the inbox.
import crypto from 'node:crypto';
import { requireUser } from './_staffauth.js';
import { initAdmin } from './_plans.js';
import admin from 'firebase-admin';

const PROVIDERS = {
  google: {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email https://www.googleapis.com/auth/gmail.send',
    id: () => process.env.GOOGLE_OAUTH_CLIENT_ID, secret: () => process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  microsoft: {
    auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid email offline_access https://graph.microsoft.com/Mail.Send',
    id: () => process.env.MS_OAUTH_CLIENT_ID, secret: () => process.env.MS_OAUTH_CLIENT_SECRET,
    extra: { prompt: 'select_account' },
  },
};

const encKey = () => {
  const k = process.env.MAIL_ENC_KEY;
  if (!k) throw new Error('Server misconfigured: MAIL_ENC_KEY is not set.');
  return crypto.createHash('sha256').update(k).digest();
};
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', encKey()).update(body).digest('base64url');
  return body + '.' + mac;
};
export function verifyState(s) {
  const [body, mac] = String(s || '').split('.');
  if (!body || !mac) return null;
  const good = crypto.createHmac('sha256', encKey()).update(body).digest('base64url');
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const baseUrl = (req) => (process.env.APP_URL || ('https://' + req.headers.host)).replace(/\/$/, '');
const redirectUri = (req) => baseUrl(req) + '/api/mail';
const isEmail = (s) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(s || '').trim());
const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();

async function tokenRequest(p, params) {
  const r = await fetch(p.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error_description || j.error || 'Token request failed'); e.code = j.error; throw e; }
  return j;
}
const jwtEmail = (idToken) => { try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString()); } catch { return {}; } };

// Builds an RFC 822 message (Gmail wants the raw message).
export function buildMime({ from, to, subject, body, attachments }) {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const head = [`From: ${from}`, `To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`, 'MIME-Version: 1.0'];
  if (!attachments.length) {
    return [...head, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(body)].join('\r\n');
  }
  const bd = 'parcourai_' + crypto.randomBytes(8).toString('hex');
  const parts = [...head, `Content-Type: multipart/mixed; boundary="${bd}"`, '',
    `--${bd}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(body)];
  for (const a of attachments) {
    const fn = `=?UTF-8?B?${Buffer.from(a.filename, 'utf8').toString('base64')}?=`;
    parts.push(`--${bd}`, `Content-Type: ${a.mime}; name="${fn}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${fn}"`, '', a.base64.replace(/(.{76})/g, '$1\r\n'));
  }
  parts.push(`--${bd}--`, '');
  return parts.join('\r\n');
}

export default async function handler(req, res) {
  try {
    if (!initAdmin()) return res.status(500).json({ error: 'Server misconfigured: FIREBASE_SERVICE_ACCOUNT_BASE64 is not set.' });
    const db = admin.firestore();
    const a = String(req.query.a || '');

    // ---- OAuth callback (a plain browser redirect, no Bearer token) ----
    if (req.method === 'GET' && (req.query.code || req.query.error)) {
      const back = (q) => { res.statusCode = 302; res.setHeader('Location', baseUrl(req) + '/?mail=' + q); res.end(); };
      const st = verifyState(req.query.state);
      if (!st) return back('error');
      if (req.query.error) return back('denied');
      const p = PROVIDERS[st.provider];
      try {
        const tok = await tokenRequest(p, { code: String(req.query.code), client_id: p.id(), client_secret: p.secret(), redirect_uri: redirectUri(req), grant_type: 'authorization_code' });
        if (!tok.refresh_token) return back('norefresh');
        const email = jwtEmail(tok.id_token).email || jwtEmail(tok.id_token).preferred_username || '';
        await db.collection('mailAccounts').doc(st.uid).set({ provider: st.provider, email, refreshToken: encrypt(tok.refresh_token), connectedAt: admin.firestore.FieldValue.serverTimestamp() });
        return back('connected');
      } catch (e) { return back('error'); }
    }

    const ctx = await requireUser(req, res); if (!ctx) return;
    const { user } = ctx;
    const ref = db.collection('mailAccounts').doc(user.uid);

    if (a === 'status') {
      const s = await ref.get();
      const d = s.exists ? s.data() : null;
      const configured = { google: !!PROVIDERS.google.id(), microsoft: !!PROVIDERS.microsoft.id() };
      return res.status(200).json({ connected: !!d, provider: d?.provider || null, email: d?.email || '', configured });
    }
    if (a === 'disconnect' && req.method === 'POST') { await ref.delete(); return res.status(200).json({ ok: true }); }

    if (a === 'connect' && req.method === 'POST') {
      const provider = String(req.body?.provider || '');
      const p = PROVIDERS[provider];
      if (!p) return res.status(400).json({ error: 'Unknown provider.' });
      if (!p.id() || !p.secret()) return res.status(501).json({ error: 'not_configured', message: 'This email provider is not set up on the server yet.' });
      const state = sign({ uid: user.uid, provider, exp: Date.now() + 10 * 60 * 1000 });
      const q = new URLSearchParams({ client_id: p.id(), redirect_uri: redirectUri(req), response_type: 'code', scope: p.scope, state, ...p.extra });
      return res.status(200).json({ url: p.auth + '?' + q });
    }

    if (a === 'send' && req.method === 'POST') {
      const s = await ref.get();
      if (!s.exists) return res.status(409).json({ error: 'not_connected', message: 'Connect your email account first.' });
      const acct = s.data();
      const p = PROVIDERS[acct.provider];
      const b = req.body || {};
      const to = clean(b.to), subject = clean(b.subject), body = String(b.body || '');
      if (!isEmail(to)) return res.status(400).json({ error: 'bad_to', message: 'Enter a valid recipient email.' });
      if (!subject || !body.trim()) return res.status(400).json({ error: 'empty', message: 'Subject and message are required.' });
      const attachments = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 3)
        .map((x) => ({ filename: clean(x.filename).replace(/[\\/"]/g, '_') || 'document.pdf', mime: 'application/pdf', base64: String(x.base64 || '').replace(/[^A-Za-z0-9+/=]/g, '') }))
        .filter((x) => x.base64);
      if (attachments.reduce((n, x) => n + x.base64.length, 0) > 3_000_000) return res.status(413).json({ error: 'too_big', message: 'Attachments are too large.' });

      let tok;
      try { tok = await tokenRequest(p, { client_id: p.id(), client_secret: p.secret(), refresh_token: decrypt(acct.refreshToken), grant_type: 'refresh_token' }); }
      catch (e) { if (e.code === 'invalid_grant') { await ref.delete(); return res.status(409).json({ error: 'not_connected', message: 'Your email connection expired. Please connect again.' }); } throw e; }

      let r;
      if (acct.provider === 'google') {
        const raw = Buffer.from(buildMime({ from: acct.email, to, subject, body, attachments }), 'utf8').toString('base64url');
        r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }) });
      } else {
        const message = { subject, body: { contentType: 'Text', content: body }, toRecipients: [{ emailAddress: { address: to } }],
          attachments: attachments.map((x) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: x.filename, contentType: x.mime, contentBytes: x.base64 })) };
        r = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST', headers: { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ message, saveToSentItems: true }) });
      }
      if (!r.ok) { const j = await r.json().catch(() => ({})); return res.status(502).json({ error: 'send_failed', message: j.error?.message || ('Send failed (' + r.status + ')') }); }
      return res.status(200).json({ ok: true, from: acct.email });
    }
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
