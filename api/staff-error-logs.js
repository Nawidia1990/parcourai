// Vercel serverless function: GET /api/staff-error-logs
//
// Returns the 50 most recent entries from the errorLogs collection (written
// by /api/log-error) for the Staff dashboard's error log viewer.

import admin from 'firebase-admin';

if (!admin.apps.length) {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (encoded) {
    const serviceAccount = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
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

  const db = admin.firestore();
  const requesterDoc = await db.collection('users').doc(decodedToken.uid).get();
  const requesterRole = requesterDoc.exists ? requesterDoc.data().role : null;
  if (requesterRole !== 'admin' && requesterRole !== 'staff') {
    return res.status(403).json({ error: 'Not authorized for staff access.' });
  }

  try {
    const snap = await db.collection('errorLogs').orderBy('createdAt', 'desc').limit(50).get();
    const logs = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        message: data.message,
        stack: data.stack,
        url: data.url,
        uid: data.uid,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
      };
    });
    return res.status(200).json({ logs });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
