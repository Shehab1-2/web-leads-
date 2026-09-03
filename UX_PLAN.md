# UX restructure plan

Scope: layout, hierarchy, flow only. Visual language (tokens, type, tier ramp,
component styling in `design.css`) is untouched.

## Current IA

- Shell: `app/public/app.js` — hash router, flat nav (Pipeline: New search /
  Check sites / Call list / Call mode · Records: History / Searches / Cold
  email). State fetched once at boot; nav counts go stale after outcomes.
- Views (one module each, `app/public/views/`): search (form + last-run rail),
  checking (live stage-2 progress, good primaries), calllist (ranked rows,
  filters, outcome menus, always-expanded dropped/caveat footers), sitecheck
  (per-lead detail), callmode (heads-down calling, keyboard), history, runs,
  email (buckets, scan primary, push, expanded advisory rail).
- Long jobs stream SSE into the view that started them; no indicator anywhere
  else that a job is running.
- Data flow: views ↔ `/api/*`; shell try/catch gives every view an error pane;
  views carry their own loading/empty states (audited: all 8 have loading +
  empty paths; calllist/sitecheck also have local error panes; checking has
  stream-retry).

## Problems, ranked by impact

1. No workflow spine — nothing shows where you are in search → check → call →
   follow up, or what the next action is. Nav is an unordered list.
2. Stale status — nav counts/state fetched once at boot; after calling a lead
   or finishing checks the nav lies until reload.
3. calllist has no primary action — the screen you process from offers no
   "start calling"; call mode is only discoverable in the nav.
4. Long-running work invisible outside its view — navigate away from a check
   and nothing anywhere says it is still running.
5. Always-expanded secondary content — calllist's dropped/caveat footers;
   email's advisory rail. Not needed for the current decision.
6. Nav ordering/labels don't encode the sequence (and "Cold email" hides under
   Records though it is the follow-up stage).

## Checklist

### Phase 1 — the spine
- [x] Stage model in shell: Search → Check sites → Call → Follow up, derived
      from `state.activeRun` (needsCheck/toCall).
- [x] Stage strip rendered by the shell above every pipeline view (not call
      mode — it is full-bleed heads-down with its own progress) showing
      position, per-stage counts, done ticks; stages link.
- [x] Nav rebuilt as the numbered pipeline + Records; Follow up moves into the
      pipeline; Call mode becomes a secondary link under Call list.
- [x] `state` refreshed on every navigation so counts stay true.

### Phase 2 — primary actions & disclosure
- [x] calllist: "Start calling" primary in the header (only when uncalled
      leads exist), linking to call mode.
- [x] calllist: dropped/caveat footers behind a fold, summary carries counts.
- [x] email: advisory rail panels behind one fold; scan stays sole primary.
- [x] search/checking: verified one primary each already (Run search; See the
      call list / Run the checks) — no change needed.

### Phase 3 — job visibility & states
- [x] Client-side job registry in the shell api wrapper; nav shows a running
      pill (spinner + label) while search/check/scan streams are in flight.
- [x] States audit: all 8 views have loading + empty paths; shell error pane
      covers view failures; checking/email streams have retry affordances.
      Gap found and fixed: none blocking, callmode finished-state present.

### Phase 4 — verify
- [x] `node --check` every touched file.
- [x] `render-check` 8/8 against the live server.
- [x] Walk search → check → call → follow up via the strip: every stage
      reachable, next action visible on each screen.

## Decisions

- Workflow mapping: scrape=Search, review=Check sites, process=Call list +
  Call mode, export/act=Follow up (email) and History's CSV export.
- Job indicator is client-side (shell api wrapper registry), not a backend
  jobs endpoint: no API change, dies with the tab; the server's existing
  per-run 409 guard already prevents double-starts, so the only loss is an
  indicator after a tab reload — accepted.
- New structural CSS (`.stages`, `.stage*`, `.fold`, `.nav__n`, `.nav__job`)
  added to design.css using existing tokens only; no token/color/type edits.
- Call mode intentionally has no stage strip (full-bleed screen, own progress
  bar). Records views (history/runs) have none either — they are not stages.
- `state` refresh on navigation adds one `GET /api/state` per nav; local
  server, negligible, and truthfulness of counts is worth it.
- Another session's Railway work (store/server/README/package/railway.json)
  landed mid-task; left untouched, not part of this restructure.
- search view left as-is: it already has one primary (Run search) and an idle
  "last run" card with the next-step CTA; restructuring it would be churn.
