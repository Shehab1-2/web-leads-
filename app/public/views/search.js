// Stage 1 — pull one trade in one town from Google Maps and sort every
// business by what it has online. Layout follows design/Search.dc.html.
//
// Nothing on this screen invents a number: the cost estimate is max ×
// USD_PER_PLACE, the log is exactly what the server streamed, and the tier
// breakdown is counted from the run CSV that came back.

import { h, clear, icon, fmtDate, plural } from '../dom.js';

export const meta = { title: 'New search' };

// Mirrors USD_PER_PLACE in app/lib/apify.mjs. The lib/ modules are node-side
// and are not served to the browser, so the number is repeated, not imported.
const USD_PER_PLACE = 0.0015;

const MIN_RESULTS = 5;
const MAX_RESULTS = 200;
const STEP = 5;

// Mirrors the stage-1 half of TIER_LABEL in app/lib/rank.mjs, with the wording
// used on the artboard.
const STAGE1_ROWS = [
  { tier: 'no_website', label: 'No website at all', strong: true },
  { tier: 'social_only', label: 'Social page only' },
  { tier: 'free_host', label: 'Free host' },
  { tier: 'needs_check', label: 'Real domain — needs the site check' },
];

// One live render at a time. destroy() marks it dead so a stream that is still
// draining cannot write into a detached DOM.
let session = null;

export function destroy() {
  if (session) session.dead = true;
  session = null;
}

export async function render(root, ctx) {
  const s = { dead: false, running: false };
  session = s;

  const config = ctx.state && ctx.state.config ? ctx.state.config : {};
  const tokenMissing = config.apifyToken === false;

  const form = { max: 20, skipSeen: true };

  // ------------------------------------------------------------ heading

  root.appendChild(h('div', { class: 'eyebrow', text: 'web-leads  /  new search' }));
  root.appendChild(h('h1', {
    class: 'title',
    style: { marginTop: '16px' },
    text: 'Who needs a website?',
  }));
  root.appendChild(h('p', {
    class: 'subtitle',
    style: { maxWidth: '520px', lineHeight: '1.6', fontSize: '14.5px' },
    text: 'Pull one trade in one town from Google Maps, then sort every business by what it has online.',
  }));

  const columns = h('div', {
    style: { display: 'flex', gap: '96px', marginTop: '52px', flexWrap: 'wrap', alignItems: 'flex-start' },
  });
  root.appendChild(columns);

  // --------------------------------------------------------- left: form

  const nicheInput = h('input', {
    class: 'field',
    id: 'search-niche',
    type: 'text',
    placeholder: 'hair salons and barbershops',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const nicheErr = errorLine();

  const locInput = h('input', {
    class: 'field',
    style: { marginTop: '0', paddingRight: '44px' },
    id: 'search-location',
    type: 'text',
    placeholder: 'Piscataway, NJ',
    autocomplete: 'off',
  });
  const locErr = errorLine();

  nicheInput.addEventListener('input', () => hideError(nicheErr));
  locInput.addEventListener('input', () => hideError(locErr));

  const locWrap = h('div', { style: { position: 'relative', marginTop: '9px' } },
    locInput,
    h('span', {
      style: {
        position: 'absolute', right: '16px', top: '50%',
        transform: 'translateY(-50%)', display: 'flex', pointerEvents: 'none',
      },
    }, icon('pin', { size: 16, stroke: '#b3aa98', width: 1.7 })));

  // Max results stepper + live cost estimate.
  const stepValue = h('div', {
    class: 'stepper__value tnum',
    role: 'status',
    'aria-live': 'polite',
    text: String(form.max),
  });
  const stepDown = h('button', { type: 'button', 'aria-label': 'Fewer results' },
    icon('minus', { size: 14, stroke: '#8d8577', width: 2 }));
  const stepUp = h('button', { type: 'button', 'aria-label': 'More results' },
    icon('plus', { size: 14, stroke: '#1d1a15', width: 2 }));
  const costLine = h('div', {
    class: 'tnum',
    style: { fontSize: '15px', color: 'var(--ink)' },
  });
  stepDown.addEventListener('click', () => setMax(form.max - STEP));
  stepUp.addEventListener('click', () => setMax(form.max + STEP));

  function setMax(next) {
    form.max = Math.min(MAX_RESULTS, Math.max(MIN_RESULTS, Math.round(next / STEP) * STEP));
    stepValue.textContent = String(form.max);
    costLine.textContent = `≈ $${(form.max * USD_PER_PLACE).toFixed(2)} for this run`;
    stepDown.disabled = form.max <= MIN_RESULTS;
    stepUp.disabled = form.max >= MAX_RESULTS;
    stepDown.style.opacity = stepDown.disabled ? '0.35' : '1';
    stepUp.style.opacity = stepUp.disabled ? '0.35' : '1';
  }
  setMax(form.max);

  const maxRow = h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '24px', flexWrap: 'wrap' } },
    h('div', {},
      h('div', { class: 'label', id: 'search-max-label', text: 'Max results' }),
      h('div', { class: 'stepper', role: 'group', 'aria-labelledby': 'search-max-label' },
        stepDown, stepValue, stepUp)),
    h('div', { style: { paddingBottom: '8px' } },
      costLine,
      h('div', { class: 'hint', style: { marginTop: '4px' }, text: 'Comes out of the Apify free credit.' })));

  // Skip-seen toggle. seen_leads.csv is call history; skipping is the default
  // so a second run on the same town does not hand back the same shops.
  const seenCount = numberOr(ctx.state && ctx.state.seenCount, numberOr(ctx.state && ctx.state.historyCount, null));
  const toggle = h('button', {
    class: 'toggle',
    type: 'button',
    role: 'switch',
    'aria-pressed': 'true',
    'aria-label': 'Skip businesses I have already seen',
  });
  toggle.addEventListener('click', () => {
    form.skipSeen = !form.skipSeen;
    toggle.setAttribute('aria-pressed', String(form.skipSeen));
  });
  const toggleRow = h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '14px', paddingTop: '4px' } },
    toggle,
    h('div', {},
      h('div', { style: { fontSize: '14.5px', fontWeight: '500' }, text: 'Skip businesses I have already seen' }),
      h('div', {
        class: 'hint',
        style: { marginTop: '4px' },
        text: seenCount === null
          ? 'Checked against data/seen_leads.csv.'
          : `Checked against data/seen_leads.csv — ${plural(seenCount, 'business', 'businesses')} on file.`,
      })));

  // Submit row, or the token explanation in its place.
  const runLabel = h('span', { text: 'Run search' });
  const runIcon = h('span', { style: { display: 'flex' } },
    icon('search', { size: 16, stroke: '#fdf4ef', width: 2 }));
  const runBtn = h('button', { class: 'btn btn--primary btn--lg', type: 'submit' }, runIcon, runLabel);

  const submitRow = tokenMissing
    ? tokenNote()
    : h('div', { style: { display: 'flex', alignItems: 'center', gap: '20px', paddingTop: '6px', flexWrap: 'wrap' } },
      runBtn,
      h('div', {
        class: 'hint',
        style: { maxWidth: '220px', lineHeight: '1.55', marginTop: '0' },
        text: 'Takes about a minute. Nothing is written until it finishes.',
      }));

  const formEl = h('form', {
    style: { width: '588px', maxWidth: '100%', flexShrink: '0', display: 'flex', flexDirection: 'column', gap: '26px' },
  },
    h('div', {},
      h('label', { class: 'label', for: 'search-niche', text: 'Trade' }),
      nicheInput,
      h('div', { class: 'hint', text: 'One trade at a time. “Small businesses” returns a list nobody can work.' }),
      nicheErr),
    h('div', {},
      h('label', { class: 'label', for: 'search-location', text: 'Location' }),
      locWrap,
      locErr),
    maxRow,
    toggleRow,
    submitRow);
  columns.appendChild(formEl);

  // -------------------------------------------------- right: log + tiers

  const rightCol = h('div', { style: { flex: '1', minWidth: '320px' } });
  columns.appendChild(rightCol);

  const logEyebrow = h('div', { class: 'eyebrow' });
  const logSlot = h('div', { style: { marginTop: '12px' } });
  const breakdownSlot = h('div', { style: { marginTop: '32px' } });
  rightCol.appendChild(logEyebrow);
  rightCol.appendChild(logSlot);
  rightCol.appendChild(breakdownSlot);

  const logBox = h('div', { class: 'log' });

  function showIdleRight() {
    const last = lastRun(ctx.state);
    clear(logSlot);
    if (last) {
      logEyebrow.textContent = last.date
        ? `Last run  ·  ${fmtDate(last.date)}`
        : 'Last run';
      logSlot.appendChild(lastRunCard(last));
    } else {
      logEyebrow.textContent = 'Run log';
      logSlot.appendChild(h('div', { class: 'empty' },
        icon('list', { size: 18, stroke: '#b3aa98' }),
        h('div', { class: 'empty__title', text: 'Nothing has been searched yet' }),
        h('div', {
          class: 'empty__body',
          style: { maxWidth: '360px', margin: '7px auto 0' },
          text: 'Name a trade and a town, then run the search. Every line the run prints shows up here.',
        })));
    }
  }

  function showRunningRight() {
    logEyebrow.textContent = 'This run';
    clear(logSlot);
    clear(logBox);
    logSlot.appendChild(logBox);
    clear(breakdownSlot);
  }

  function appendLine(text, kind) {
    if (s.dead || !text) return;
    const cls = kind ? `log__${kind}` : '';
    logBox.appendChild(h('div', cls ? { class: cls } : {}, h('span', { text })));
    logBox.scrollTop = logBox.scrollHeight;
  }

  showIdleRight();

  // The stage-1 breakdown for whichever run is current. Counted from the run's
  // own CSV rather than from anything this screen remembers. Loaded without
  // blocking, so the form is usable while it arrives.
  async function loadBreakdown() {
    const last = lastRun(ctx.state);
    if (!last || !last.slug) return;
    breakdownSlot.appendChild(h('div', { class: 'eyebrow', text: 'Sorted from the Maps data' }));
    const rows = h('div', { style: { marginTop: '14px' } });
    breakdownSlot.appendChild(rows);
    for (let i = 0; i < 3; i++) {
      rows.appendChild(h('div', {
        class: 'skeleton',
        style: { height: '14px', margin: '14px 0', width: i === 2 ? '60%' : '100%' },
      }));
    }
    try {
      const data = await ctx.api.run(last.slug);
      if (s.dead || s.running) return;
      clear(rows);
      renderBreakdown(rows, breakdownSlot, data, ctx, last.slug);
    } catch (err) {
      if (s.dead) return;
      clear(rows);
      rows.appendChild(h('div', { class: 'hint', text: `Could not read that run — ${msgOf(err)}` }));
    }
  }

  // ------------------------------------------------------------ running

  formEl.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (s.running || tokenMissing) return;

    const niche = nicheInput.value.trim();
    const location = locInput.value.trim();
    let bad = null;
    if (!niche) {
      showError(nicheErr, 'Name the trade first — one trade, like “hair salons” or “roofers”.');
      bad = bad || nicheInput;
    }
    if (!location) {
      showError(locErr, 'Name the town or city, with the state or country.');
      bad = bad || locInput;
    }
    if (bad) {
      bad.focus();
      ctx.toast('A trade and a location are both required.', 'err');
      return;
    }

    s.running = true;
    setBusy(true);
    showRunningRight();
    // The client's own line: the request has been sent. Everything after this
    // is the server's log, verbatim.
    appendLine(`starting search — ${niche}, ${location}`, 'dim');

    const onMessage = (payload) => {
      const line = messageOf(payload);
      if (line) appendLine(line, kindOf(payload, line));
    };

    try {
      const done = await ctx.api.search(
        { niche, location, max: form.max, includeSeen: !form.skipSeen },
        { log: onMessage, progress: onMessage },
      );
      if (s.dead) return;
      const slug = done && done.slug;
      if (!slug) throw new Error('the search finished without naming a run');
      appendLine('done', 'ok');
      await ctx.refresh();
      if (s.dead) return;
      ctx.toast('Search finished — checking the real sites next.');
      ctx.navigate(`#/checking/${encodeURIComponent(slug)}`);
    } catch (err) {
      if (s.dead) return;
      appendLine(msgOf(err), 'err');
      ctx.toast(msgOf(err), 'err');
      s.running = false;
      setBusy(false);
    }
  });

  function setBusy(busy) {
    nicheInput.disabled = busy;
    locInput.disabled = busy;
    stepDown.disabled = busy || form.max <= MIN_RESULTS;
    stepUp.disabled = busy || form.max >= MAX_RESULTS;
    toggle.disabled = busy;
    runBtn.disabled = busy;
    clear(runIcon);
    runIcon.appendChild(busy
      ? icon('spinner', { size: 16, stroke: '#fdf4ef', width: 2.2, cls: 'spin' })
      : icon('search', { size: 16, stroke: '#fdf4ef', width: 2 }));
    runLabel.textContent = busy ? 'Searching…' : 'Run search';
  }

  loadBreakdown();
}

// --------------------------------------------------------------- pieces

function renderBreakdown(rows, slot, data, ctx, slug) {
  const leads = Array.isArray(data && data.leads) ? data.leads : [];
  if (!leads.length) {
    rows.appendChild(h('div', { class: 'hint', text: 'That run has no rows in it.' }));
    return;
  }
  // Stage-1 tiers only: this is the "straight off the Maps data" split, so it
  // reads lead.tier and ignores any stage-2 verdict written back later.
  const counts = {};
  for (const l of leads) counts[l.tier] = (counts[l.tier] || 0) + 1;

  const shown = STAGE1_ROWS.filter((r) => r.tier === 'no_website' || r.tier === 'needs_check' || counts[r.tier]);
  for (const row of shown) {
    const n = counts[row.tier] || 0;
    rows.appendChild(h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: '14px',
        padding: '11px 0', borderBottom: '1px solid var(--rule-soft)',
      },
    },
      h('span', { class: `swatch swatch--${row.tier}` }),
      h('span', {
        style: { flex: '1', fontSize: '14px', color: row.strong ? 'var(--ink)' : 'var(--ink-2)' },
        text: row.label,
      }),
      h('span', {
        class: 'tnum',
        style: { fontSize: '15px', fontWeight: '500', color: 'var(--ink)' },
        text: String(n),
      })));
  }

  // The two tiers that were empty this time, kept visible but faded so the
  // split still reads as complete.
  const quiet = STAGE1_ROWS.filter((r) => (r.tier === 'social_only' || r.tier === 'free_host') && !counts[r.tier]);
  if (quiet.length) {
    rows.appendChild(h('div', {
      style: { display: 'flex', alignItems: 'center', gap: '14px', padding: '11px 0', opacity: '0.55' },
    },
      h('span', { class: 'swatch swatch--free_host' }),
      h('span', {
        style: { flex: '1', fontSize: '14px', color: 'var(--ink-3)' },
        text: quiet.map((q) => q.label).join(' · '),
      }),
      h('span', { class: 'tnum', style: { fontSize: '15px', color: 'var(--ink-4)' }, text: '0' })));
  }

  const needsCheck = leads.filter((l) => l.tier === 'needs_check' && !l.checked_tier).length;
  const enc = encodeURIComponent(slug);
  slot.appendChild(h('div', {
    style: { marginTop: '30px', display: 'flex', alignItems: 'center', gap: '18px', flexWrap: 'wrap' },
  },
    needsCheck
      ? h('a', { class: 'btn btn--outline', href: `#/checking/${enc}` },
        h('span', { text: `Check ${needsCheck} ${needsCheck === 1 ? 'site' : 'sites'}` }),
        icon('arrowRight', { size: 15 }))
      : h('a', { class: 'btn btn--outline', href: `#/leads/${enc}` },
        h('span', { text: 'See the call list' }),
        icon('arrowRight', { size: 15 })),
    h('div', {
      class: 'hint',
      style: { maxWidth: '230px', lineHeight: '1.55', marginTop: '0' },
      text: needsCheck
        ? 'Opens each site and scores it against the outdated-signals rubric.'
        : 'Every site in that run has already been checked.',
    })));
}

function lastRunCard(run) {
  const bits = [run.niche, run.location].filter(Boolean).join(' · ');
  return h('div', { class: 'card' },
    h('div', { style: { fontSize: '14px', fontWeight: '600' }, text: bits || run.slug }),
    h('div', {
      class: 'mono',
      style: { marginTop: '8px', fontSize: '12.5px', color: 'var(--ink-3)', wordBreak: 'break-all' },
      text: `leads_${run.slug}.csv`,
    }),
    typeof run.total === 'number' || typeof run.leads === 'number'
      ? h('div', {
        style: { marginTop: '10px', fontSize: '13px', color: 'var(--ink-2)' },
        text: `${plural(numberOr(run.total, numberOr(run.leads, 0)), 'business', 'businesses')} pulled`,
      })
      : null);
}

function tokenNote() {
  return h('div', { class: 'note', style: { maxWidth: '588px' } },
    h('div', { class: 'note__title' },
      icon('alert', { size: 14, stroke: '#8a4a24', width: 2 }),
      h('span', { text: 'APIFY_API_TOKEN is not set' })),
    h('p', {
      class: 'note__body',
      text: 'Stage 1 is one Apify Google Maps call, so it needs a token. Get a free one from console.apify.com under Settings → Integrations, then set it and restart the server:',
    }),
    h('div', {
      class: 'mono',
      style: {
        marginTop: '10px', padding: '10px 12px', borderRadius: '4px',
        background: 'var(--surface)', border: '1px solid var(--warn-border)',
        fontSize: '12px', color: 'var(--ink-2)', overflowX: 'auto', whiteSpace: 'nowrap',
      },
      text: 'setx APIFY_API_TOKEN "apify_api_xxxxx"',
    }),
    h('p', {
      class: 'note__body',
      text: 'setx writes it permanently, so open a new terminal afterwards — the current one keeps the old environment. The token stays in the environment and never in the repo.',
    }));
}

function errorLine() {
  return h('div', { class: 'hint', style: { color: 'var(--accent)', display: 'none' } });
}
function showError(el, text) { el.textContent = text; el.style.display = 'block'; }
function hideError(el) { el.textContent = ''; el.style.display = 'none'; }

// ---------------------------------------------------------------- utils

/** SSE payloads arrive as objects; be forgiving about which field holds text. */
function messageOf(payload) {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') return payload;
  const v = payload.message ?? payload.line ?? payload.text ?? payload.msg;
  if (typeof v === 'string') return v;
  if (typeof payload.done === 'number' && typeof payload.total === 'number') {
    return `${payload.done} of ${payload.total}`;
  }
  return '';
}

/** Log tone: the server's own level if it sent one, otherwise the wording. */
function kindOf(payload, line) {
  const level = payload && typeof payload === 'object' ? (payload.level || payload.kind) : null;
  if (level === 'error' || level === 'err') return 'err';
  if (level === 'ok' || level === 'success') return 'ok';
  if (level === 'dim' || level === 'debug') return 'dim';
  // apify.mjs indents its detail lines, so these are not anchored to column 0.
  if (/^\s*(wrote|skipped|appended|check it here)\b/i.test(line)) return 'dim';
  if (/\b(got|succeeded|done)\b/i.test(line)) return 'ok';
  if (/\b(error|failed|refused)\b/i.test(line)) return 'err';
  return '';
}

function lastRun(state) {
  if (!state) return null;
  if (state.activeRun && state.activeRun.slug) return state.activeRun;
  if (Array.isArray(state.runs) && state.runs.length) return state.runs[0];
  return null;
}

function numberOr(v, fallback) { return typeof v === 'number' && !Number.isNaN(v) ? v : fallback; }
function msgOf(err) { return String(err && err.message ? err.message : err); }
