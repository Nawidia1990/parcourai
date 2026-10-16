// Vercel serverless function: POST /api/create-checkout-session
//
// Called from the frontend when someone clicks "Subscribe." Creates a real
// Stripe Checkout session and returns its URL — the frontend redirects the
// browser there. Stripe's own hosted page handles the actual card entry, so
// no payment details ever touch this server or the frontend code.
//
// SECURITY: this endpoint requires a real, verified Firebase ID token — not
// just a uid/email passed in the request body, which anyone could fabricate
// and call repeatedly to test stolen cards through Stripe Checkout without
// ever having a genuine account. This is one of Stripe's own recommended
// mitigations against card testing ("require login or session validation").
// It also rate-limits how many checkout attempts one real account can make
// in a short window, since even a genuine account being used for testing
// should be slowed down rather than allowed unlimited attempts.
//
// Setup:
//   1. In Vercel, set environment variables:
//        STRIPE_SECRET_KEY = sk_test_...
//        FIREBASE_SERVICE_ACCOUNT_BASE64 = (same value used in stripe-webhook.js)
//   2. Deploy. The frontend must send the signed-in user's Firebase ID token
//      in the Authorization header: `Authorization: Bearer <idToken>`.

import Stripe from 'stripe';
import admin from 'firebase-admin';

const PARCOURAI_PRICE_ID = 'price_1U9t9ZErMhvuTP4xt1VxNmf1';
const TRIAL_PERIOD_DAYS = 7;

// Sane defaults: a genuine customer essentially never needs more than a
// couple of checkout attempts in an hour (a mistyped card, a change of mind).
// A card tester needs many attempts in quick succession — this window is
// tuned to slow that down heavily without affecting real users.
const MAX_ATTEMPTS_PER_WINDOW = 3;
const WINDOW_MINUTES = 60;

if (!admin.apps.length) {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (encoded) {
    const serviceAccount = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return res.status(500).json({
      error: 'Server misconfigured: STRIPE_SECRET_KEY environment variable is not set.'
    });
  }
  if (!admin.apps.length) {
    return res.status(500).json({
      error: 'Server misconfigured: FIREBASE_SERVICE_ACCOUNT_BASE64 is not set.'
    });
  }

  // ---- Require a real, verified session (closes the main card-testing gap) ----
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session — please sign in again.' });
  }

  // uid and email come from the VERIFIED token, never from anything the
  // client claims in the request body — the body is not trusted for identity.
  const uid = decodedToken.uid;
  const email = decodedToken.email;
  if (!email) {
    return res.status(400).json({ error: 'Account has no verified email on file.' });
  }

  // ---- Rate limit: slow down repeated attempts, even from a real account ----
  const db = admin.firestore();
  const rateLimitRef = db.collection('checkoutRateLimits').doc(uid);
  const now = Date.now();
  const windowMs = WINDOW_MINUTES * 60 * 1000;

  try {
    const shouldProceed = await db.runTransaction(async (tx) => {
      const doc = await tx.get(rateLimitRef);
      const data = doc.exists ? doc.data() : { attempts: [] };
      const recentAttempts = (data.attempts || []).filter((t) => now - t < windowMs);
      if (recentAttempts.length >= MAX_ATTEMPTS_PER_WINDOW) {
        return false;
      }
      recentAttempts.push(now);
      tx.set(rateLimitRef, { attempts: recentAttempts }, { merge: true });
      return true;
    });

    if (!shouldProceed) {
      return res.status(429).json({
        error: `Too many checkout attempts. Please wait before trying again, or contact support if this seems wrong.`
      });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Could not process request — please try again.' });
  }

  // ---- Create the actual Stripe Checkout session ----
  const stripe = new Stripe(stripeSecretKey);
  const origin = req.headers.origin || `https://${req.headers.host}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: PARCOURAI_PRICE_ID, quantity: 1 }],
      customer_email: email,
      client_reference_id: uid,
      metadata: { firebaseUid: uid },
      subscription_data: { trial_period_days: TRIAL_PERIOD_DAYS, metadata: { firebaseUid: uid } },
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancel`
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
