> **START HERE (Windows):** unzip this folder anywhere, open it, double-click `setup.cmd` and follow the prompts.
> Nothing from an older version needs to be copied or replaced. Answer **Y** to GitHub and Vercel to put this
> version on your live site. After deploying, the app's sidebar shows a **Dashboard** item and a **Build** line.

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
| JSearch (aggregates Google for Jobs, incl. listings from LinkedIn/Indeed/Glassdoor) | `JSEARCH_API_KEY` + `JSEARCH_PROVIDER=rapidapi` when the key comes from RapidAPI (optional: `JSEARCH_API_URL`, `JSEARCH_AUTH_HEADER`) | RapidAPI (https://rapidapi.com/search/jsearch) or OpenWeb Ninja |

**How to connect them, step by step**

1. **Adzuna** - register at https://developer.adzuna.com/signup (name, email, organisation, intended use) and copy the
   application ID and key into `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`. Covers Canada.
2. **Jooble** - fill in the form at https://jooble.org/api/about; Jooble sends the key, which goes in `JOOBLE_API_KEY`.
3. **JSearch** - easiest: create a free RapidAPI account (https://rapidapi.com), open the JSearch listing, subscribe to the free plan, copy the X-RapidAPI-Key into `JSEARCH_API_KEY` and set `JSEARCH_PROVIDER=rapidapi`. Alternative: the OpenWeb Ninja portal (https://www.openwebninja.com, some antivirus blocks it), subscribe to a
   JSearch plan (a free plan is offered) and put the key in `JSEARCH_API_KEY`. This is what can bring in listings that
   originate on LinkedIn, Indeed and Glassdoor. If a search shows a JSearch error, set `JSEARCH_API_URL` to the exact search
   URL shown in the portal.
4. **Save the keys** - on your computer run `setup.cmd` and paste each key. For the live site, add the same names in Vercel
   (Project, Settings, Environment Variables, Production) and redeploy, or run `setup.cmd vercel` and answer Y to upload them.
5. Reload the app. The chips at the top of the Job Sites & Agencies search turn from "not configured" to green.

Remote listings limited to other countries ("USA only", "Europe", ...) are hidden from your search, and the card says how
many were hidden. Arbeitnow (mostly Europe) is only searched for European countries.

**Remote-job boards (no key needed, always on):** Remotive, Remote OK, Jobicy, Himalayas,
We Work Remotely (public RSS) and Arbeitnow (remote listings only). Each one requires that
you link back to the original listing and name the source — the search card does both.
Results are cached on the server (Remotive asks integrators to call it only a few times a
day). Remote listings carry a free-text "who can apply" restriction (e.g. "USA Only"); the
card flags ones that look closed to the selected country, using a heuristic.

**Filters.** Under the results, a Filters panel narrows what is shown: platform (LinkedIn, Indeed, Glassdoor, Jobillico, Randstad, Job Bank and any other site the listings come from or can be applied on), job type, minimum yearly salary (hourly, weekly and monthly pay are converted), posted date, words to include or exclude, company, hiding jobs already in Applications, and sorting. Salary, posted date and job type are also sent to Adzuna, Jooble and JSearch when you search again.

**Details and applying.** Each search result can be opened to show everything the source returns: company, location, job
type, salary, posted date, responsibilities/qualifications/benefits (JSearch), the full description, every site the job can
be applied on, and the company's entry from your Companies directory. **Apply** opens the real application page in a new
tab, then asks you to confirm; on "Yes, I applied" the job is tracked in Applications (stage Applied, today's date) and
counts in the Dashboard. No job site offers a public way for another app to submit an application for you, so nothing is
submitted automatically. Randstad has no public API either, so it only has a search link.

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

Run one step later with `setup.cmd github`, `setup.cmd vercel`, `setup.cmd dev` or `setup.cmd pull` (copies every variable already stored in Vercel into `.env.local`; "sensitive" ones come back empty). Keys are visible while you type.

## Local testing before you deploy

```
npx vercel dev
```

This runs the static site and the serverless function together on `localhost`,
so you can test the whole flow (including AI calls) before pushing live.

## Subscription plans

Three tiers (USD), each billed monthly or annually (annual = 10 x monthly, two months free), all with a 7-day free trial:

| Plan | Monthly | Annual | Job analyses per month | Sections |
|---|---|---|---|---|
| Essential | $15.99 | $159.90 | 25 | Dashboard, Background, Job Analyzer, Applications |
| Pro | $25.99 | $259.90 | 45 | Essential + Self-Discovery, Skills, Strategy, Interview Prep, AI Assistant, Continuous Improvement, Saved Accounts |
| Premium | $35.99 | $359.90 | 65 | Pro + Job Sites, Social Media, Languages, Companies, Platform integrations, My documents |

People without a subscription use the Essential sections with 3 analyses a month (`FREE_ANALYSES` / `TIER_CAPS.free`). Comped and staff accounts get Premium. Subscribers from before the tiers existed keep full access.

Limits are enforced on the server: `/api/generate` now requires a signed-in user and counts job analyses per month in the Firestore collection `usageCounters` (a failed generation is given back). `/api/usage` returns the counter for the sidebar. Tier caps live in `api/_plans.js` and `TIERS` in `public/index.html`; keep them in step.

In Stripe, create six recurring USD Prices on the Parcourai Pro product and paste their IDs into Vercel: `STRIPE_PRICE_ESSENTIAL_MONTHLY`, `STRIPE_PRICE_ESSENTIAL_ANNUAL`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_ANNUAL`, `STRIPE_PRICE_PREMIUM_MONTHLY`, `STRIPE_PRICE_PREMIUM_ANNUAL`. Then redeploy. A person with a live subscription cannot start a second checkout; plan changes go through support for now.


## Free access and grants

- The owner/staff accounts (`role` = `admin` or `staff`) and anyone with `comped: true` have Premium with **unlimited** analyses.
- In the Staff tab, look up a user by email and use **Grant free access**: choose Essential, Pro or Premium and either a monthly number of analyses or Unlimited. It is stored in `users/{uid}.grant` and is enforced by the server. **Remove grant** reverses it.
- Keep Firestore rules from letting users write their own `role`, `comped` or `grant` fields.

## My account, staff area and billing tools

- **My account** (sidebar): name, email, change password/email, plan and usage, renewal or trial date, invoices, cancel or keep the subscription, a link to the Stripe billing portal, and messages from Parcourai.
- **Staff dashboard**: sign in at `/staff-login` with the same email as your normal account. To let the owner email become an admin automatically, set `ADMIN_EMAILS` in Vercel (comma-separated) and sign in once at `/staff-login`. Alternatively set `role` to `admin` on the user document in Firestore.
- **Employees**: Staff dashboard, Manage Staff, "Create staff account" (admin only) gives a one-time setup link.
- **Customers and billing** (staff sidebar): all Stripe subscriptions, customer detail (subscriptions, payments, invoices), cancel at period end / undo (staff), cancel now and refunds including partial (admin only), and in-app messages to a customer.
- Optional email for messages: set `RESEND_API_KEY` and `RESEND_FROM` (Resend.com) in Vercel.
- Turn on the Stripe **Customer portal** (Settings, Billing, Customer portal) so "Manage billing" works.
- All staff endpoints run through one function (`api/staff.js`, handlers in `api/_staff/`) to stay under the Hobby plan's 12-function limit.

## Customers and human resources (staff)

- **Add a customer** (Customers and billing): creates an account with name, phone, company, address, language, tags and notes. The customer gets a one-time link to choose their own password. Admins can also give a free plan while creating it. Customer information stays editable on each customer's page.
- **All users**: every app account with plan, status and last sign-in, searchable by email, name, company or tag.
- **Human resources** (admins only): employee records, staff logins (create, set role, disable, reset link), onboarding and offboarding checklists, time off with a vacation balance, notes and reviews, HR tasks with due dates, and a CSV download.
- HR data is stored in the Firestore collections `hr_employees` and `hr_tasks`, read and written only by the server. Keep your Firestore rules closed to clients for these collections (and do not store anything you would not want in a company database, for example government ID numbers).

## Send email from the app (Gmail / Outlook)
Users connect their own mailbox once (Recruiter email generator and Spontaneous applications) and send from the app with optional PDF CV / cover letter attached. Only the send permission is requested (`gmail.send`, `Mail.Send`); refresh tokens are AES-256-GCM encrypted in Firestore `mailAccounts/{uid}` (server-only; keep it closed in Firestore rules).
- Env vars: `MAIL_ENC_KEY`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `MS_OAUTH_CLIENT_ID/SECRET`, `APP_URL`.
- Redirect URI for both providers: `https://www.parcourai.com/api/mail`.
- Google: enable the Gmail API, consent screen scope `gmail.send`. Until Google verifies the app, only listed test users (max 100) can connect; publishing requires verification of this sensitive scope.
- Microsoft: Azure app registration, "Accounts in any organizational directory and personal Microsoft accounts", delegated `Mail.Send`, `offline_access`.
