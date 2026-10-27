// POST /api/staff-refund  { chargeId, amount? (in cents; omit for a full refund) }   ADMIN ONLY
import { requireStaff, getStripe } from '../_staffauth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ctx = await requireStaff(req, res, { adminOnly: true }); if (!ctx) return;
  const stripe = getStripe(res); if (!stripe) return;
  const { chargeId, amount } = req.body || {};
  if (!chargeId || !String(chargeId).startsWith('ch_')) return res.status(400).json({ error: 'A charge id (ch_...) is required.' });
  const params = { charge: chargeId, reason: 'requested_by_customer', metadata: { refundedBy: ctx.user.uid } };
  if (amount !== undefined && amount !== null && amount !== '') {
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'Enter a refund amount greater than 0, or leave it empty for a full refund.' });
    params.amount = n;
  }
  try {
    const refund = await stripe.refunds.create(params);
    return res.status(200).json({ message: `Refunded ${(refund.amount / 100).toFixed(2)} ${String(refund.currency).toUpperCase()}.`, refundId: refund.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
