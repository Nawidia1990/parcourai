// GET /api/staff-users?pageToken=  : every app account (100 per page) with plan, status and contact info.
import { requireStaff, admin } from '../_staffauth.js';

export default async function handler(req, res) {
  const ctx = await requireStaff(req, res); if (!ctx) return;
  try {
    const page = await admin.auth().listUsers(100, req.query.pageToken ? String(req.query.pageToken) : undefined);
    const refs = page.users.map((u) => ctx.db.collection('users').doc(u.uid));
    const docs = refs.length ? await ctx.db.getAll(...refs) : [];
    const rows = page.users.map((u, i) => {
      const d = docs[i].exists ? docs[i].data() : {};
      return {
        uid: u.uid, email: u.email || '', name: d.crm?.name || d.name || u.displayName || '', createdAt: u.metadata.creationTime,
        lastSignInAt: u.metadata.lastSignInTime || null, disabled: u.disabled, role: d.role || 'customer', comped: d.comped === true,
        grant: d.grant ? d.grant.plan : null, plan: d.subscription?.plan || null, status: d.subscription?.status || null,
        phone: d.crm?.phone || d.phone || '', company: d.crm?.company || '', tags: d.crm?.tags || []
      };
    });
    return res.status(200).json({ users: rows, nextPageToken: page.pageToken || null });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
