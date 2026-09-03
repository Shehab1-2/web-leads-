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
