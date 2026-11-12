// POST /api/staff-bootstrap
// Lets the owner open the Staff dashboard with the same email as their normal account: if the signed-in
// account's email is listed in the ADMIN_EMAILS environment variable (comma-separated), it is made an admin.
import { initAdmin, verifyRequestUser } from '../_plans.js';
import { admin } from '../_staffauth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!initAdmin()) return res.status(500).json({ error: 'Server misconfigured: FIREBASE_SERVICE_ACCOUNT_BASE64 is not set.' });
  const user = await verifyRequestUser(req);
  if (!user || !user.email) return res.status(401).json({ error: 'Not signed in.' });
  const allowed = String(process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(user.email.toLowerCase())) return res.status(403).json({ error: 'This email is not on the admin list.' });
  await admin.firestore().collection('users').doc(user.uid).set({ role: 'admin' }, { merge: true });
  return res.status(200).json({ role: 'admin' });
}
