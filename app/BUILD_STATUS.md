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
- [x] **Adversarial pass on `sitecheck.mjs`.** `node app/tools/sitecheck-adversarial.mjs`
      stands up a local server serving 13 nasty cases and asserts the verdict on
      each — **13/13 pass**. Covers `© 2013`, `Copyright 2011-2019` (newest year
      wins), a JS-only copyright, street/phone/zip digits that must never parse
      as a year ("1665 Stelton Rd"), redirect loops, a bot-blocker 403 before
      and after the browser-UA retry, a parked page detected by body rather than
      status, a hung server, and windows-1252 bytes. Every `buildReason` branch
      was audited: none insulting, none asserting a visual judgement the checker
      did not earn.

      **Found and fixed a real defect.** The empty-page test was
      `visibleText < 40 && no <img>` → `dead_site`, which called a healthy page
      dead. Since `dead_site` ranks second from the top, a false positive would
      have put a working business near the *front* of the call list under "your
      site doesn't load" — the worst possible opener. Now a page carrying links,
      images, media or a form counts as real however little prose it has.
      Re-verified against the 9 live domains afterwards: still 7/9, no
      regression.
- [x] **Audited `views/runs.js` and `views/email.js`.** Both render against the
      real run (94 and 166 nodes). Their agent was killed before self-verifying,
      but the code is sound.
- [x] **Loaded the UI end to end.** `node app/tools/render-check.mjs` — a
      zero-dependency headless DOM harness — mounts all **8/8 views** against
      the live server. Verified: no view throws, every `ctx.api` method a view
      calls exists and returns, all 206 class references resolve (`design.css`
      or an injected view-local `<style>`), **no `innerHTML` anywhere** (so no
      XSS route from third-party business names), and every global `window`/
      `document` listener is removed again in `destroy()` — including
      call mode's keydown handler. Rerun it any time; exit code is the result.
- [x] **Design fidelity pass.** Compared every view against its artboard. No
      colour drift: the only two values outside the shared palette
      (`#e9e3d7`, `#ddd4c4` in `runs.js`) trace straight to `Runs.dc.html`.
      The type scale is not re-declared inline — views use the `design.css`
      classes built from the artboards, so `.title`, `.lead__opener`,
      `.lead__phone` and the tier ramp are fidelity-by-construction. Accent
      discipline holds: 0–2 references per view, and the call list gets its
      accent only through `.pill--no_website` and `.lead--top`, i.e. the
      primary action and the top-ranked lead.
- [x] **`app/README.md`** — written: running it, the token on Windows, what
      works without one, where every file is written, and both checks.
- [x] **Root `README.md`** — added an "The app" section and put `app/` and
      `design/` in the layout.

## Rules that must hold

- Zero dependencies, no build step. Node only; there is no Python here.
- `data/seen_leads.csv` never loses a row. Only touch it via `store.mjs`.
- Never fabricate data. Unknowns stay bracketed placeholders or empty states.
- Reason lines are cold-call openers: specific, verifiable, never insulting.
- Do not run a live Apify search without asking — it costs credit and appends
  real businesses to call history.

## Re-check, run 2026-09-03

Approved and run. `POST /api/check/:slug` with `{"force": true}` re-checked all
9 sites and wrote fresh verdicts back into the run CSV.

- **Dina's Salon** `somewhat_dated` → `not_a_lead` — dropped. Their site is on
  HTTPS with a 2025 footer now; the old "not secure" opener was wrong.
- **Jenny's** `somewhat_dated` → `very_dated` — now 11th instead of near the
  bottom, on 205 reviews.
- 7 more reason lines rewritten by the checker at the same tier.
- The call list is 13 leads, down from 14. All 16 rows and every `place_id`
  survived; `seen_leads.csv` untouched at `4852a913a730`.

This needed a fix first: the check endpoint only ever looked at leads with no
verdict yet, so it silently found nothing to do. Verdicts go stale — Dina's is
the proof — so `force` now re-checks every lead that has a site. Without it the
endpoint says so plainly instead of reporting success over a no-op.
