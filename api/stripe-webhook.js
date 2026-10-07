// Vercel serverless function: POST /api/stripe-webhook
//
// Stripe calls this endpoint directly (not the browser) whenever a payment
// succeeds, a subscription is updated, or a subscription is canceled. This is
// the ONLY trustworthy source of truth for "has this person actually paid" —
// never take the frontend's word for it, since browser code can be tampered
// with. This function verifies the request genuinely came from Stripe, then
// writes the real subscription status into Firestore using Firebase Admin
// SDK, which bypasses normal security rules from this trusted backend context.
//
// Setup (in order — the webhook secret can only be created AFTER this is deployed):
//   1. Set environment variables in Vercel:
//        STRIPE_SECRET_KEY = sk_test_... (same one used in create-checkout-session.js)
//        FIREBASE_SERVICE_ACCOUNT_BASE64 = <see below>
//   2. Deploy this file once (the webhook secret isn't known yet — that's fine,
//      verification will just fail harmlessly until step 4).
//   3. In Stripe Dashboard → Developers → Webhooks → Add endpoint:
//        URL: https://parcourai.com/api/stripe-webhook (or your actual domain)
//        Events to send: checkout.session.completed, customer.subscription.updated,
//                         customer.subscription.deleted
//   4. Stripe shows a signing secret (starts with whsec_) — add it as another
//      Vercel environment variable: STRIPE_WEBHOOK_SECRET = whsec_...
//   5. Redeploy so the new environment variable is picked up.
//
// Getting FIREBASE_SERVICE_ACCOUNT_BASE64:
//   You already have the service account JSON file (from Firebase Console →
//   Project Settings → Service Accounts → Generate new private key). Base64-encode
//   the WHOLE file content into one line, then paste that as the env var value:
//     macOS/Linux:  base64 -i your-service-account-file.json | tr -d '\n'
//     Windows (PowerShell):  [Convert]::ToBase64String([IO.File]::ReadAllBytes("your-file.json"))
//   This avoids the newlines inside the private key field breaking a plain
//   environment variable, which is a common gotcha with this specific credential.

import Stripe from 'stripe';
import admin from 'firebase-admin';

// Vercel normally parses the request body as JSON automatically — Stripe's
// signature verification needs the EXACT raw bytes that were sent, since even
// whitespace differences would make the signature check fail. Disabling the
// built-in parser and reading the raw body manually is what makes that possible.
export const config = {
  api: { bodyParser: false }
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Firebase Admin can only be initialized once per running instance — Vercel
// may reuse the same instance across multiple requests, so this guards
// against a "already initialized" error on warm invocations.
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
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecretKey || !webhookSecret) {
    return res.status(500).json({
      error: 'Server misconfigured: STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is not set.'
    });
  }
  if (!admin.apps.length) {
    return res.status(500).json({
      error: 'Server misconfigured: FIREBASE_SERVICE_ACCOUNT_BASE64 is not set.'
    });
  }

  const stripe = new Stripe(stripeSecretKey);
  const signature = req.headers['stripe-signature'];
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    // A failed signature check means this request did NOT genuinely come from
    // Stripe — reject it rather than trusting the payload.
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  const db = admin.firestore();

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const uid = session.client_reference_id || session.metadata?.firebaseUid;
      if (uid) {
        await db.collection('users').doc(uid).set({
          subscription: {
            status: 'active',
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }
        }, { merge: true });
      }
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      // These events only carry the Stripe customer ID, not the Firebase uid
      // directly, so the matching user document is found by the customer ID
      // that was stored back when checkout.session.completed first fired.
      const matches = await db.collection('users')
        .where('subscription.stripeCustomerId', '==', subscription.customer)
        .get();
      const updates = matches.docs.map((doc) => doc.ref.set({
        subscription: {
          status: subscription.status, // 'active', 'past_due', 'canceled', etc.
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }
      }, { merge: true }));
      await Promise.all(updates);
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
