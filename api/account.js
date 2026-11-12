// Customer-facing account endpoint: /api/account?a=<action>
//   GET  invoices   - the signed-in user's invoices
//   POST portal     - a Stripe billing-portal link (update card, see invoices, cancel)
//   POST cancel     - end the subscription at the end of the paid period
//   POST resume     - undo that cancellation
//   GET  messages   - messages from Parcourai Support
//   POST read       - mark messages as read
import { requireUser, getStripe, mapInvoice, mapSubscription, mirrorSubscription, admin } from './_staffauth.js';

export default async function handler(req, res) {
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { db, user, profile } = ctx;
  const a = String(req.query.a || '');
  const sub = profile.subscription || {};
  const msgs = db.collection('users').doc(user.uid).collection('messages');
  try {
    if (a === 'messages') {
      const snap = await msgs.orderBy('createdAt', 'desc').limit(50).get();
      const list = snap.docs.map((d) => { const m = d.data(); return { id: d.id, subject: m.subject, body: m.body, fromName: m.fromName, createdAt: m.createdAt?.toDate?.().toISOString() || null, read: !!m.read }; });
      return res.status(200).json({ messages: list, unread: list.filter((m) => !m.read).length });
    }
    if (a === 'read') {
      const snap = await msgs.where('read', '==', false).get();
      await Promise.all(snap.docs.map((d) => d.ref.update({ read: true })));
      return res.status(200).json({ ok: true });
    }
    // everything below needs a Stripe customer
    if (!sub.stripeCustomerId) return res.status(404).json({ error: 'no_billing', message: 'No billing account yet.' });
    const stripe = getStripe(res); if (!stripe) return;
    if (a === 'invoices') {
      let list;
      try { list = await stripe.invoices.list({ customer: sub.stripeCustomerId, limit: 24 }); }
      catch (e) { if (/No such customer/i.test(e.message)) return res.status(200).json({ invoices: [], subscription: null, stale: true }); throw e; }
      let current = null;
      if (sub.stripeSubscriptionId) { try { current = mapSubscription(await stripe.subscriptions.retrieve(sub.stripeSubscriptionId)); } catch (e) { /* ignore */ } }
      return res.status(200).json({ invoices: list.data.map(mapInvoice), subscription: current });
    }
    if (a === 'portal' && req.method === 'POST') {
      const origin = req.headers.origin || ('https://' + req.headers.host);
      const session = await stripe.billingPortal.sessions.create({ customer: sub.stripeCustomerId, return_url: origin });
      return res.status(200).json({ url: session.url });
    }
    if ((a === 'cancel' || a === 'resume') && req.method === 'POST') {
      if (!sub.stripeSubscriptionId) return res.status(404).json({ error: 'No subscription found.' });
      const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: a === 'cancel' });
      await mirrorSubscription(db, sub.stripeCustomerId, updated);
      return res.status(200).json({ subscription: mapSubscription(updated) });
    }
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    if (/No such (customer|subscription)/i.test(e.message)) return res.status(404).json({ error: 'no_billing', message: 'No billing record was found for this account.' });
    const msg = /portal/i.test(e.message) && /configuration/i.test(e.message)
      ? 'The billing portal is not switched on yet in Stripe (Settings, Billing, Customer portal).' : e.message;
    return res.status(500).json({ error: msg });
  }
}
