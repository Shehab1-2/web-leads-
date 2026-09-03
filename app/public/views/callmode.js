// Call mode — one lead at a time, sized to be read while the phone is ringing.
// Keys 1-4 record an outcome, N skips to the next uncalled lead. The key
// handler lives on window, so destroy() must take it back off again: the shell
// reuses this module and a leaked handler would fire on every other screen.

import {
  h, clear, icon, meta as metaLine, ratingBits, fmtDate, prettyHost, STATUS_LABEL,
} from '../dom.js';

export const meta = { title: 'Call mode' };

// Mirrors app/lib/rank.mjs. That module is a node-side lib under app/lib and is
// not served to the browser, so the ramp is restated here rather than imported.
const TIER_ORDER = ['no_website', 'dead_site', 'social_only', 'free_host', 'very_dated', 'somewhat_dated'];
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

const OUTCOMES = [
  { status: 'no_answer', label: 'No answer', key: '1' },
  { status: 'call_back', label: 'Call back', key: '2' },
  { status: 'not_interested', label: 'Not interested', key: '3' },
  { status: 'interested', label: 'Interested', key: '4', strong: true },
];

const CSS = `
.cm a.btn:hover { text-decoration: none; }
.cm a:hover .cm__factlink { text-decoration: underline; }
.cm__body { display: flex; gap: 72px; padding: 52px 70px 56px; }
.cm__side { width: 400px; flex-shrink: 0; }
.cm__facts { display: flex; flex-wrap: wrap; gap: 56px; margin-top: 36px; }
.cm__fact { margin-top: 8px; font-size: 14px; color: var(--ink-2); }
.cm__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
.cm__key { font-family: var(--mono); font-size: 10px; color: var(--ink-5); }
.cm__kbd { font-family: var(--mono); font-size: 10px; padding: 2px 6px; border: 1px solid var(--field-border); border-radius: 3px; color: var(--ink-3); }
.cm__opener { margin-top: 16px; font-family: var(--serif); font-size: 31px; line-height: 1.42; color: var(--ink); max-width: 660px; text-wrap: pretty; }
@media (max-width: 1240px) {
  .cm__body { flex-direction: column; gap: 44px; padding: 40px 70px 56px; }
  .cm__side { width: 100%; }
}
`;

// The live screen. Null between views; every async continuation checks it so a
// fetch that lands after navigation cannot paint over the next screen.
let live = null;

// ------------------------------------------------------------------ helpers

const tierOf = (lead) => lead.checked_tier || lead.tier || '';
const isLeadTier = (t) => TIER_ORDER.includes(t);
const tierRank = (t) => { const i = TIER_ORDER.indexOf(t); return i === -1 ? TIER_ORDER.length + 1 : i; };

function rankLeads(leads) {
  return [...leads].sort((a, b) => {
    const d = tierRank(tierOf(a)) - tierRank(tierOf(b));
    return d !== 0 ? d : (Number(b.reviews) || 0) - (Number(a.reviews) || 0);
  });
}

/** /api/state may hand back `{status, note}` per place, or a bare status string. */
function normStatus(v) {
  if (!v) return null;
  if (typeof v === 'string') return { status: v, note: '' };
  if (typeof v === 'object' && v.status) return { status: v.status, note: v.note || '' };
  return null;
}

function statusMap(statuses) {
  const map = new Map();
  for (const [id, v] of Object.entries(statuses || {})) {
    const s = normStatus(v);
    if (s) map.set(id, s);
  }
  return map;
}

const telHref = (phone) => `tel:${String(phone).replace(/[^\d+]/g, '')}`;

function label(text) { return h('div', { class: 'label', text }); }

function kbd(text, cls) { return h('span', { class: cls, text }); }

// -------------------------------------------------------------------- view

export async function render(root, ctx) {
  teardown();
  const s = {
    root,
    ctx,
    slug: ctx.slug,
    alive: true,
    leads: [],
    runMeta: null,
    total: 0,
    unchecked: 0,
    healthy: 0,
    statuses: new Map(),
    notes: new Map(),
    firstSeen: new Map(),
    index: -1,
    busy: false,
    error: null,
  };
  live = s;

  clear(root);
  root.appendChild(loadingPane());

  const [runRes, histRes, stateRes] = await Promise.allSettled([
    ctx.api.run(ctx.slug),
    ctx.api.history(),
    ctx.refresh(),
  ]);
  if (!s.alive) return;
  if (runRes.status === 'rejected') throw runRes.reason;

  const run = runRes.value;
  const all = Array.isArray(run.leads) ? run.leads : [];
  s.runMeta = run.meta || {};
  s.total = all.length;
  s.leads = rankLeads(all.filter((l) => isLeadTier(tierOf(l))));
  s.unchecked = all.filter((l) => !isLeadTier(tierOf(l)) && tierOf(l) !== 'not_a_lead').length;
  s.healthy = all.filter((l) => tierOf(l) === 'not_a_lead').length;

  const fresh = stateRes.status === 'fulfilled' ? stateRes.value : ctx.state;
  s.statuses = statusMap(fresh && fresh.statuses);

  // first_seen is a seen_leads column, so it comes from /api/history. Best
  // effort: if that call fails the fact block falls back to the run's date.
  if (histRes.status === 'fulfilled' && Array.isArray(histRes.value.rows)) {
    for (const r of histRes.value.rows) {
      const id = r.place_id || r.placeId;
      const seen = r.first_seen || r.firstSeen;
      if (id && seen) s.firstSeen.set(id, seen);
    }
  }

  for (const [id, v] of s.statuses) if (v.note) s.notes.set(id, v.note);
  s.index = nextUncalled(s, -1);

  window.addEventListener('keydown', onKeyDown);
  paint(s);
}

export function destroy() { teardown(); }

function teardown() {
  window.removeEventListener('keydown', onKeyDown);
  if (live) live.alive = false;
  live = null;
}

// ------------------------------------------------------------------ queue

const called = (s, lead) => s.statuses.has(lead.place_id);

function nextUncalled(s, from) {
  const n = s.leads.length;
  for (let step = 1; step <= n; step += 1) {
    const i = (from + step + n) % n;
    if (!called(s, s.leads[i])) return i;
  }
  return -1;
}

function remainingCount(s) {
  return s.leads.filter((l, i) => i !== s.index && !called(s, l)).length;
}

function advance() {
  const s = live;
  if (!s || !s.alive || s.busy) return;
  s.error = null;
  s.index = nextUncalled(s, s.index);
  paint(s);
}

async function record(status) {
  const s = live;
  if (!s || !s.alive || s.busy) return;
  const lead = s.leads[s.index];
  if (!lead) return;
  const note = (s.notes.get(lead.place_id) || '').trim();

  s.busy = status;
  s.error = null;
  paint(s);

  try {
    await s.ctx.api.outcome({ place_id: lead.place_id, status, note });
  } catch (err) {
    if (!s.alive) return;
    s.busy = false;
    s.error = err && err.message ? err.message : String(err);
    s.ctx.toast(`Could not save that outcome — ${s.error}`, 'err');
    paint(s);
    return;
  }
  if (!s.alive) return;

  s.statuses.set(lead.place_id, { status, note });
  s.busy = false;
  s.ctx.toast(`${STATUS_LABEL[status]} — ${lead.name}`);

  try {
    const fresh = await s.ctx.refresh();
    if (!s.alive) return;
    const merged = statusMap(fresh && fresh.statuses);
    if (merged.size) s.statuses = merged;
  } catch { /* nav counts can lag; the local map is already right */ }

  if (!s.alive) return;
  s.index = nextUncalled(s, s.index);
  paint(s);
}

// ----------------------------------------------------------------- painting

function loadingPane() {
  return h('div', {},
    h('div', { class: 'eyebrow', text: 'web-leads / call mode' }),
    h('div', { class: 'skeleton', style: { height: '52px', width: '360px', marginTop: '20px' } }),
    h('div', { class: 'skeleton', style: { height: '14px', width: '280px', marginTop: '18px' } }),
    h('div', { class: 'skeleton', style: { height: '96px', width: '620px', marginTop: '34px' } }));
}

function paint(s) {
  clear(s.root);
  const wrap = h('div', { class: 'cm', style: { margin: '-56px -70px -72px' } }, h('style', { text: CSS }));

  if (!s.leads.length) {
    wrap.appendChild(header(s));
    wrap.appendChild(nothingToCall(s));
  } else if (s.index === -1) {
    wrap.appendChild(header(s));
    wrap.appendChild(finished(s));
  } else {
    wrap.appendChild(header(s));
    wrap.appendChild(h('div', { class: 'cm__body' }, leftColumn(s), rightColumn(s)));
  }
  s.root.appendChild(wrap);
}

function header(s) {
  const m = s.runMeta || {};
  const where = [m.niche, m.location].filter(Boolean);
  const done = s.leads.filter((l) => called(s, l)).length;
  const at = s.index === -1 ? s.leads.length : s.index + 1;
  const pct = s.leads.length ? Math.round((at / s.leads.length) * 100) : 0;
  const left = s.index === -1 ? 0 : remainingCount(s);

  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '40px', padding: '22px 70px', borderBottom: '1px solid var(--rule)',
    },
  },
  h('div', { style: { fontSize: '13px', color: '#6b6558', minWidth: '0' } },
    where.length ? metaLine(...where) : h('span', { text: s.slug })),

  h('div', { style: { display: 'flex', alignItems: 'center', gap: '16px' } },
    h('div', { class: 'bar', style: { width: '260px' } },
      h('div', { class: 'bar__fill', style: { width: `${pct}%` } })),
    h('span', {
      class: 'tnum',
      style: { fontSize: '12.5px', color: 'var(--ink-3)', whiteSpace: 'nowrap' },
      text: !s.leads.length ? 'No leads to call'
        : s.index === -1 ? `${done} of ${s.leads.length} handled`
          : `Lead ${at} of ${s.leads.length}  ·  ${left ? `${left} to go` : 'last one'}`,
    })),

  h('a', {
    href: `#/leads/${encodeURIComponent(s.slug)}`,
    style: {
      display: 'inline-flex', alignItems: 'center', gap: '8px',
      fontSize: '13px', fontWeight: '500', color: 'var(--ink-2)',
    },
  }, icon('x', { size: 14, stroke: 'var(--ink-3)' }), 'Leave call mode'));
}

function leftColumn(s) {
  const lead = s.leads[s.index];
  const tier = tierOf(lead);
  const rank = ratingBits(lead);
  const seen = s.firstSeen.get(lead.place_id) || '';

  return h('div', { style: { flex: '1', minWidth: '0' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
      h('span', { class: `pill pill--${tier}`, text: TIER_LABEL[tier] || tier }),
      h('span', {
        class: 'tnum',
        style: { fontSize: '12.5px', color: 'var(--ink-4)' },
        text: s.index === 0 ? 'Strongest lead in this list' : `Number ${s.index + 1} in this list`,
      })),

    h('h1', { class: 'title', style: { fontSize: '50px', marginTop: '15px' }, text: lead.name || '(no name on the listing)' }),

    h('div', {
      class: 'lead__meta',
      style: { marginTop: '13px', fontSize: '13.5px' },
    }, metaLine(lead.category, lead.address, rank[0]), rank[1] || null),

    h('div', { style: { marginTop: '34px', paddingTop: '30px', borderTop: '1px solid var(--rule)' } },
      label('Say this'),
      lead.reason
        ? h('p', { class: 'cm__opener', text: lead.reason })
        : h('p', {
          class: 'cm__opener',
          style: { fontStyle: 'italic', color: 'var(--ink-3)' },
          text: `No opener was recorded for this one — the verdict on file is "${TIER_LABEL[tier] || tier}".`,
        })),

    h('div', { class: 'cm__facts' },
      h('div', {}, label('Website'), lead.website
        ? h('a', {
          class: 'cm__fact',
          href: lead.website,
          target: '_blank',
          rel: 'noopener noreferrer',
          style: { display: 'flex', alignItems: 'center', gap: '7px' },
        },
        h('span', { class: 'cm__factlink', text: prettyHost(lead.website) }),
        icon('external', { size: 12, stroke: 'var(--ink-4)' }))
        : h('div', { class: 'cm__fact', text: 'None listed on Maps' })),

      h('div', {}, label('Listing'), lead.maps_url
        ? h('a', {
          class: 'cm__fact',
          href: lead.maps_url,
          target: '_blank',
          rel: 'noopener noreferrer',
          style: { display: 'flex', alignItems: 'center', gap: '7px' },
        },
        h('span', { class: 'cm__factlink', text: 'Open in Google Maps' }),
        icon('external', { size: 12, stroke: 'var(--ink-4)' }))
        : h('div', { class: 'cm__fact', text: 'No Maps link on file' })),

      seen
        ? h('div', {}, label('First seen'), h('div', { class: 'cm__fact tnum', text: fmtDate(seen) }))
        : s.runMeta && s.runMeta.date
          ? h('div', {}, label('Search date'), h('div', { class: 'cm__fact tnum', text: fmtDate(s.runMeta.date) }))
          : null));
}

function rightColumn(s) {
  const lead = s.leads[s.index];
  const side = h('div', { class: 'cm__side' });

  side.appendChild(label('Dial'));
  if (lead.phone) {
    side.appendChild(h('div', {
      class: 'mono',
      style: { marginTop: '10px', fontSize: '38px', fontWeight: '500', letterSpacing: '-0.02em', color: 'var(--ink)' },
      text: lead.phone,
    }));
    side.appendChild(h('a', {
      class: 'btn btn--primary',
      href: telHref(lead.phone),
      style: { width: '100%', height: '54px', marginTop: '16px', fontSize: '15px' },
    }, icon('phone', { size: 17 }), 'Call now'));
  } else {
    side.appendChild(h('div', {
      class: 'lead__nophone',
      style: { marginTop: '10px', fontSize: '19px', height: 'auto' },
    }, icon('phoneOff', { size: 17, stroke: 'var(--ink-4)' }), 'No phone on the listing'));
    side.appendChild(h('a', {
      class: 'btn btn--quiet',
      href: lead.maps_url || null,
      target: lead.maps_url ? '_blank' : null,
      rel: 'noopener noreferrer',
      'aria-disabled': lead.maps_url ? null : 'true',
      style: { width: '100%', height: '54px', marginTop: '16px', fontSize: '15px' },
    }, icon('external', { size: 15, stroke: 'var(--ink-3)' }), 'Look it up on Maps'));
  }

  const notes = h('textarea', {
    class: 'textarea',
    placeholder: 'What did they say?',
    onInput: (e) => { s.notes.set(lead.place_id, e.target.value); },
  });
  notes.value = s.notes.get(lead.place_id) || '';
  side.appendChild(h('div', { class: 'label', style: { marginTop: '30px' }, text: 'Notes' }));
  side.appendChild(notes);

  side.appendChild(h('div', { class: 'label', style: { marginTop: '26px' }, text: 'Outcome' }));
  side.appendChild(h('div', { class: 'cm__grid' }, OUTCOMES.map((o) => h('button', {
    class: `btn ${o.strong ? 'btn--dark' : 'btn--quiet'}`,
    style: { fontSize: '13.5px' },
    disabled: s.busy ? true : null,
    'aria-disabled': s.busy ? 'true' : null,
    onClick: () => record(o.status),
  },
  s.busy === o.status ? 'Saving…' : o.label,
  s.busy === o.status ? null : kbd(o.key, 'cm__key')))));

  if (s.error) {
    side.appendChild(h('div', { class: 'note', style: { marginTop: '14px' } },
      h('div', { class: 'note__title' }, icon('alert', { size: 14, stroke: 'var(--warn-ink)' }), 'Not saved'),
      h('div', {
        class: 'note__body',
        text: `${s.error} — nothing was written to call_outcomes.csv. The note above is still here, so try again once the server answers.`,
      })));
  }

  side.appendChild(h('div', {
    style: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '16px', marginTop: '22px',
    },
  },
  h('span', { style: { fontSize: '12.5px', color: 'var(--ink-4)' }, text: 'Saved to seen_leads.csv' }),
  h('button', {
    style: {
      display: 'inline-flex', alignItems: 'center', gap: '9px',
      fontSize: '13.5px', fontWeight: '500', color: 'var(--ink)',
    },
    onClick: advance,
  }, 'Next lead', kbd('N', 'cm__kbd'))));

  return side;
}

// ------------------------------------------------------------- end states

function centred(...children) {
  return h('div', { style: { padding: '84px 70px 96px', maxWidth: '700px' } }, ...children);
}

function finished(s) {
  const tally = OUTCOMES
    .map((o) => ({
      label: o.label,
      n: s.leads.filter((l) => (s.statuses.get(l.place_id) || {}).status === o.status).length,
    }))
    .filter((t) => t.n > 0);

  return centred(
    h('div', { class: 'eyebrow', text: 'web-leads / call mode' }),
    h('h1', { class: 'title', style: { marginTop: '16px' }, text: 'That is the whole list' }),
    h('p', {
      class: 'subtitle',
      text: `All ${s.leads.length} leads in this search have an outcome on file. Each one is appended to data/call_outcomes.csv and mirrored into seen_leads.csv.`,
    }),

    tally.length
      ? h('div', { class: 'card', style: { marginTop: '28px' } },
        tally.map((t, i) => h('div', {
          style: {
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '9px 0', borderTop: i ? '1px solid var(--rule-soft)' : 'none', fontSize: '14px',
          },
        },
        h('span', { text: t.label }),
        h('span', { class: 'tnum', style: { color: 'var(--ink-2)' }, text: String(t.n) }))))
      : null,

    h('div', { style: { display: 'flex', gap: '12px', marginTop: '28px', flexWrap: 'wrap' } },
      h('a', { class: 'btn btn--primary', href: `#/leads/${encodeURIComponent(s.slug)}` }, 'Back to the call list'),
      h('a', { class: 'btn btn--quiet', href: '#/history' }, 'Open call history'),
      h('a', { class: 'btn btn--quiet', href: '#/search' }, 'Run another search')));
}

function nothingToCall(s) {
  const body = s.unchecked
    ? `${s.unchecked} of the ${s.total} businesses in this search still need their sites checked — stage 2 is what decides which of them are leads.`
    : s.total > 0 && s.healthy === s.total
      ? `All ${s.total} sites in this search came back healthy, so none were kept to pitch.`
      : 'This search has no rows in it yet.';

  return centred(
    h('div', { class: 'eyebrow', text: 'web-leads / call mode' }),
    h('h1', { class: 'title', style: { marginTop: '16px' }, text: 'Nothing to call yet' }),
    h('p', { class: 'subtitle', text: body }),
    h('div', { style: { display: 'flex', gap: '12px', marginTop: '28px', flexWrap: 'wrap' } },
      s.unchecked
        ? h('a', { class: 'btn btn--primary', href: `#/checking/${encodeURIComponent(s.slug)}` }, 'Check the sites')
        : h('a', { class: 'btn btn--primary', href: '#/search' }, 'Run another search'),
      h('a', { class: 'btn btn--quiet', href: `#/leads/${encodeURIComponent(s.slug)}` }, 'Back to the call list')));
}

// ---------------------------------------------------------------- keyboard

function onKeyDown(e) {
  const s = live;
  if (!s || !s.alive || !s.leads.length || s.index === -1) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  // Typing a note must not record an outcome. Escape gets the keys back.
  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) {
    if (e.key === 'Escape' && typeof t.blur === 'function') t.blur();
    return;
  }

  const hit = OUTCOMES.find((o) => o.key === e.key);
  if (hit) { e.preventDefault(); record(hit.status); return; }
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); advance(); }
}
