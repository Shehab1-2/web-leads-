---
name: local-web-leads
description: Find local small-business sales leads for a web design or development business - businesses in a given area and niche that have no website, only a Facebook/Instagram page, or a visibly outdated site. Use this whenever the user asks to "find leads", "find prospects", "find clients", "who needs a website", "find businesses with bad websites", mentions prospecting or cold-calling in a city/zip for web design work, or wants a call list of local businesses to pitch a redesign to. Also use it when they ask whether a specific business's website looks outdated or worth pitching. Runs an Apify Google Maps search for candidates, then checks the real sites in the browser and returns a ranked call list with phone numbers.
---

# Local Web Leads

## What this produces and why it is shaped this way

The output is a call list: local businesses ranked by how obvious their need for
a website is, each with a phone number and a one-line reason to open the call
with. The ranking is the whole point. A cold list of businesses is worth very
little; a list where the top entry is "no website at all, 40 reviews, clearly
busy" is worth calling immediately.

The work splits into two stages because they have very different costs. Stage 1
is one API call that classifies most businesses for free - Google Maps already
knows who has no website listed, and a "website" pointing at Facebook is
detectable from the URL alone. Stage 2 opens a browser and looks at the sites
that survived stage 1, which is slow and needs a human-grade judgment call.
Doing stage 1 first is what keeps stage 2 small.

## Setup (first run only)

This skill needs outbound network access from the shell, so it must run
somewhere with real internet - Claude Code on the user's own machine. In a
cloud/sandboxed session the Apify call will fail with a network error; if that
happens, say so plainly rather than retrying or silently switching to web
search, because web-search results lack the phone numbers and website fields
this workflow depends on.

The user needs a free Apify account and its API token, set as an environment
variable:

```powershell
# Windows PowerShell - current session only
$env:APIFY_API_TOKEN = "apify_api_xxxxx"

# Windows PowerShell - persist across restarts
setx APIFY_API_TOKEN "apify_api_xxxxx"
```

```bash
# macOS / Linux
export APIFY_API_TOKEN=apify_api_xxxxx
```

The token comes from https://console.apify.com/account/integrations. Apify's
free tier includes a monthly credit that covers roughly a couple of thousand
businesses - far more than this workflow uses, since a 15-lead run costs around
two cents. There is no need to suggest a paid plan unless the user is running
very large searches.

## Before starting: get the niche and the location

Both are required and neither should be guessed:

1. **Niche** - "plumbers", "hair salons", "auto repair", "dentists". Running
   against "small businesses" generally returns a noisy, unworkable list, so if
   the user says something that broad, ask which trade they want. It is fine to
   suggest a few that tend to convert well for web work (trades, salons,
   restaurants, independent clinics) rather than asking an open question.
2. **Location** - a city, suburb, or zip. "Near me" is not resolvable; ask.

Default to 15 leads if they do not say. Ask both missing things in one message
rather than one at a time.

## Stage 1: pull and pre-classify candidates

```powershell
python scripts/find_businesses.py --niche "plumbers" --location "Austin, TX" --max 15
```

Run it from the directory where the user wants their lead files, or pass
`--out-dir`. It writes `leads_<niche>-<location>.csv` plus a matching `.json`,
and appends every business it surfaces to `seen_leads.csv` so later runs skip
them automatically.

Each business comes back in one of four tiers:

| Tier | Meaning | What it is worth |
|---|---|---|
| `no_website` | Google Maps lists no site | Strongest lead - nothing to compete with |
| `social_only` | "Website" is Facebook, Instagram, Linktree, or a Google `business.site` page | Very strong - they have an audience and nowhere to send it |
| `free_host` | Site is on a free subdomain (`*.wixsite.com`, `*.weebly.com`, ...) | Strong - almost always an untouched template |
| `needs_check` | Real domain, quality unknown | Needs stage 2 before it can be ranked |

The first three tiers are already actionable and need no browser work. Only
`needs_check` goes to stage 2.

**Handling failures.** The script fails loudly and specifically on purpose - a
missing token, a rejected token, exhausted credit, and a blocked network all
produce different messages. Relay what it actually says rather than
generalising to "something went wrong". If it returns zero places, the niche or
location probably did not match anything: confirm the spelling with the user
and suggest a broader area instead of silently retrying with different terms.
If every result was filtered as already-seen, the script writes nothing and
says so - offer a different niche or nearby town rather than re-running the
same search.

## Stage 2: look at the `needs_check` sites

Open each `needs_check` website in the browser (Claude in Chrome, or the
built-in browser) and judge it. Read `references/outdated_signals.md` before
starting - it defines what counts as outdated and how to score it, which keeps
verdicts consistent between runs instead of drifting with mood.

For each site, work through it in this order, because the cheap checks
disqualify most sites before any judgment is needed:

1. **Does it load at all?** A dead domain, a parked page, an expired-certificate
   warning, or a host error is the single strongest signal in the whole
   workflow - they already paid for a site and let it lapse. Tier it `dead_site`
   and move on without further inspection.
2. **Look at the page.** Take a screenshot rather than only reading the text, as
   the judgment here is visual: layout era, image quality, font choices, whether
   it looks like a template nobody has touched.
3. **Check the objective tells** from the reference file - HTTPS, a viewport
   meta tag, the copyright year in the footer.
4. **Narrow the window** to a phone-width viewport and confirm whether it
   actually reflows or just shrinks.

Keep this to a couple of minutes per site. This is triage to decide who is worth
a phone call, not a site audit - the detailed critique belongs in the sales
conversation, not here.

Two practical notes: the browser may ask the user to approve each new domain, so
tell them upfront that a batch of sites means a batch of prompts. And if a site
is genuinely borderline, mark it borderline rather than forcing it into a tier -
a maybe-pile the user can skim is more useful than a confident wrong call.

## Stage 3: deliver the call list

Rank strongest-first and present it as a table in chat:

1. `no_website` - nothing to compete with
2. `dead_site` - paid for a site, let it lapse
3. `social_only` - audience, no home for it
4. `free_host` - free-subdomain template
5. `very_dated` - three or more neglect signals
6. `somewhat_dated` - one or two signals
7. Modern, well-kept sites - leave these out entirely, they are not leads

Include name, phone, category, and for anything checked in stage 2, the one-line
reason it is flagged. Write the reason as something the user could say out loud
on the call: "site isn't mobile-friendly and the footer still says 2014" gives
them an opening line, while "outdated design" gives them nothing.

Then update the CSV that stage 1 wrote so the stage-2 verdicts are saved with
the rest of the row, and tell the user the file path. The CSV is what they will
actually work from while calling; the chat table is just for reading now.

Offer the reasons as a short call script only if they ask - not every user wants
one, and guessing wrong wastes their time.

## Running this repeatedly

`seen_leads.csv` accumulates every business ever surfaced, so re-running the
same search returns only genuinely new listings. It has an empty `status`
column for the user to track outcomes as they call. Do not delete or rewrite
this file; if the user wants previously-seen businesses back, pass
`--include-seen` for that run rather than clearing their history.

A search that has been mined out returns nothing new, which is expected rather
than a failure - the productive next move is a neighbouring town or an adjacent
niche, so suggest one instead of re-running with a higher `--max`.
