// Vercel serverless function: GET /api/staff-user-lookup?email=...
//
// Looks up a single user by email for the Staff dashboard's "Look up a user"
// tool — combines their Firebase Auth record (uid, disabled status, sign-in
// history) with their Firestore profile (role, comped flag, subscription
// status), since neither source alone has the full picture.

import admin from 'firebase-admin';

if (!admin.apps.length) {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (encoded) {
    const serviceAccount = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
}

// The Admin SDK's getUserByEmail() occasionally throws an internal error for
// a genuine, existing user (a known quirk, not specific to this project).
// Rather than surface that as "not found," fall back to finding the uid via
// Firestore (email is stored on most profiles) and looking that uid up
// directly instead, which reliably works.
async function lookupAuthUserByEmail(email) {
  try {
    return await admin.auth().getUserByEmail(email);
  } catch (e) {
    if (e.code === 'auth/user-not-found') return null;
    const db = admin.firestore();
    const snap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (snap.empty) throw e;
    return await admin.auth().getUser(snap.docs[0].id);
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

  const email = (req.query.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }

  try {
    const authUser = await lookupAuthUserByEmail(email);
    if (!authUser) {
      return res.status(404).json({ error: 'No account found with that email.' });
    }

    const profileSnap = await db.collection('users').doc(authUser.uid).get();
    const profile = profileSnap.exists ? profileSnap.data() : {};

    return res.status(200).json({
      uid: authUser.uid,
      email: authUser.email,
      disabled: authUser.disabled,
      createdAt: authUser.metadata.creationTime,
      lastSignInAt: authUser.metadata.lastSignInTime || null,
      role: profile.role || 'customer',
      comped: profile.comped === true,
      subscription: profile.subscription || null
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
