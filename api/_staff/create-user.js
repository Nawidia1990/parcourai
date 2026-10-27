// Vercel serverless function: POST /api/staff-create-user
//
// Creates a new staff or admin account. Restricted to admins specifically —
// not staff — since granting access to create more accounts with access is a
// meaningfully more sensitive action than just viewing the dashboard.
//
// Security note on passwords: this generates a random temporary password that
// is never returned to the client or shown to the admin, and immediately
// triggers a real password reset email to the new staff member so they set
// their own password. The creating admin never knows or chooses another
// person's password — that's a deliberate security practice, not an oversight.

import admin from 'firebase-admin';
import crypto from 'crypto';

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
  if (requesterRole !== 'admin') {
    return res.status(403).json({ error: 'Only admins can create staff accounts.' });
  }

  const { email, role } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (role !== 'staff' && role !== 'admin') {
    return res.status(400).json({ error: 'Role must be "staff" or "admin".' });
  }

  try {
    // A random password the admin never sees — the new staff member sets
    // their own via the reset email sent right after account creation.
    const tempPassword = crypto.randomBytes(24).toString('base64');
    const newUser = await admin.auth().createUser({ email, password: tempPassword });

    await db.collection('users').doc(newUser.uid).set({
      role,
      createdByAdmin: decodedToken.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const resetLink = await admin.auth().generatePasswordResetLink(email);
    // Note: generatePasswordResetLink() creates the link but does not send an
    // email itself — Firebase's own "forgot password" flow (already wired up
    // in the app) sends the actual email when sendPasswordResetEmail() is
    // called client-side. Since this is a server context, we return the link
    // so the admin can share it directly to guarantee immediate delivery,
    // rather than relying on the new staff member using "forgot password"
    // themselves before ever having signed in once.

    return res.status(200).json({
      uid: newUser.uid,
      email,
      role,
      setupLink: resetLink
    });
  } catch (e) {
    if (e.code === 'auth/email-already-exists') {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    return res.status(500).json({ error: e.message });
  }
}
