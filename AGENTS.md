# AGENTS.md

Lead-generation pipeline for a web design business. Read `README.md` for how the
two stages work and `references/outdated_signals.md` before judging any site.

## What matters here

- **The ranking is the product.** A flat list of businesses is worth very
  little; a list whose top entry is "no website at all, 186 reviews, clearly
  busy" gets called that morning. Rank strongest-first and cut healthy sites
  entirely rather than padding.
- **Reason lines are cold-call openers.** They must be specific, verifiable and
  neutral - "no mobile version and the footer still says 2013", not "outdated
  design". The owner may have built the site themselves, so never lead with an
  insult ("ugly", "amateur", "embarrassing").
- **Never guess the niche.** "Small businesses" returns an unworkable list. Ask
  for a trade and a real location before running stage 1.
- **Say what was actually checked.** If a session has no browser tool, the
  HTTP-only checks (load status, TLS, viewport meta, footer year, platform) are
  the conservative floor - report them as that, not as a full visual read.

## Conventions

- Search output lands in `data/`, finished call lists in `call-lists/` as
  `<niche>-<location>-<YYYY-MM-DD>.md`.
- Stage-2 verdicts get written back into the run's CSV as `checked_tier` and
  `reason` columns, sorted strongest-first. The CSV is what gets worked from
  while calling; the chat table is just for reading at the time.
- `data/seen_leads.csv` is append-only call history. Never rewrite or clear it.
- `APIFY_API_TOKEN` lives in the environment, never in the repo.

## Gotchas seen in practice

- Some sites sit behind mod_security and reject curl's default user agent while
  accepting a normal browser UA - retry before calling a site dead.
- A parked domain often returns HTTP 200 with a tiny body that JS-redirects to
  `/lander`. Check the body length, not just the status code.
- An `http://` URL that 301s to `https://` and then fails the TLS handshake is a
  `dead_site` - the site is unreachable in any real browser.
