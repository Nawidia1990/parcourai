// Vercel serverless function: GET /api/staff-dashboard-stats
//
// Returns aggregate business metrics (user count, active subscriptions, MRR,
// signup trend) for the staff dashboard. This deliberately lives server-side
// rather than as a client-side Firestore query, since computing these numbers
// requires reading across ALL users — something normal Firestore security
// rules correctly prevent any single user from doing. This endpoint verifies
// the requester is genuinely staff before returning anything.
//
// Setup: uses the same FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable
// already configured for the Stripe webhook and checkout session functions —
// no new setup needed if those are already working.

import admin from 'firebase-admin';

if (!admin.apps.length) {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (encoded) {
    const serviceAccount = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
}

const MONTHLY_PRICE_USD = 15;

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

  // Check the requester's OWN role in Firestore — never trust a role claimed
  // by the client, only what's actually stored server-side for this uid.
  const requesterDoc = await db.collection('users').doc(decodedToken.uid).get();
  const requesterRole = requesterDoc.exists ? requesterDoc.data().role : null;
  if (requesterRole !== 'admin' && requesterRole !== 'staff') {
    return res.status(403).json({ error: 'Not authorized for staff access.' });
  }

  try {
    // Firebase Auth itself is the reliable source for total user count and
    // signup timestamps — every signed-up person has an Auth record, even if
    // their Firestore profile document is still mostly empty.
    let allAuthUsers = [];
    let pageToken;
    do {
      const result = await admin.auth().listUsers(1000, pageToken);
      allAuthUsers = allAuthUsers.concat(result.users);
      pageToken = result.pageToken;
    } while (pageToken);

    const totalUsers = allAuthUsers.length;

    // Signups grouped by day for the last 30 days, for a growth trend chart.
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const signupsByDay = {};
    allAuthUsers.forEach((u) => {
      const created = new Date(u.metadata.creationTime).getTime();
      if (created >= thirtyDaysAgo) {
        const dayKey = new Date(created).toISOString().slice(0, 10);
        signupsByDay[dayKey] = (signupsByDay[dayKey] || 0) + 1;
      }
    });

    // Subscription status lives in Firestore, not Auth, so a separate query
    // is needed for active/trialing counts and the MRR estimate.
    const usersSnap = await db.collection('users').get();
    let activeCount = 0;
    let trialingCount = 0;
    let compedCount = 0;
    usersSnap.forEach((doc) => {
      const data = doc.data();
      if (data.comped === true) compedCount++;
      else if (data.subscription?.status === 'active') activeCount++;
      else if (data.subscription?.status === 'trialing') trialingCount++;
    });

    const mrr = activeCount * MONTHLY_PRICE_USD;

    return res.status(200).json({
      totalUsers,
      activeSubscriptions: activeCount,
      trialingSubscriptions: trialingCount,
      compedUsers: compedCount,
      mrr,
      signupsByDay
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
