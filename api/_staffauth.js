// Shared helpers for the staff and account endpoints (underscore = not deployed as a route).
import admin from 'firebase-admin';
import Stripe from 'stripe';
import { initAdmin, verifyRequestUser } from './_plans.js';

// Resolves the signed-in staff member, or answers the request with an error and returns null.
export async function requireStaff(req, res, { adminOnly = false } = {}) {
  if (!initAdmin()) { res.status(500).json({ error: 'Server misconfigured: FIREBASE_SERVICE_ACCOUNT_BASE64 is not set.' }); return null; }
  const user = await verifyRequestUser(req);
  if (!user) { res.status(401).json({ error: 'Not signed in.' }); return null; }
  const db = admin.firestore();
  const snap = await db.collection('users').doc(user.uid).get();
  const role = snap.exists ? snap.data().role : null;
  if (role !== 'admin' && role !== 'staff') { res.status(403).json({ error: 'Not authorized for staff access.' }); return null; }
  if (adminOnly && role !== 'admin') { res.status(403).json({ error: 'Only admins can do this.' }); return null; }
  return { db, user, role };
}

// Resolves any signed-in user (for the customer-facing account endpoints).
export async function requireUser(req, res) {
  if (!initAdmin()) { res.status(500).json({ error: 'Server misconfigured: FIREBASE_SERVICE_ACCOUNT_BASE64 is not set.' }); return null; }
  const user = await verifyRequestUser(req);
  if (!user) { res.status(401).json({ error: 'Not signed in.' }); return null; }
  const db = admin.firestore();
  const snap = await db.collection('users').doc(user.uid).get();
  return { db, user, profile: snap.exists ? snap.data() : {} };
}

export function getStripe(res) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { res.status(500).json({ error: 'Server misconfigured: STRIPE_SECRET_KEY is not set.' }); return null; }
  return new Stripe(key);
}

const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);

// Stripe moved current_period_end onto the subscription items in newer API versions; read either.
export function periodEnd(sub) {
  return sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
}

export function mapSubscription(sub) {
  const item = sub.items?.data?.[0];
  const price = item?.price;
  const customer = typeof sub.customer === 'object' && sub.customer ? sub.customer : null;
  return {
    id: sub.id,
    status: sub.status,
    plan: sub.metadata?.plan || null,
    billing: sub.metadata?.billing || (price?.recurring?.interval === 'year' ? 'annual' : price?.recurring ? 'monthly' : null),
    amount: price?.unit_amount ?? null,
    currency: price?.currency || sub.currency || null,
    interval: price?.recurring?.interval || null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    currentPeriodEnd: iso(periodEnd(sub)),
    trialEnd: iso(sub.trial_end),
    created: iso(sub.created),
    canceledAt: iso(sub.canceled_at),
    customerId: customer ? customer.id : sub.customer,
    customerEmail: customer?.email || null,
    customerName: customer?.name || null,
    uid: sub.metadata?.firebaseUid || null
  };
}

export function mapInvoice(inv) {
  return {
    id: inv.id,
    number: inv.number || null,
    created: iso(inv.created),
    status: inv.status,
    amountDue: inv.amount_due,
    amountPaid: inv.amount_paid,
    currency: inv.currency,
    hostedUrl: inv.hosted_invoice_url || null,
    pdf: inv.invoice_pdf || null
  };
}

export function mapCharge(ch) {
  return {
    id: ch.id,
    created: iso(ch.created),
    amount: ch.amount,
    amountRefunded: ch.amount_refunded,
    currency: ch.currency,
    status: ch.status,
    paid: ch.paid,
    refunded: ch.refunded,
    description: ch.description || null,
    receiptUrl: ch.receipt_url || null,
    failure: ch.failure_message || null
  };
}

// Keep the user's Firestore copy of the subscription in step after a change made here.
export async function mirrorSubscription(db, customerId, sub) {
  const matches = await db.collection('users').where('subscription.stripeCustomerId', '==', customerId).get();
  await Promise.all(matches.docs.map((d) => d.ref.set({
    subscription: {
      status: sub.status,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      currentPeriodEnd: iso(periodEnd(sub)),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }
  }, { merge: true })));
}

export { admin };

export const cleanStr = (v, max = 300) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
export const cleanTags = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => cleanStr(x, 40)).filter(Boolean).slice(0, 20);
export const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
