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

## Layout

```
scripts/find_businesses.py       stage 1
references/outdated_signals.md   the scoring rubric for stage 2
references/workflow.md           full workflow notes
data/                            raw search output + seen_leads.csv (call history)
call-lists/                      finished, ranked call lists
```

`data/seen_leads.csv` has an empty `status` column for tracking call outcomes.
Do not clear it - it is what keeps repeat searches from returning the same
businesses.
