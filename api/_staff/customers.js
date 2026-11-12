// GET /api/staff-customers?status=all|active|trialing|past_due|canceled&after=<sub id>
// Every subscription in Stripe (newest first) with its customer, 50 per page.
import { requireStaff, getStripe, mapSubscription } from '../_staffauth.js';

export default async function handler(req, res) {
  const ctx = await requireStaff(req, res); if (!ctx) return;
  const stripe = getStripe(res); if (!stripe) return;
  try {
    const status = String(req.query.status || 'all');
    const params = { limit: 50, status, expand: ['data.customer'] };
    if (req.query.after) params.starting_after = String(req.query.after);
    const list = await stripe.subscriptions.list(params);
    const rows = list.data.map(mapSubscription);
    return res.status(200).json({ subscriptions: rows, hasMore: list.has_more, last: rows.length ? rows[rows.length - 1].id : null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
