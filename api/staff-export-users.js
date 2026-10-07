// Vercel serverless function: GET /api/staff-export-users
//
// Returns every user as a CSV file for the Staff dashboard's "Export users"
// button. Combines Auth (the reliable source for signup date, since every
// account has one) with Firestore (role/comped/subscription), the same way
// staff-dashboard-stats.js does for its aggregate numbers.

import admin from 'firebase-admin';

if (!admin.apps.length) {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (encoded) {
    const serviceAccount = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  // Quote any field containing a comma, quote, or newline, doubling internal quotes.
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
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
    let allAuthUsers = [];
    let pageToken;
    do {
      const result = await admin.auth().listUsers(1000, pageToken);
      allAuthUsers = allAuthUsers.concat(result.users);
      pageToken = result.pageToken;
    } while (pageToken);

    const usersSnap = await db.collection('users').get();
    const profilesByUid = {};
    usersSnap.forEach((doc) => { profilesByUid[doc.id] = doc.data(); });

    const rows = [['uid', 'email', 'role', 'comped', 'subscription_status', 'signed_up_at', 'last_sign_in_at', 'disabled']];
    allAuthUsers.forEach((u) => {
      const profile = profilesByUid[u.uid] || {};
      rows.push([
        u.uid,
        u.email || '',
        profile.role || 'customer',
        profile.comped === true ? 'yes' : 'no',
        profile.subscription?.status || '',
        u.metadata.creationTime,
        u.metadata.lastSignInTime || '',
        u.disabled ? 'yes' : 'no'
      ]);
    });

    const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
    const filename = `parcourai-users-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
