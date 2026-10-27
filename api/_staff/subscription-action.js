// POST /api/staff-subscription-action  { subscriptionId, action: 'cancelAtPeriodEnd' | 'resume' | 'cancelNow' }
// Ending a subscription at the end of the paid period (or undoing that) is open to staff; cancelling
// immediately is admin-only because the customer loses access straight away.
import { requireStaff, getStripe, mapSubscription, mirrorSubscription } from '../_staffauth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { subscriptionId, action } = req.body || {};
  if (!subscriptionId || !action) return res.status(400).json({ error: 'subscriptionId and action are required.' });
  const ctx = await requireStaff(req, res, { adminOnly: action === 'cancelNow' }); if (!ctx) return;
  const stripe = getStripe(res); if (!stripe) return;
  try {
    let sub;
    if (action === 'cancelAtPeriodEnd') sub = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
    else if (action === 'resume') sub = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
    else if (action === 'cancelNow') sub = await stripe.subscriptions.cancel(subscriptionId);
    else return res.status(400).json({ error: 'Unknown action.' });
    await mirrorSubscription(ctx.db, sub.customer, sub);
    const messages = { cancelAtPeriodEnd: 'Subscription will end at the end of the paid period.', resume: 'Cancellation undone: the subscription continues.', cancelNow: 'Subscription cancelled immediately.' };
    return res.status(200).json({ message: messages[action], subscription: mapSubscription(sub) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
