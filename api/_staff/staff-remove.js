// POST /api/staff-staff-remove   body: { uid, mode: 'demote' | 'delete' }   (admins only)
//   demote: removes the staff/admin role (the person keeps a normal customer account) and signs them out everywhere
//   delete: removes the Auth login and all of the account's data
// Safeguards: you cannot remove yourself, and emails listed in ADMIN_EMAILS cannot be removed from here.
import { requireStaff, admin } from '../_staffauth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ctx = await requireStaff(req, res, { adminOnly: true }); if (!ctx) return;
  const { db, user } = ctx;
  const { uid, mode } = req.body || {};
  if (!uid || !['demote', 'delete'].includes(mode)) return res.status(400).json({ error: 'uid and mode (demote | delete) are required.' });
  if (uid === user.uid) return res.status(400).json({ error: 'You cannot remove your own account.' });
  try {
    let email = '';
    try { email = (await admin.auth().getUser(uid)).email || ''; } catch (e) { /* already gone from Auth */ }
    const protectedEmails = String(process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (email && protectedEmails.includes(email.toLowerCase())) return res.status(403).json({ error: 'This email is protected by ADMIN_EMAILS.' });

    if (mode === 'demote') {
      await db.collection('users').doc(uid).set({ role: admin.firestore.FieldValue.delete(), roleRemovedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      try { await admin.auth().revokeRefreshTokens(uid); } catch (e) {}
      return res.status(200).json({ ok: true, mode });
    }
    try { await admin.auth().deleteUser(uid); } catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
    const ref = db.collection('users').doc(uid);
    if (typeof db.recursiveDelete === 'function') await db.recursiveDelete(ref); else await ref.delete();
    await Promise.all(['usageCounters', 'mailAccounts'].map((c) => db.collection(c).doc(uid).delete().catch(() => {})));
    return res.status(200).json({ ok: true, mode });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
