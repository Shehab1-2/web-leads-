# The web-leads app

A local tool for working the pipeline: run a search, check the surviving sites,
then work down a ranked call list marking outcomes as you go. It is the running
version of the eight artboards in [`../design/`](../design/).

## Running it

```powershell
node app/server.mjs
```

Then open <http://127.0.0.1:4173>. It binds to `127.0.0.1` only — this is a tool
for one person at a desk, not something to expose.

There is nothing to install. No npm, no dependencies, no build step: Node 20+
and the files in this folder are the whole thing. If port 4173 is taken it walks
up until it finds a free one and prints the URL it settled on. `PORT=5000 node
app/server.mjs` picks a specific one.

> **Note:** the original `scripts/find_businesses.py` cannot run on this machine
> — there is no Python interpreter installed. `app/lib/apify.mjs` is a faithful
> port of it, and reproduces the existing run's tiers exactly.

## The Apify token

Stage 1 needs a token from
<https://console.apify.com/account/integrations>:

```powershell
setx APIFY_API_TOKEN "apify_api_xxxxx"    # persists across restarts
```

`setx` writes to your user environment, so **restart the terminal** afterwards —
the running shell will not see it. The server prints whether it found the token
at startup, and the search screen says so plainly rather than offering a dead
button.

## What works without a token

Everything except starting a new search:

- the call list, ranked strongest-first, with outcomes
- call mode
- the site check — it fetches real sites over HTTP, no Apify involved
- call history, searches, and the cold-email screen

Cold email additionally needs `INSTANTLY_API_KEY` and `INSTANTLY_CAMPAIGN_ID`.
Without them the analysis and drafting still work; only the push is disabled.

## Where data goes

| Path | What it is |
|---|---|
| `data/leads_<slug>.csv` | one run. Stage 2 writes `checked_tier` and `reason` back into it, sorted strongest-first |
| `data/leads_<slug>.json` | the same rows as JSON |
| `data/runs/<slug>.json` | run metadata — trade, town, date, cost |
| `data/checks/<slug>.json` | per-signal detail behind each stage-2 verdict |
| `data/call_outcomes.csv` | **append-only** log of every call outcome |
| `data/seen_leads.csv` | call history. Never rewritten, only appended to; `status` is mirrored from the outcomes log |

`seen_leads.csv` is the file that stops you re-pitching someone. The only writer
that touches existing rows refuses to save if any `place_id` would be lost, so a
status update cannot drop a business. The outcomes log is the source of truth —
if the mirror ever went wrong, it can be rebuilt from that.

## Checks

Both are dependency-free and exit non-zero on failure.

```powershell
node app/tools/render-check.mjs          # needs the server running
node app/tools/sitecheck-adversarial.mjs # self-contained
```

`render-check` mounts all eight views against the live server in a minimal DOM
shim and reports anything that throws, any missing CSS class, any use of
`innerHTML`, and any global event listener a view forgets to remove.

`sitecheck-adversarial` serves 13 hostile pages from a local server — stale
copyright years, a year hidden in a street address, redirect loops, bot-blocker
403s, parked domains, a hung server, windows-1252 bytes — and asserts the
verdict on each.

## Layout

```
app/
  server.mjs            HTTP server + JSON API (SSE for long jobs)
  lib/
    csv.mjs             RFC 4180 parse/serialise
    rank.mjs            tier order — the ranking is the product
    store.mjs           every disk write, and the seen_leads safety rules
    apify.mjs           stage 1: search and pre-classify
    sitecheck.mjs       stage 2: score a real site over HTTP
    email.mjs           who email can reach, address scan, draft, Instantly
  public/               the UI — vanilla ES modules, no framework
    views/              one module per screen
  tools/                the two checks above
```
