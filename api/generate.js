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
    return res.status(anthropicRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Upstream request failed: ' + err.message });
  }
}
