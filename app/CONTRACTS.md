# Build contracts

Zero dependencies. Node >= 20, ESM (`.mjs`), `node:` builtins only — no npm,
no build step. Python is **not installed on the target machine**, so nothing
may shell out to it.

Already written and stable — build against these, do not modify them:

- `app/lib/csv.mjs` — `parseCsv`, `parseCsvObjects`, `toCsv`, `escapeCell`
- `app/lib/rank.mjs` — `TIER_ORDER`, `TIER_LABEL`, `tierRank`, `isLead`,
  `effectiveTier`, `rankLeads`, `countByTier`
- `app/lib/store.mjs` — runs, seen_leads, outcomes; all disk access
- `app/public/design.css` — the design system (tokens + component classes)

## Shared shapes

```js
// A lead, as stored in data/leads_<slug>.csv
Lead = {
  tier, name, phone, address, city, category, website,
  rating: number|null, reviews: number|null, maps_url, place_id,
  checked_tier, reason,
  check: SiteCheck|null,          // joined from data/checks/<slug>.json
}

// One stage-2 result
SiteCheck = {
  place_id, url, finalUrl, ok: boolean,
  tier: 'dead_site'|'very_dated'|'somewhat_dated'|'not_a_lead'|'social_only'|'free_host',
  reason: string,                 // the cold-call opener; see rules below
  signals: [{ id, label, found: boolean|null, evidence: string }],
  //   found === true  -> counted against the score
  //   found === false -> checked, not present
  //   found === null  -> could not be checked (no browser); never scored
  platform: string|null,          // 'GoDaddy Website Builder 7', 'Weebly', ...
  httpStatus: number|null, https: boolean|null, viewport: boolean|null,
  footerYear: number|null, parked: boolean, retriedWithBrowserUa: boolean,
  ms: number, checkedAt: string,  // ISO
  error: string|null,
}
```

## Reason lines are cold-call openers

Generated `reason` text must be **specific, verifiable and neutral**. The owner
may have built the site themselves.

- Good: `No mobile version, still on http so Chrome shows "Not secure", and the
  footer still reads 2013.`
- Never: "outdated design", "needs work", "ugly", "amateur", "embarrassing".

State only what was actually observed. If the visual checks did not run, the
reason must not imply a visual judgement.

## `app/lib/sitecheck.mjs`

```js
export async function checkSite(url, opts = {}) -> SiteCheck   // opts: { timeoutMs = 12000, signal }
export async function checkAll(leads, { concurrency = 4, onProgress }) -> Record<place_id, SiteCheck>
export function scoreSignals(signals) -> { tier, count }
export function buildReason(check) -> string
```

Scoring, from `references/outdated_signals.md`:
0 found → `not_a_lead` · 1–2 → `somewhat_dated` · 3+ → `very_dated` ·
unreachable → `dead_site`.

Signals to implement (`id`): `no_https`, `no_viewport`, `stale_copyright`
(footer year more than 3 years old), `broken_elements`, `untouched_template`.
Visual-only signals `not_mobile_friendly` and `dated_design_era` are always
emitted with `found: null` — there is no browser here.

Gotchas that are already known to bite, all of which must be handled:
- Some hosts reject curl-ish user agents but accept a normal browser UA.
  Retry once with a browser UA before calling a site dead; record
  `retriedWithBrowserUa`.
- A parked domain often returns **HTTP 200 with a tiny body** that JS-redirects
  to `/lander`. Check body length and parking markers, not just status.
- `http://` that 301s to `https://` and then fails the TLS handshake is
  `dead_site` — unreachable in a real browser.

## `app/lib/apify.mjs`

Port of `scripts/find_businesses.py` — keep `SOCIAL_HOSTS`, `FREE_HOSTS`,
`classify()` and the tier semantics byte-identical in behaviour.

```js
export function classify(website) -> 'no_website'|'social_only'|'free_host'|'needs_check'
export function hostOf(url) -> string
export async function search({ niche, location, max, token, onProgress, signal })
  -> { leads: Lead[], runId, datasetId, raw: number }
export const USD_PER_PLACE = 0.0015
```

Start the actor async and poll (never `run-sync-get-dataset-items`; it hard-fails
at 300s). Map errors the way the Python does: 401 → bad token, 402 → out of
credit. `onProgress(msg)` streams human-readable log lines.

## `app/lib/email.mjs`

```js
export function emailability(leads) -> { emailable, deadDomain, socialOnly, noWebsite, buckets }
export async function findAddresses(leads, { concurrency = 4, onProgress })
  -> Record<place_id, { emails: string[], source: string|null, error: string|null }>
export function draftOpener(lead) -> { subject, body }   // body uses [YOUR NAME] etc.
export async function pushToInstantly({ apiKey, campaignId, leads }) -> {...}
```

`pushToInstantly` must **not** invent an API shape. No Instantly key is
available in this session, so the request/response shape cannot be observed.
Implement it against the documented v2 endpoint, keep it behind an explicit
config, and have it fail loudly with a clear message when unconfigured —
never silently pretend to send.

Bracketed placeholders (`[YOUR NAME]`, `[YOUR PHONE]`, `[YOUR BUSINESS ADDRESS]`)
stay bracketed. Never fabricate a real address, price or contact.

## HTTP API (`app/server.mjs`)

Serves `app/public/` statically and this JSON API. All responses
`{ ok: true, ...data }` or `{ ok: false, error: string }` with a real status code.

```
GET  /api/state                      -> { runs, activeRun, statuses, config }
GET  /api/runs                       -> { runs }
GET  /api/runs/:slug                 -> { meta, leads, counts }
POST /api/search   {niche,location,max,includeSeen}   -> SSE progress, then { slug }
POST /api/check/:slug                                  -> SSE progress, then { checks }
POST /api/outcome  {place_id,status,note}              -> { status }
GET  /api/history                    -> { rows }   // seen_leads joined with outcomes
GET  /api/email/:slug                -> { emailability, drafts }
POST /api/email/:slug/scan                             -> SSE progress, then { addresses }
GET  /api/config                     -> { apifyToken: bool, instantly: bool }
```

Long jobs (`search`, `check`, `scan`) stream `text/event-stream` with
`event: log | progress | done | error`. Bind to `127.0.0.1` only.

## Frontend

Vanilla ES modules, no framework, no build. `app/public/index.html` and
`app/public/app.js` (the shell + hash router) already exist. Each view is
`app/public/views/<name>.js`:

```js
export const meta = { title: 'Call list' };
export function render(root, ctx) { /* ... */ }   // ctx: { api, state, navigate, toast, refresh }
export function destroy() {}                       // optional: clear timers/listeners
```

Build DOM with `document.createElement` / helper `h()` from `app/public/dom.js`.
**Never** interpolate lead data into `innerHTML` — business names come from a
third-party API and are untrusted; set text via `textContent`.

Use the classes in `design.css`. Match the corresponding artboard in `design/`
(`Search`, `Checking`, `Main` = call list, `SiteCheck`, `CallMode`, `History`,
`Runs`, `Email`) — same type scale, spacing, tier ramp and copy tone. Read the
artboard before writing the view.
