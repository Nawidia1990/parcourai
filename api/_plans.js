// Shared plan rules for the serverless functions (the leading underscore keeps Vercel
// from exposing this file as a route). Keep the caps in step with TIERS in public/index.html.
import admin from 'firebase-admin';

export const TIER_CAPS = { free: 3, essential: 25, pro: 45, premium: 65 };
export const LIVE_STATUSES = ['active', 'trialing', 'past_due'];

export function initAdmin() {
  if (!admin.apps.length) {
    const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (encoded) {
      const serviceAccount = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
  }
  return admin.apps.length > 0;
}

// Which tier a user document is entitled to.
//  - staff/admin and comped accounts get everything
//  - a live subscription gets its own plan; subscriptions made before the tiers existed
//    (plan monthly / quarterly / annual, or no plan) keep full access
//  - everyone else is on the free tier
export function tierFor(userData) {
  return accessFor(userData).tier;
}

// Full entitlement: { tier, cap } where cap is a number of analyses per month, or null = unlimited.
//  - staff/admin and comped (free access) accounts: Premium, unlimited analyses
//  - a manual grant (set from the Staff tab): the chosen plan, with either a custom monthly
//    number of analyses or unlimited
//  - otherwise the subscription's tier with that tier's cap, or the free tier
export function accessFor(userData) {
  const d = userData || {};
  if (d.comped === true || d.role === 'staff' || d.role === 'admin') return { tier: 'premium', cap: null };
  const g = d.grant;
  if (g && ['essential', 'pro', 'premium'].includes(g.plan)) {
    const n = Number(g.analyses);
    return { tier: g.plan, cap: g.unlimited === true ? null : (Number.isFinite(n) && n >= 0 ? Math.floor(n) : TIER_CAPS[g.plan]) };
  }
  const tier = subscriptionTier(d);
  return { tier, cap: TIER_CAPS[tier] };
}

function subscriptionTier(d) {
  const sub = d.subscription;
  if (sub && LIVE_STATUSES.includes(sub.status)) {
    return ['essential', 'pro', 'premium'].includes(sub.plan) ? sub.plan : 'premium';
  }
  return 'free';
}

export function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7); // UTC month, e.g. 2026-10
}

export async function verifyRequestUser(req) {
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return null;
  try { return await admin.auth().verifyIdToken(idToken); } catch (e) { return null; }
}
