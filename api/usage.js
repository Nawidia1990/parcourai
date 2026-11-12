// GET /api/usage - the signed-in user's plan tier and how many job analyses they have used this month.
import admin from 'firebase-admin';
import { initAdmin, accessFor, monthKey, verifyRequestUser } from './_plans.js';

export default async function handler(req, res) {
  if (!initAdmin()) return res.status(500).json({ error: 'Server misconfigured: FIREBASE_SERVICE_ACCOUNT_BASE64 is not set.' });
  const user = await verifyRequestUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const db = admin.firestore();
    const [userSnap, usageSnap] = await Promise.all([
      db.collection('users').doc(user.uid).get(),
      db.collection('usageCounters').doc(user.uid).get()
    ]);
    const { tier, cap } = accessFor(userSnap.exists ? userSnap.data() : {});
    const u = usageSnap.exists ? usageSnap.data() : {};
    const used = u.month === monthKey() ? (u.analyses || 0) : 0;
    return res.status(200).json({ tier, cap, used }) /* cap null = unlimited */;
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
