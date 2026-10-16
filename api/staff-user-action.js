// Vercel serverless function: POST /api/staff-user-action
//
// Bundles the three "support tool" actions staff can take on a looked-up
// user, since they share the same auth/lookup boilerplate:
//   - sendPasswordReset:   generates a reset link (staff or admin)
//   - toggleComped:        flips free/comped access on or off (staff or admin)
//   - refundLatestPayment: refunds their most recent paid invoice (ADMIN ONLY —
//                          this moves real money and can't be undone, so it
//                          gets the same elevated permission bar as creating
//                          new staff accounts)
//
// body: { uid: string, action: 'sendPasswordReset' | 'toggleComped' | 'refundLatestPayment' }

import admin from 'firebase-admin';
import Stripe from 'stripe';

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
  if (requesterRole !== 'admin' && requesterRole !== 'staff') {
    return res.status(403).json({ error: 'Not authorized for staff access.' });
  }

  const { uid, action } = req.body || {};
  if (!uid || !action) {
    return res.status(400).json({ error: 'uid and action are required.' });
  }

  try {
    if (action === 'sendPasswordReset') {
      const authUser = await admin.auth().getUser(uid);
      const resetLink = await admin.auth().generatePasswordResetLink(authUser.email);
      return res.status(200).json({ message: `Reset link generated for ${authUser.email}.`, resetLink });
    }

    if (action === 'toggleComped') {
      const profileRef = db.collection('users').doc(uid);
      const profileSnap = await profileRef.get();
      const currentlyComped = profileSnap.exists && profileSnap.data().comped === true;
      await profileRef.set({ comped: !currentlyComped }, { merge: true });
      return res.status(200).json({ message: !currentlyComped ? 'Comped access enabled.' : 'Comped access removed.', comped: !currentlyComped });
    }

    if (action === 'refundLatestPayment') {
      // Deliberately admin-only — see file header. Staff can still view
      // billing status and take the reversible actions above.
      if (requesterRole !== 'admin') {
        return res.status(403).json({ error: 'Only admins can issue refunds.' });
      }
      const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeSecretKey) {
        return res.status(500).json({ error: 'Server misconfigured: STRIPE_SECRET_KEY is not set.' });
      }
      const profileSnap = await db.collection('users').doc(uid).get();
      const stripeCustomerId = profileSnap.exists ? profileSnap.data().subscription?.stripeCustomerId : null;
      if (!stripeCustomerId) {
        return res.status(400).json({ error: 'This user has no Stripe customer on file — nothing to refund.' });
      }
      const stripe = new Stripe(stripeSecretKey);
      const invoices = await stripe.invoices.list({ customer: stripeCustomerId, status: 'paid', limit: 1 });
      const latestInvoice = invoices.data[0];
      if (!latestInvoice || !latestInvoice.payment_intent) {
        return res.status(400).json({ error: 'No paid invoice found to refund.' });
      }
      const refund = await stripe.refunds.create({ payment_intent: latestInvoice.payment_intent });
      return res.status(200).json({ message: `Refunded $${(refund.amount / 100).toFixed(2)}.`, refundId: refund.id });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
