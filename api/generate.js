// Vercel serverless function: POST /api/generate
//
// This is the ONE piece of backend Parcoura needs to run for real: it holds your
// Anthropic API key server-side (in an environment variable, never in the
// frontend code) and forwards requests to Anthropic on the browser's behalf.
//
// Setup:
//   1. Get an API key from https://console.anthropic.com
//   2. In your hosting provider (e.g. Vercel), set an environment variable:
//        ANTHROPIC_API_KEY = sk-ant-...
//   3. Deploy. The frontend already calls this route automatically
//      (see callClaude() in public/index.html).
//
// This file uses the Vercel serverless function format (a default-exported
// handler). If you deploy elsewhere (Netlify Functions, Cloudflare Workers,
// a plain Node/Express server), the logic below is the same — only the
// request/response wrapper syntax changes.

import admin from 'firebase-admin';
import { initAdmin, accessFor, monthKey, verifyRequestUser } from './_plans.js';

// Only a signed-in user may spend the Anthropic key, and job analyses are counted against the
// user's plan (X-Usage-Kind: analysis). A failed upstream call gives the analysis back.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server misconfigured: ANTHROPIC_API_KEY environment variable is not set.'
    });
  }
  if (!initAdmin()) {
    return res.status(500).json({
      error: 'Server misconfigured: FIREBASE_SERVICE_ACCOUNT_BASE64 is not set.'
    });
  }
  const user = await verifyRequestUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  const db = admin.firestore();
  const countsAsAnalysis = req.headers['x-usage-kind'] === 'analysis';
  const counterRef = db.collection('usageCounters').doc(user.uid);
  const month = monthKey();
  let tier = 'free';
  let cap = 0;
  let used = 0;

  try {
    const userSnap = await db.collection('users').doc(user.uid).get();
    const access = accessFor(userSnap.exists ? userSnap.data() : {});
    tier = access.tier;
    cap = access.cap; // null = unlimited
    if (countsAsAnalysis) {
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(counterRef);
        const d = snap.exists ? snap.data() : {};
        const current = d.month === month ? (d.analyses || 0) : 0;
        if (cap !== null && current >= cap) return { ok: false, current };
        tx.set(counterRef, { month, analyses: current + 1 }, { merge: true });
        return { ok: true, current: current + 1 };
      });
      used = result.current;
      if (!result.ok) {
        return res.status(402).json({ error: { type: 'plan_limit', message: 'plan_limit', tier, cap, used } });
      }
    }
  } catch (e) {
    return res.status(500).json({ error: 'Could not check your plan: ' + e.message });
  }

  const refund = async () => {
    if (!countsAsAnalysis) return;
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(counterRef);
        const d = snap.exists ? snap.data() : {};
        if (d.month === month && (d.analyses || 0) > 0) tx.set(counterRef, { analyses: d.analyses - 1 }, { merge: true });
      });
    } catch (e) { /* best effort */ }
  };

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await anthropicRes.json();
    if (!anthropicRes.ok) await refund();
    if (countsAsAnalysis) {
      res.setHeader('x-usage-used', String(anthropicRes.ok ? used : Math.max(0, used - 1)));
      res.setHeader('x-usage-cap', cap === null ? 'unlimited' : String(cap));
      res.setHeader('x-usage-tier', tier);
    }
    return res.status(anthropicRes.status).json(data);
  } catch (err) {
    await refund();
    return res.status(500).json({ error: 'Upstream request failed: ' + err.message });
  }
}
