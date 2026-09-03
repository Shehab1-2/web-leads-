# Build status

Living checklist for finishing the app. The build workflow was killed partway
by a monthly spend limit — 5 of 11 agents finished, 6 were cut off, including
all three verification passes. Everything below is what is actually left.

Update this file as items land. Commit after each one, so progress survives a
usage-limit gap.

## Done and verified

- [x] `app/lib/csv.mjs`, `rank.mjs`, `store.mjs` — foundation. Reads the real
      run: 16 rows in, 14 leads ranked, Elite Hair Styling top.
- [x] `app/lib/apify.mjs` — stage-1 port. **Verified 16/16** against the real
      run's tier column.
- [x] `app/lib/email.mjs` — buckets the real run 4 emailable / 2 dead domain /
      1 social only / 7 no website = 14.
- [x] `app/server.mjs` — boots, serves the real run. Verified: `/api/state`,
      `/api/runs/:slug`, `/api/history`, `/api/email/:slug`, static routes,
      404 on bad slug, 400 on bad body, 404 on traversal.
- [x] Outcome write path — appends to `data/call_outcomes.csv`, mirrors into
      `seen_leads.status`, all 16 `place_id`s preserved, quoted addresses
      intact. Test row reverted; `seen_leads.csv` is at baseline sha
      `4852a913a730`.
- [x] Pushed to `github.com/Shehab1-2/web-leads-` on `main`.

## Left to do

- [x] **Verified `sitecheck.mjs` against the 9 real domains.** Ran `checkAll`
      live: **7/9 agree** with the manual pass. Both disagreements were checked
      independently with curl and the checker is right in both:
      - **Dina's Salon** — manual said `somewhat_dated` ("still http-only").
        It now 301s http -> www -> **https** with a valid cert, viewport present,
        footer reads **2025**. Checker says `not_a_lead`. The stored opener is
        factually wrong today and would end the call.
      - **Jenny's** — manual `somewhat_dated`, checker `very_dated` on 3 real
        signals (2017 footer, 404 captcha image, raw-domain tab title). 3+ signals
        is `very_dated` by the rubric, so the checker is rubric-correct. The
        garbled apostrophes the manual pass saw are gone (0 mojibake markers now).
- [ ] **Adversarial pass on `sitecheck.mjs`.** Scoring boundaries hold (already
      spot-checked), but untested: 403 from a bot-blocker after the browser-UA
      retry, redirect loops, self-signed certs, `stale_copyright` against real
      footers (`© 2013`, `Copyright 2011-2019`, a year inside an address like
      "1665 Stelton Rd"), windows-1252 pages. Check every `buildReason` branch
      is specific, neutral and never asserts a visual judgement.
- [ ] **Audit `views/runs.js` and `views/email.js`.** Their agent was killed
      mid-work. Both parse, but neither was self-verified.
- [ ] **Load the UI end to end.** No view has ever rendered in a browser.
      Confirm every view mounts against the real run, every `ctx.api` call
      resolves, and `destroy()` removes the call-mode key handlers.
- [ ] **Design fidelity pass** — each view against its artboard in `design/`:
      type scale, tier ramp, accent reserved for the primary action and the
      top lead, lead-row weight order (opener is the hero).
- [ ] **`app/README.md`** — what it is, `node app/server.mjs`, setting
      `APIFY_API_TOKEN` on Windows, what works without a token, where data is
      written.
- [ ] **Root `README.md`** — add a line pointing at the app.

## Rules that must hold

- Zero dependencies, no build step. Node only; there is no Python here.
- `data/seen_leads.csv` never loses a row. Only touch it via `store.mjs`.
- Never fabricate data. Unknowns stay bracketed placeholders or empty states.
- Reason lines are cold-call openers: specific, verifiable, never insulting.
- Do not run a live Apify search without asking — it costs credit and appends
  real businesses to call history.

## Open decision for you

The live check disagrees with two stored verdicts (above). Re-running the check
from the UI would rewrite `checked_tier` and `reason` in the run CSV — dropping
Dina's off the call list and promoting Jenny's to `very_dated`. That is a real
change to a list you may be working from, so it is left for you to trigger
rather than done silently.
