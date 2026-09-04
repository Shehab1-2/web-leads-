# web-leads

Prospecting pipeline for finding local small businesses that need a new website,
plus the call lists it produces.

## How it works

Two stages, split because they cost very different amounts.

**Stage 1 - pull and pre-classify (one API call, ~$0.03 per 20 businesses).**
`scripts/find_businesses.py` runs an Apify Google Maps search and sorts every
business into a tier from the Maps data alone:

| Tier | Meaning |
|---|---|
| `no_website` | Google Maps lists no site - strongest lead |
| `social_only` | The "website" is Facebook, Instagram, Linktree, a Square booking page, or a Google `business.site` page |
| `free_host` | Site sits on a free subdomain (`*.wixsite.com`, `*.weebly.com`, ...) |
| `needs_check` | Real domain, quality unknown - goes to stage 2 |

**Stage 2 - check the surviving sites.** Only `needs_check` rows. Open each one
and judge it against `references/outdated_signals.md`, which pins down what
counts as outdated so verdicts stay consistent between runs. Objective signals
(dead domain, no HTTPS, no viewport meta tag, stale copyright year) can be
checked over plain HTTP; design-era judgment needs a real browser and a
screenshot.

**Stage 3 - rank and write the call list.** Strongest first:
`no_website` > `dead_site` > `social_only` > `free_host` > `very_dated` >
`somewhat_dated`. Modern well-kept sites are dropped entirely - padding the list
with healthy sites is what makes people stop trusting it.

## Setup

Needs a free Apify account token from https://console.apify.com/account/integrations:

```powershell
setx APIFY_API_TOKEN "apify_api_xxxxx"    # persists across restarts
```

The free monthly credit covers a couple of thousand businesses; a 15-lead run
costs about two cents.

## Running a search

```powershell
python scripts/find_businesses.py --niche "hair salons" --location "Piscataway, NJ" --max 20 --out-dir data
```

Writes `data/leads_<niche>-<location>.csv` and `.json`, and appends everything
it surfaces to `data/seen_leads.csv` so later runs skip businesses already seen.
Pass `--include-seen` to bring those back for one run.

## The app

All three stages also run as a local tool, with the call list, call mode, call
history and a cold-email view:

```powershell
node app/server.mjs        # then open http://127.0.0.1:4173
```

Nothing to install - no dependencies and no build step. See
[`app/README.md`](app/README.md). Worth knowing: `scripts/find_businesses.py`
needs a Python interpreter, and the app does not - `app/lib/apify.mjs` is a port
of it that reproduces the same tiers. Stage 2, which used to be done by hand
each run, is real code in `app/lib/sitecheck.mjs`.

## Deploying it

The app runs unchanged on Railway. `package.json` and `railway.json` are all the
builder needs; there is still nothing to install.

It binds loopback at a desk and every interface only when it detects a platform
(`RAILWAY_ENVIRONMENT`), or when `HOST` is set. Set these in the Railway service:

| Variable | Why |
|---|---|
| `APP_PASSWORD` | **Set this.** Without it the URL is open to anyone who finds it, and the call list is phone numbers plus the ability to spend your Apify credit. Any username works at the browser prompt; only the password is checked. |
| `APIFY_API_TOKEN` | Searching is disabled until it is set |
| `DATA_DIR` | Point at a mounted volume, e.g. `/data` |
| `INSTANTLY_API_KEY`, `INSTANTLY_CAMPAIGN_ID` | Optional, for the cold-email push |

`PORT` is assigned by the platform - don't set it. `/api/health` is the health
check and is the one route that answers without the password.

**Attach a volume.** A container's disk is wiped on every redeploy, and
`data/seen_leads.csv` is call history that must not lose rows. Mount a volume,
set `DATA_DIR` to its mount path, and the first boot copies the repo's existing
data across - after that the volume is the only thing written to.

## Layout

```
app/                             the local tool (see app/README.md)
scripts/find_businesses.py       stage 1, original Python version
references/outdated_signals.md   the scoring rubric for stage 2
references/workflow.md           full workflow notes
design/                          the approved UI, as a Claude Design canvas
data/                            raw search output + seen_leads.csv (call history)
call-lists/                      finished, ranked call lists
```

`data/seen_leads.csv` has an empty `status` column for tracking call outcomes.
Do not clear it - it is what keeps repeat searches from returning the same
businesses.

## Status

### Implemented

- Stage 1 (search + pre-classify) as dependency-free Node, reproducing the
  Python's tiers 16/16; stage 2 (site checking) as real code with a 13-case
  adversarial suite; stage 3 ranking with healthy sites cut.
- The full UI: search, checking, call list (filter/search/sort/export), site
  check detail with per-lead activity trail, call mode with keyboard-first
  outcomes and notes, history, searches, cold email (bucketing, address scan,
  drafts), settings.
- Workflow spine: stage strip + numbered nav with live counts, running-job
  indicator, state refreshed per navigation.
- Persistence with hard safety rails: append-only outcomes log,
  `seen_leads.csv` writer that refuses to drop a row, atomic writes.
- Railway deployment (password gate, `DATA_DIR` volume, health check).
- Two zero-dependency checks: `app/tools/render-check.mjs` (mounts every view
  against the live server) and `app/tools/sitecheck-adversarial.mjs`.

### Scaffolded

- Settings lists them honestly: team members, webhooks, scheduled searches /
  re-checks, reporting. Surface exists, nothing behind it.
- Instantly push: implemented from their v2 docs, never verified against a
  live account; fails loudly when unconfigured.
- Demo seeding (`app/tools/seed-demo.mjs`): must only ever point at a
  throwaway `DATA_DIR`, never the repo's own `data/`.

### Recommended next

1. Run a second real search (different trade or town) — unlocks the cross-run
   comparison on Searches and makes History's filters earn their keep.
2. Scheduled re-checks with a verdict diff — stale verdicts are proven real
   (a lead fixed its TLS between check and call).
3. Verify the Instantly push against a live account before first use.
4. Address-scan → draft → push as one guided flow on the email screen.

### Technical debt

- Verdicts for visual signals are capped without a browser; checks are the
  conservative floor by design, but a headless-screenshot pass would lift it.
- The job indicator is client-side; a tab reload loses it (server 409 guard
  still prevents double-runs).
- Stage-1 live path (Apify round trip) is untested end-to-end — the token
  never reaches CI-like sessions; the classifier is verified against the
  recorded run instead.
- CSV is the database. Deliberate (grep-able, git-diffable, no deps) — but
  multi-user or thousands of rows would want SQLite.

### Architecture

`app/server.mjs` (node:http, SSE for long jobs) serves `app/public/` and a
JSON API. `app/lib/` is the domain: `apify` (stage 1), `sitecheck` (stage 2),
`rank` (the ordering that is the product), `email`, `store` (every disk
write; the only module that touches `data/`). The frontend is vanilla ES
modules — `app.js` shell (router, nav, spine) + one module per view in
`views/`, all DOM built through `dom.js`'s `h()` so third-party strings can
never become markup. `data/` is the state: one CSV+JSON per run, per-signal
detail in `checks/`, append-only `call_outcomes.csv`, and `seen_leads.csv`
as the permanent memory between searches.
