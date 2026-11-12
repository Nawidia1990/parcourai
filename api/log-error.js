// Vercel serverless function: POST /api/log-error
//
// The frontend posts uncaught errors here (see the window.onerror /
// unhandledrejection handlers in index.html) so staff can see real production
// errors instead of only hearing about them secondhand from users. Runs
// without requiring sign-in, since errors can happen on public pages too
// (landing page, blog, etc.) before anyone has an account.
//
// Scope note: this intentionally has no rate-limiting or cleanup job yet —
// a broken deploy that errors on every page load could write a lot of rows
// in a short window. That's an acceptable MVP trade-off for now, but worth
// revisiting (e.g. capping writes per IP per minute, or a scheduled function
// that prunes entries older than 30 days) if this collection grows large.

import admin from 'firebase-admin';

if (!admin.apps.length) {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (encoded) {
    const serviceAccount = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!admin.apps.length) {
    // Fail silently from the client's point of view — a broken logging
    // pipeline shouldn't itself become a visible error to real users.
    return res.status(200).json({ logged: false });
  }

  const { message, stack, url, uid } = req.body || {};
  if (!message) {
    return res.status(400).json({ error: 'message is required.' });
  }

  try {
    const db = admin.firestore();
    await db.collection('errorLogs').add({
      message: String(message).slice(0, 2000),
      stack: stack ? String(stack).slice(0, 4000) : null,
      url: url ? String(url).slice(0, 500) : null,
      uid: uid || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return res.status(200).json({ logged: true });
  } catch (e) {
    // Same reasoning as above — don't let logging failures surface to users.
    return res.status(200).json({ logged: false });
  }
}
