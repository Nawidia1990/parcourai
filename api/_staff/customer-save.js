// POST /api/staff-customer-save  { uid, name, phone, company, address, language, notes, tags }
// Updates the customer-information record (staff notes), not the customer's own CV profile.
import { requireStaff, cleanStr, cleanTags } from '../_staffauth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ctx = await requireStaff(req, res); if (!ctx) return;
  const b = req.body || {};
  if (!b.uid) return res.status(400).json({ error: 'uid is required.' });
  const crm = {
    name: cleanStr(b.name, 120), phone: cleanStr(b.phone, 40), company: cleanStr(b.company, 120), address: cleanStr(b.address, 300),
    language: b.language === 'fr' ? 'fr' : 'en', notes: cleanStr(b.notes, 4000), tags: cleanTags(b.tags),
    updatedBy: ctx.user.uid, updatedAt: new Date().toISOString()
  };
  try {
    await ctx.db.collection('users').doc(String(b.uid)).set({ crm }, { merge: true });
    return res.status(200).json({ message: 'Customer information saved.', crm });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
