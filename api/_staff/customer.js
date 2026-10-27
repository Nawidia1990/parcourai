// GET /api/staff-customer?uid=<firebase uid>  or  ?customer=<cus_...>  or  ?email=<email>
// Everything about one customer: account, subscriptions, invoices, payments, messages sent.
import { requireStaff, getStripe, mapSubscription, mapInvoice, mapCharge, admin } from '../_staffauth.js';

export default async function handler(req, res) {
  const ctx = await requireStaff(req, res); if (!ctx) return;
  const { db } = ctx;
  try {
    let uid = req.query.uid ? String(req.query.uid) : null;
    let customerId = req.query.customer ? String(req.query.customer) : null;
    const email = req.query.email ? String(req.query.email).trim().toLowerCase() : null;

    if (!uid && email) {
      try { uid = (await admin.auth().getUserByEmail(email)).uid; } catch (e) { /* no app account with that email */ }
    }
    let profile = {}; let authUser = null;
    if (uid) {
      const snap = await db.collection('users').doc(uid).get();
      profile = snap.exists ? snap.data() : {};
      try { authUser = await admin.auth().getUser(uid); } catch (e) { /* ignore */ }
      if (!customerId) customerId = profile.subscription?.stripeCustomerId || null;
    }

    const out = {
      uid,
      account: authUser ? {
        email: authUser.email, name: profile.name || authUser.displayName || '', disabled: authUser.disabled,
        createdAt: authUser.metadata.creationTime, lastSignInAt: authUser.metadata.lastSignInTime || null
      } : null,
      access: { role: profile.role || 'customer', comped: profile.comped === true, grant: profile.grant || null, subscription: profile.subscription || null },
      crm: profile.crm || null,
      customer: null, subscriptions: [], invoices: [], charges: [], messages: []
    };

    const stripe = getStripe(res); if (!stripe) return;
    if (!customerId && (email || out.account?.email)) {
      const found = await stripe.customers.list({ email: email || out.account.email, limit: 1 });
      if (found.data[0]) customerId = found.data[0].id;
    }
    if (customerId) {
     try {
      const [cust, subs, invs, chs] = await Promise.all([
        stripe.customers.retrieve(customerId),
        stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 }),
        stripe.invoices.list({ customer: customerId, limit: 24 }),
        stripe.charges.list({ customer: customerId, limit: 24 })
      ]);
      out.customer = { id: cust.id, email: cust.email, name: cust.name, created: new Date(cust.created * 1000).toISOString(), balance: cust.balance, currency: cust.currency, delinquent: !!cust.delinquent };
      out.subscriptions = subs.data.map(mapSubscription);
      out.invoices = invs.data.map(mapInvoice);
      out.charges = chs.data.map(mapCharge);
     } catch (e) {
      if (!/No such customer/i.test(e.message)) throw e;
      out.stripeNote = 'The Stripe customer saved on this account (' + customerId + ') does not exist in this Stripe mode (often a leftover from sandbox testing).';
     }
    }
    if (uid) {
      const msgs = await db.collection('users').doc(uid).collection('messages').orderBy('createdAt', 'desc').limit(20).get();
      out.messages = msgs.docs.map((d) => { const m = d.data(); return { id: d.id, subject: m.subject, body: m.body, fromName: m.fromName, createdAt: m.createdAt?.toDate?.().toISOString() || null, read: !!m.read }; });
    }
    if (!out.account && !out.customer) return res.status(404).json({ error: 'No customer found.' });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
