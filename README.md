# Parcoura — deployable starting point

This is the same Parcoura app you've been using inside Claude.ai, restructured to run as a
real, independently-hosted website — and, via "Add to Home Screen," as an installable app
on phones with no app store needed.

## What's actually here

```
parcoura-web/
├── public/
│   ├── index.html          the whole app (UI + logic)
│   ├── manifest.json        makes it installable as an app (PWA)
│   ├── service-worker.js    lets it load instantly / partially offline
│   └── icons/               app icons
├── api/
│   └── generate.js          serverless function — the only real backend piece
├── package.json
├── vercel.json
└── README.md
```

## The one thing you MUST set up: the API proxy

The app calls Claude to generate CVs, cover letters, interview questions, etc. That
requires an Anthropic API key. A key can **never** live in `index.html` — anyone could
open dev tools and steal it. `api/generate.js` solves this: it's a tiny serverless
function that holds the key server-side and forwards requests on the browser's behalf.

1. Get a key at **console.anthropic.com**
2. When you deploy (see below), set an environment variable:
   ```
   ANTHROPIC_API_KEY = sk-ant-...
   ```
3. That's it — `index.html` already calls `/api/generate` automatically.

## Deploying (Vercel is the path of least resistance)

1. Push this folder to a GitHub repo.
2. Go to vercel.com → **New Project** → import that repo. Vercel auto-detects
   `api/generate.js` as a serverless function and serves `public/` as static files.
3. In **Project Settings → Environment Variables**, add `ANTHROPIC_API_KEY`.
4. Deploy. You'll get a `*.vercel.app` URL immediately.
5. **Connect your domain**: Project Settings → Domains → add your domain, then point
   your domain's DNS at Vercel (they'll show you the exact records — usually a single
   `A` or `CNAME` entry with your registrar, e.g. GoDaddy, Namecheap, Google Domains).
   This can take a few minutes to a few hours to propagate.

(Netlify Functions or Cloudflare Pages + Workers work too — same idea, different
folder conventions. Ask me if you want that version instead.)

## Live job search (optional): `api/jobs-search.js`

The **Job Sites & Agencies** page has a "Live job search" card backed by `/api/jobs-search`.
It requires a signed-in user and only queries providers whose keys you set as Vercel
environment variables (redeploy after adding them):

| Provider | Environment variables | Where to get a key |
|----------|----------------------|--------------------|
| Adzuna (supports Canada) | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | https://developer.adzuna.com/signup |
| Jooble | `JOOBLE_API_KEY` | request one at https://jooble.org/api/about |
| JSearch (aggregates Google for Jobs, incl. listings from LinkedIn/Indeed/Glassdoor) | `JSEARCH_API_KEY` (optional: `JSEARCH_API_URL`, `JSEARCH_AUTH_HEADER`, default `x-api-key`) | OpenWeb Ninja / RapidAPI |

**Remote-job boards (no key needed, always on):** Remotive, Remote OK, Jobicy, Himalayas,
We Work Remotely (public RSS) and Arbeitnow (remote listings only). Each one requires that
you link back to the original listing and name the source — the search card does both.
Results are cached on the server (Remotive asks integrators to call it only a few times a
day). Remote listings carry a free-text "who can apply" restriction (e.g. "USA Only"); the
card flags ones that look closed to the selected country, using a heuristic.

**Sites that can't be connected directly** (nothing is scraped; the search card shows
pre-filled search links to them instead):

- **LinkedIn** — no public job-search API (its job APIs are partner-only and for *posting* jobs).
- **Indeed** — Publisher search API shut down; remaining APIs are employer-side only.
- **Glassdoor** — its partner API has returned HTTP 410 Gone since August 2025.
- **Guichet-Emplois / Job Bank** — no live public API. Its XML feed is only for approved job
  boards with a Canadian Business Number; the open-data release is a monthly CSV snapshot.
- **Jobillico** — no public developer API was found.

Note: the JSearch default URL (`https://api.openwebninja.com/jsearch/search`) was not
confirmed against live provider docs — if searches return an error for JSearch, set
`JSEARCH_API_URL` to the exact search URL shown in your provider dashboard.

## Turning it into an "app"

Once it's live on your domain over HTTPS:
- **On Android/desktop Chrome**: visitors get an "Install" prompt, or can use the
  browser menu → "Install app." It then behaves like a native app — its own icon,
  its own window, no browser chrome.
- **On iPhone**: Safari → Share → "Add to Home Screen." Same result.

No app store, no review process, no separate iOS/Android codebase — this is what
`manifest.json` and `service-worker.js` are for.

## The honest limitation you should know about

Storage in this version defaults to the browser's own `localStorage` (see the shim
at the top of `index.html`). That means:
- ✅ Works immediately, zero setup, no database needed
- ✅ Data persists across visits on that one browser
- ❌ **Not shared across devices or browsers.** An account created on a laptop
  won't be visible on a phone. This is very different from real user accounts.

If you want genuine multi-device accounts (sign up on your phone, see your data on
your laptop), that requires a real database — this is a deliberate next decision,
not an oversight. Reasonable options:
- **Supabase** (Postgres + built-in auth — probably the fastest path)
- **Firebase** (if you'd rather stay in Google's ecosystem)
- A small custom backend if you want full control

That's a genuine build step — swapping the storage shim for real API calls, adding
proper auth, migrating the password/account logic server-side. **Claude Code** is
well suited to that phase: it can scaffold the database, write the new API routes,
and update `index.html` to use them, working directly in this repo.

## Windows quick start: `setup.cmd`

Double-click `setup.cmd` (or run it from Command Prompt). It walks through, skipping anything you decline:

1. checks Node.js 18+ and runs `npm install`
2. adds `.env.local`, `node_modules` and `.vercel` to `.gitignore`
3. saves your API keys to `.env.local` (every prompt can be skipped)
4. **GitHub** — `git init` if needed, commits, asks for your empty GitHub repo URL, pushes (never tracks `.env.local`)
5. **Vercel** — logs in, links the project, optionally connects the GitHub repo so each push deploys, uploads the `.env.local` keys to Production, optionally runs `vercel deploy --prod`
6. optionally starts the local dev server

Run one step later with `setup.cmd github`, `setup.cmd vercel` or `setup.cmd dev`. Keys are visible while you type.

## Local testing before you deploy

```
npx vercel dev
```

This runs the static site and the serverless function together on `localhost`,
so you can test the whole flow (including AI calls) before pushing live.
