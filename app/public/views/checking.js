// Stage 2 — open every real domain in the run and score it against the
// outdated-signals rubric. Layout follows design/Checking.dc.html.
//
// Only `needs_check` rows come through here; the businesses with no website at
// all were already decided from the Maps data and skip the step. Every verdict
// on screen comes from the stream or from data/checks/<slug>.json — nothing is
// filled in optimistically.

import { h, clear, icon, prettyHost } from '../dom.js';

export const meta = { title: 'Checking sites' };

// Mirrors TIER_LABEL / TIER_ORDER in app/lib/rank.mjs. The lib/ modules are
// node-side and are not served to the browser, so they are repeated here.
const TIER_LABEL = {
  no_website: 'No website',
  dead_site: 'Dead site',
  social_only: 'Social only',
  free_host: 'Free host',
  very_dated: 'Very dated',
  somewhat_dated: 'Somewhat dated',
  needs_check: 'Needs checking',
  not_a_lead: 'Healthy site',
};
const LEAD_TIERS = ['no_website', 'dead_site', 'social_only', 'free_host', 'very_dated', 'somewhat_dated'];

// The tally down the right-hand side. free_host only appears once stage 2 has
// actually put something in it.
const TALLY_ROWS = [
  { tier: 'dead_site' },
  { tier: 'social_only' },
  { tier: 'free_host', onlyIfAny: true },
  { tier: 'very_dated' },
  { tier: 'somewhat_dated' },
];

// What the HTTP-only checker actually looks at. The two visual signals are
// emitted unchecked, which is what the note underneath says.
const CHECKS_RUN = [
  'Does it load at all',
  'HTTPS and certificate',
  'Viewport meta tag',
  'Footer copyright year',
  'Platform and builder version',
];

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

let session = null;

export function destroy() {
  if (session) {
    session.dead = true;
    if (session.timer) clearInterval(session.timer);
  }
  session = null;
}

export async function render(root, ctx) {
  const s = { dead: false, running: false, timer: null, startedAt: 0, finishedAt: 0 };
  session = s;
  const slug = ctx.slug;

  root.appendChild(h('div', { class: 'eyebrow', text: 'web-leads  /  checking sites' }));

  const headSlot = h('div', {});
  const bodySlot = h('div', { style: { marginTop: '40px' } });
  root.appendChild(headSlot);
  root.appendChild(bodySlot);

  // Loading — painted before the run is fetched, so the screen is never blank.
  headSlot.appendChild(h('h1', { class: 'title', style: { marginTop: '16px' }, text: 'Checking sites' }));
  headSlot.appendChild(h('p', { class: 'subtitle', text: slug }));
  for (let i = 0; i < 4; i++) {
    bodySlot.appendChild(h('div', {
      class: 'skeleton',
      style: { height: '15px', margin: '18px 0', width: `${[70, 52, 64, 44][i]}%` },
    }));
  }

  const data = await ctx.api.run(slug);
  if (s.dead) return;

  const runMeta = data.meta || {};
  const leads = Array.isArray(data.leads) ? data.leads : [];
  const noWebsite = leads.filter((l) => l.tier === 'no_website').length;

  const rows = leads
    .filter((l) => l.tier === 'needs_check')
    .map((lead) => {
      const prior = lead.check || (lead.checked_tier ? { tier: lead.checked_tier, reason: lead.reason || '' } : null);
      return {
        lead,
        host: hostOf(lead.website),
        display: prettyHost(lead.website) || lead.name || lead.place_id,
        check: prior,
        state: prior ? 'done' : 'queued',
        activity: '',
        note: '',
        startedAt: 0,
      };
    });
  const byPlace = new Map(rows.map((r) => [r.lead.place_id, r]));

  clear(headSlot);
  clear(bodySlot);

  // ------------------------------------------------------------ heading

  const titleEl = h('h1', { class: 'title', style: { marginTop: '0' } });
  const readout = h('div', {
    class: 'tnum',
    style: { fontSize: '13.5px', color: 'var(--ink-2)' },
  });
  const barFill = h('div', { class: 'bar__fill', style: { width: '0%' } });
  const bar = h('div', { class: 'bar', style: { width: '280px', maxWidth: '100%', marginTop: '10px' } }, barFill);
  const progressBox = h('div', { style: { textAlign: 'right', paddingBottom: '4px' } }, readout, bar);

  headSlot.appendChild(h('div', { class: 'head-row' },
    h('div', {}, titleEl, subtitleFor(runMeta, noWebsite)),
    progressBox));

  if (!rows.length) {
    titleEl.textContent = 'Nothing to check';
    progressBox.style.display = 'none';
    bodySlot.appendChild(emptyState(leads, noWebsite, slug));
    return;
  }

  // -------------------------------------------------------------- body

  const listCol = h('div', { style: { flex: '1', minWidth: '0' } });
  const sideCol = h('div', { style: { width: '300px', flexShrink: '0' } });
  bodySlot.appendChild(h('div', {
    style: { display: 'flex', gap: '72px', flexWrap: 'wrap', alignItems: 'flex-start' },
  }, listCol, sideCol));

  rows.forEach((row, i) => {
    listCol.appendChild(buildRow(row, i, rows.length));
    applyRow(row);
  });

  // Anything the stream said that could not be pinned to one site. Hidden
  // until there is something in it.
  const logBox = h('div', { class: 'log', style: { marginTop: '12px', maxHeight: '180px' } });
  const logSection = h('div', { style: { marginTop: '28px', display: 'none' } },
    h('div', { class: 'eyebrow', text: 'Run log' }), logBox);
  listCol.appendChild(logSection);

  const ctaRow = h('div', {
    style: { marginTop: '30px', display: 'none', alignItems: 'center', gap: '18px', flexWrap: 'wrap' },
  });
  listCol.appendChild(ctaRow);

  // ------------------------------------------------------------ sidebar

  const tallySlot = h('div', { style: { marginTop: '13px' } });
  sideCol.appendChild(h('div', { class: 'eyebrow', text: 'Verdicts so far' }));
  sideCol.appendChild(tallySlot);

  sideCol.appendChild(h('div', { class: 'eyebrow', style: { marginTop: '30px' }, text: 'Checks being run' }));
  sideCol.appendChild(h('div', {
    style: { marginTop: '12px', fontSize: '13px', lineHeight: '2.1', color: 'var(--ink-2)' },
  }, CHECKS_RUN.map((c) => h('div', { text: c }))));

  sideCol.appendChild(h('div', { class: 'note', style: { marginTop: '26px' } },
    h('div', { class: 'note__title' },
      icon('info', { size: 14, stroke: '#8a4a24', width: 2 }),
      h('span', { text: 'No browser in this session' })),
    h('p', {
      class: 'note__body',
      text: 'The two visual checks — mobile layout and design era — are being skipped. Verdicts will be the conservative floor, not a full read.',
    })));

  // ------------------------------------------------------------- render

  function updateHead() {
    const done = rows.filter((r) => r.state === 'done' || r.state === 'failed').length;
    const total = rows.length;
    titleEl.textContent = `${done === total ? 'Checked' : 'Checking'} ${numWord(total)} ${total === 1 ? 'site' : 'sites'}`;
    clear(readout);
    readout.appendChild(h('span', { text: `${done} of ${total} checked` }));
    const el = elapsed(s);
    if (el) readout.appendChild(h('span', { style: { color: 'var(--ink-4)' }, text: ` ·  ${el}` }));
    barFill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  }

  function updateTally() {
    const counts = {};
    for (const r of rows) if (r.check && r.check.tier) counts[r.check.tier] = (counts[r.check.tier] || 0) + 1;
    clear(tallySlot);
    const shown = TALLY_ROWS.filter((t) => !t.onlyIfAny || counts[t.tier]);
    // Every tier row is ruled; the muted "healthy" row closes the list.
    shown.forEach((t) => {
      tallySlot.appendChild(tallyRow(t.tier, TIER_LABEL[t.tier], counts[t.tier] || 0, true));
    });
    tallySlot.appendChild(tallyRow('not_a_lead', 'Healthy — dropped', counts.not_a_lead || 0, false, true));
  }

  function showCta() {
    const enc = encodeURIComponent(slug);
    const callable = callableCount(leads, byPlace);
    clear(ctaRow);
    ctaRow.style.display = 'flex';
    ctaRow.appendChild(h('a', { class: 'btn btn--primary', href: `#/leads/${enc}` },
      h('span', { text: 'See the call list' }),
      icon('arrowRight', { size: 15, stroke: '#fdf4ef' })));
    const again = h('button', { class: 'btn btn--quiet btn--sm', type: 'button', text: 'Run the checks again' });
    again.addEventListener('click', () => { ctaRow.style.display = 'none'; runChecks(true); });
    ctaRow.appendChild(again);
    ctaRow.appendChild(h('div', {
      class: 'hint',
      style: { maxWidth: '250px', lineHeight: '1.55', marginTop: '0' },
      text: callable
        ? `${callable} ${callable === 1 ? 'business is' : 'businesses are'} worth a call. Healthy sites are left out.`
        : 'Nothing in this run scored as a lead.',
    }));
  }

  // --------------------------------------------------------- the stream

  function attribute(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    const hit = rows.find((r) => r.host && lower.includes(r.host));
    if (hit) return hit;
    const inFlight = rows.filter((r) => r.state === 'checking');
    return inFlight.length === 1 ? inFlight[0] : null;
  }

  function startRow(row) {
    if (row.state === 'done') return;
    if (row.state !== 'checking') {
      row.state = 'checking';
      row.startedAt = Date.now();
      row.activity = 'Reading the homepage source…';
    }
  }

  function onLine(payload) {
    const text = messageOf(payload);
    const row = findRow(rows, byPlace, payload) || attribute(text);
    const result = checkOf(payload);

    if (row && result) {
      row.check = result;
      row.state = 'done';
      row.note = '';
      applyRow(row);
      updateHead();
      updateTally();
      return;
    }
    if (row) {
      startRow(row);
      if (text) {
        if (/retry|retrying|user[- ]agent/i.test(text)) row.note = text;
        else row.activity = text;
      }
      applyRow(row);
      updateHead();
      return;
    }
    if (text) appendLog(text);
  }

  function appendLog(text) {
    logSection.style.display = 'block';
    logBox.appendChild(h('div', { text }));
    logBox.scrollTop = logBox.scrollHeight;
  }

  async function runChecks(force) {
    if (s.running) return;
    const pending = rows.filter((r) => r.state !== 'done');
    if (!force && !pending.length) { updateHead(); updateTally(); showCta(); return; }

    s.running = true;
    s.startedAt = Date.now();
    s.finishedAt = 0;
    ctaRow.style.display = 'none';
    for (const r of rows) {
      if (force || r.state !== 'done') {
        r.state = 'queued';
        r.check = force ? null : r.check;
        r.activity = '';
        r.note = '';
        applyRow(r);
      }
    }
    updateHead();
    updateTally();
    s.timer = setInterval(() => {
      if (s.dead) return;
      updateHead();
      for (const r of rows) if (r.state === 'checking') applyRow(r);
    }, 1000);

    try {
      const done = await ctx.api.check(slug, { log: onLine, progress: onLine });
      if (s.dead) return;
      const checks = (done && done.checks) || {};
      for (const r of rows) {
        const got = checks[r.lead.place_id];
        if (got) { r.check = got; r.state = 'done'; r.note = ''; }
        else if (r.state !== 'done') { r.state = 'failed'; r.activity = 'No verdict came back for this site.'; }
        applyRow(r);
      }
      s.finishedAt = Date.now();
      s.running = false;
      stopTimer();
      updateHead();
      updateTally();
      showCta();
      await ctx.refresh();
      if (s.dead) return;
      ctx.toast(`Checked ${rows.length} ${rows.length === 1 ? 'site' : 'sites'}.`);
    } catch (err) {
      if (s.dead) return;
      s.finishedAt = Date.now();
      s.running = false;
      stopTimer();
      for (const r of rows) {
        if (r.state === 'checking' || r.state === 'queued') { r.state = 'failed'; r.activity = 'Stopped before this one was checked.'; }
        applyRow(r);
      }
      appendLog(msgOf(err));
      updateHead();
      updateTally();
      ctx.toast(msgOf(err), 'err');
      const retry = h('button', { class: 'btn btn--outline', type: 'button', text: 'Try the checks again' });
      retry.addEventListener('click', () => { ctaRow.style.display = 'none'; runChecks(true); });
      clear(ctaRow);
      ctaRow.style.display = 'flex';
      ctaRow.appendChild(retry);
    } finally {
      s.running = false;
    }
  }

  function stopTimer() {
    if (s.timer) { clearInterval(s.timer); s.timer = null; }
  }

  updateHead();
  updateTally();
  // Not awaited: render() should hand control back to the shell straight away
  // and let the rows fill in as the stream arrives.
  runChecks(false).catch((err) => { if (!s.dead) ctx.toast(msgOf(err), 'err'); });
}

// ------------------------------------------------------------- row parts

function buildRow(row, index, total) {
  const iconSlot = h('span', { style: { flexShrink: '0', display: 'flex' } });
  const title = h('div', { class: 'mono', style: { fontSize: '13.5px' }, text: row.display });
  const sub = h('div', { style: { marginTop: '4px', fontSize: '13px', lineHeight: '1.5', color: '#6b6558' } });
  const note = h('div', { style: { marginTop: '6px', fontSize: '12.5px', lineHeight: '1.5', color: 'var(--accent)' } });
  const side = h('span', { style: { flexShrink: '0', display: 'flex' } });
  const el = h('div', {
    style: {
      display: 'flex',
      gap: '15px',
      borderTop: `1px solid ${index === 0 ? 'var(--rule)' : 'var(--rule-soft)'}`,
      borderBottom: index === total - 1 ? '1px solid var(--rule)' : '',
    },
  }, iconSlot, h('div', { style: { flex: '1', minWidth: '0' } }, title, sub, note), side);
  row.el = el;
  row.refs = { iconSlot, title, sub, note, side };
  return el;
}

function applyRow(row) {
  const { iconSlot, title, sub, note, side } = row.refs;
  clear(iconSlot);
  clear(side);
  note.style.display = 'none';
  sub.style.display = 'none';

  if (row.state === 'queued') {
    Object.assign(row.el.style, { alignItems: 'center', padding: '13px 0', margin: '0', background: 'transparent' });
    iconSlot.style.marginTop = '0';
    iconSlot.appendChild(icon('circle', { size: 16, stroke: '#d5ccba', width: 2 }));
    title.style.color = 'var(--ink-5)';
    side.appendChild(h('span', { style: { fontSize: '12.5px', color: '#c4bba9' }, text: 'Queued' }));
    return;
  }

  Object.assign(row.el.style, { alignItems: 'flex-start' });
  iconSlot.style.marginTop = '3px';
  title.style.color = 'var(--ink)';

  if (row.state === 'checking') {
    Object.assign(row.el.style, { padding: '14px 18px', margin: '0 -18px', background: 'var(--tint)' });
    iconSlot.appendChild(icon('spinner', { size: 16, stroke: '#a83a1e', width: 2.2, cls: 'spin' }));
    sub.style.display = 'block';
    sub.textContent = row.activity || 'Reading the homepage source…';
    if (row.note) { note.style.display = 'block'; note.textContent = row.note; }
    side.appendChild(h('span', {
      class: 'tnum',
      style: { fontSize: '12px', color: 'var(--ink-4)', marginTop: '4px' },
      text: row.startedAt ? `${Math.max(0, Math.round((Date.now() - row.startedAt) / 1000))}s` : '',
    }));
    return;
  }

  Object.assign(row.el.style, { padding: '13px 0', margin: '0', background: 'transparent' });

  if (row.state === 'failed') {
    iconSlot.appendChild(icon('alert', { size: 16, stroke: '#a89f8e', width: 2 }));
    sub.style.display = 'block';
    sub.textContent = row.activity || 'Not checked.';
    side.appendChild(h('span', { style: { fontSize: '12.5px', color: '#c4bba9', marginTop: '2px' }, text: 'Not checked' }));
    return;
  }

  // done
  iconSlot.appendChild(icon('check', { size: 16, stroke: '#1d1a15', width: 2.4 }));
  const tier = row.check && row.check.tier ? row.check.tier : 'needs_check';
  const reason = row.check && row.check.reason ? row.check.reason : '';
  if (reason) { sub.style.display = 'block'; sub.textContent = reason; }
  side.appendChild(h('span', {
    class: `pill pill--${tier}`,
    style: { marginTop: '1px' },
    text: TIER_LABEL[tier] || tier,
  }));
}

function tallyRow(tier, label, count, ruled, muted) {
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: '12px', padding: '9px 0',
      borderBottom: ruled ? '1px solid var(--rule-soft)' : '',
    },
  },
    h('span', { class: `swatch swatch--${tier}` }),
    h('span', { style: { flex: '1', fontSize: '13.5px', color: muted ? 'var(--ink-4)' : 'var(--ink-2)' }, text: label }),
    h('span', {
      class: 'tnum',
      style: { fontSize: '14px', fontWeight: muted ? '400' : '500', color: muted ? 'var(--ink-4)' : 'var(--ink)' },
      text: String(count),
    }));
}

// ---------------------------------------------------------------- pieces

function subtitleFor(runMeta, noWebsite) {
  const parts = [];
  if (runMeta.niche) parts.push(capitalize(runMeta.niche));
  if (runMeta.location) parts.push(runMeta.location);
  if (noWebsite) parts.push(`the ${numWord(noWebsite)} with no website skip this step`);
  const out = h('div', { class: 'subtitle' });
  parts.forEach((p, i) => {
    if (i) out.appendChild(h('span', { class: 'dot-sep', text: ' · ' }));
    out.appendChild(h('span', { text: p }));
  });
  return out;
}

function emptyState(leads, noWebsite, slug) {
  const other = leads.filter((l) => l.tier === 'social_only' || l.tier === 'free_host').length;
  let body;
  if (!leads.length) {
    body = 'That run has no businesses in it, so there is nothing to open.';
  } else {
    const bits = [];
    if (noWebsite) bits.push(`${noWebsite} with no website at all`);
    if (other) bits.push(`${other} on a social page or free host`);
    body = bits.length
      ? `Every business in this run was already sorted from the Maps data — ${bits.join(', ')}. None of them has a real domain to open.`
      : 'No business in this run has a real domain to open.';
  }
  return h('div', { style: { maxWidth: '620px' } },
    h('div', { class: 'empty' },
      icon('check', { size: 18, stroke: '#b3aa98' }),
      h('div', { class: 'empty__title', text: 'No sites need checking' }),
      h('div', { class: 'empty__body', style: { maxWidth: '420px', margin: '7px auto 0' }, text: body })),
    h('a', {
      class: 'btn btn--primary',
      style: { marginTop: '26px' },
      href: `#/leads/${encodeURIComponent(slug)}`,
    }, h('span', { text: 'See the call list' }), icon('arrowRight', { size: 15, stroke: '#fdf4ef' })));
}

// ----------------------------------------------------------------- utils

/** SSE payloads arrive as objects; be forgiving about which field holds text. */
function messageOf(payload) {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') return payload;
  const v = payload.message ?? payload.line ?? payload.text ?? payload.msg ?? payload.status;
  return typeof v === 'string' ? v : '';
}

/** A SiteCheck carried on a progress event, however the server labels it. */
function checkOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const c = payload.check || payload.result || payload.verdict;
  if (c && typeof c === 'object' && c.tier) return c;
  if (typeof payload.tier === 'string' && payload.tier) {
    return { tier: payload.tier, reason: typeof payload.reason === 'string' ? payload.reason : '' };
  }
  return null;
}

function findRow(rows, byPlace, payload) {
  if (!payload || typeof payload !== 'object') return null;
  const id = payload.place_id || payload.placeId || payload.id
    || (payload.check && payload.check.place_id) || (payload.lead && payload.lead.place_id);
  if (id && byPlace.has(id)) return byPlace.get(id);
  const url = payload.url || payload.website || payload.finalUrl
    || (payload.check && payload.check.url);
  if (url) {
    const host = hostOf(url);
    if (host) {
      const hit = rows.find((r) => r.host === host);
      if (hit) return hit;
    }
  }
  return null;
}

function hostOf(url) {
  if (!url) return '';
  try {
    return new URL(String(url).includes('//') ? url : `http://${url}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch { return ''; }
}

function callableCount(leads, byPlace) {
  let n = 0;
  for (const l of leads) {
    const row = byPlace.get(l.place_id);
    const tier = row ? (row.check && row.check.tier) || '' : (l.checked_tier || l.tier);
    if (LEAD_TIERS.includes(tier)) n++;
  }
  return n;
}

function elapsed(s) {
  if (!s.startedAt) return '';
  const end = s.finishedAt || Date.now();
  const secs = Math.max(0, Math.round((end - s.startedAt) / 1000));
  return secs < 60 ? `${secs}s elapsed` : `${Math.floor(secs / 60)}m ${secs % 60}s elapsed`;
}

function numWord(n) { return WORDS[n] !== undefined ? WORDS[n] : String(n); }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function msgOf(err) { return String(err && err.message ? err.message : err); }
