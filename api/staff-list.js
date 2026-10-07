// Vercel serverless function: GET /api/staff-list
//
// Returns the current list of staff/admin accounts. Same permission model as
// the dashboard stats endpoint — any staff or admin can view this, but only
// admins can actually create new accounts (enforced in staff-create-user.js).

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
    const staffSnap = await db.collection('users').where('role', 'in', ['staff', 'admin']).get();
    const staffList = [];
    for (const doc of staffSnap.docs) {
      let email = doc.data().email || null;
      // The Firestore profile doc doesn't always carry email (it's mainly
      // stored in Firebase Auth), so fall back to looking it up directly.
      if (!email) {
        try {
          const authUser = await admin.auth().getUser(doc.id);
          email = authUser.email;
        } catch (e) { /* user may have been deleted from Auth but not Firestore — skip */ }
      }
      staffList.push({ uid: doc.id, email, role: doc.data().role });
    }
    return res.status(200).json({ staff: staffList });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
