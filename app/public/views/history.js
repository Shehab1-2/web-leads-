// Call history — everything seen_leads holds, joined with the outcomes log.
// This is the file that stops a business coming back in a later search, so the
// healthy sites that were dropped are kept visible at the bottom rather than
// hidden: they are records, not leads.

import {
  h, clear, icon, fmtShortDate, STATUS_LABEL, statusDot, plural,
} from '../dom.js';

export const meta = { title: 'Call history' };

// Mirrors app/lib/rank.mjs — that module lives under app/lib and is not served
// to the browser, so the labels and the ramp order are restated here.
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
const OUTCOME_ORDER = ['interested', 'call_back', 'no_answer', 'not_interested'];

const CSS = `
.hist a.btn:hover { text-decoration: none; }
.hist__controls { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-top: 34px; flex-wrap: wrap; }
.hist__filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.hist__input { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; padding: 0; font-size: 13.5px; color: var(--ink); }
.hist__select { appearance: none; -webkit-appearance: none; border: 0; background: transparent; outline: none; padding: 0 2px 0 0; font-size: 13px; color: var(--ink-2); cursor: pointer; }
.hist__cell-name { flex: 1; min-width: 0; font-size: 14px; }
.hist__cell-verdict { width: 150px; flex-shrink: 0; }
.hist__cell-outcome { width: 190px; flex-shrink: 0; font-size: 13px; }
.hist__cell-seen { width: 110px; flex-shrink: 0; text-align: right; font-family: var(--mono); font-size: 12.5px; color: var(--ink-4); }
.hist__group { margin-top: 26px; font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-5); }
@media (max-width: 1100px) {
  .hist__cell-outcome { width: 150px; }
  .hist__cell-verdict { width: 128px; }
}
`;

let live = null;

// ------------------------------------------------------------------ shapes

/** The join can arrive as `{status, note}` under either key, or a bare string. */
function readOutcome(row) {
  const raw = row.outcome !== undefined && row.outcome !== null && row.outcome !== '' ? row.outcome : row.status;
  if (!raw) return { status: '', note: row.note || '' };
  if (typeof raw === 'string') return { status: raw, note: row.note || '' };
  if (typeof raw === 'object') return { status: raw.status || '', note: raw.note || row.note || '' };
  return { status: '', note: row.note || '' };
}

function normalize(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const oc = readOutcome(r);
    const address = r.address || '';
    return {
      place_id: r.place_id || r.placeId || '',
      name: r.name || '',
      category: r.category || '',
      address,
      street: address.split(',')[0].trim(),
      phone: r.phone || '',
      trade: r.niche || r.trade || '',
      town: r.location || r.town || '',
      verdict: r.checked_tier || r.checkedTier || r.tier || '',
      status: oc.status,
      note: oc.note,
      firstSeen: r.first_seen || r.firstSeen || '',
    };
  });
}

const verdictRank = (v) => {
  const i = TIER_ORDER.indexOf(v);
  return i === -1 ? TIER_ORDER.length + 1 : i;
};

const uniq = (values) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));

function longDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// --------------------------------------------------------------- exporting

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const EXPORT_COLUMNS = [
  ['name', (r) => r.name],
  ['category', (r) => r.category],
  ['address', (r) => r.address],
  ['phone', (r) => r.phone],
  ['trade', (r) => r.trade],
  ['location', (r) => r.town],
  ['verdict', (r) => TIER_LABEL[r.verdict] || r.verdict],
  ['outcome', (r) => (r.status ? STATUS_LABEL[r.status] || r.status : '')],
  ['note', (r) => r.note],
  ['first_seen', (r) => r.firstSeen],
  ['place_id', (r) => r.place_id],
];

function exportCsv(s, rows) {
  const lines = [EXPORT_COLUMNS.map(([name]) => name).join(',')];
  for (const r of rows) lines.push(EXPORT_COLUMNS.map(([, get]) => csvCell(get(r))).join(','));
  const blob = new Blob([`${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `call-history-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  const t = setTimeout(() => URL.revokeObjectURL(url), 4000);
  s.timers.add(t);
  s.ctx.toast(`Exported ${plural(rows.length, 'row', 'rows')}`);
}

// -------------------------------------------------------------------- view

export async function render(root, ctx) {
  teardown();
  const s = { root, ctx, alive: true, timers: new Set(), rows: [], q: '', trade: '', town: '', outcome: '' };
  live = s;

  clear(root);
  root.appendChild(chrome(loadingBody()));

  const res = await ctx.api.history();
  if (!s.alive) return;
  s.rows = normalize(res.rows);

  clear(root);
  root.appendChild(page(s));
}

export function destroy() { teardown(); }

function teardown() {
  if (live) {
    live.alive = false;
    for (const t of live.timers) clearTimeout(t);
    live.timers.clear();
  }
  live = null;
}

// ----------------------------------------------------------------- chrome

function chrome(...body) {
  return h('div', { class: 'hist' },
    h('style', { text: CSS }),
    h('div', { class: 'eyebrow', text: 'web-leads / history' }),
    ...body);
}

function loadingBody() {
  const bar = (w, mt) => h('div', { class: 'skeleton', style: { height: '14px', width: w, marginTop: mt } });
  return h('div', {},
    h('div', { class: 'skeleton', style: { height: '46px', width: '320px', marginTop: '18px' } }),
    bar('420px', '16px'),
    h('div', { class: 'skeleton', style: { height: '38px', width: '640px', marginTop: '34px' } }),
    bar('100%', '30px'), bar('100%', '14px'), bar('100%', '14px'), bar('100%', '14px'));
}

function page(s) {
  const searches = uniq(s.rows.map((r) => `${r.trade}|${r.town}`).filter((k) => k !== '|'));
  const since = s.rows.map((r) => r.firstSeen).filter(Boolean).sort()[0] || '';

  const body = h('div');
  const wrap = chrome(
    head(s, searches.length, since),
    controls(s, () => repaint(s, body)),
    searches.length === 1 ? oneSearchNote() : null,
    body);
  repaint(s, body);
  return wrap;
}

function head(s, searches, since) {
  return h('div', { class: 'head-row' },
    h('div', {},
      h('h1', { class: 'title', text: 'Call history' }),
      h('p', {
        class: 'subtitle',
        style: { maxWidth: '620px' },
        text: 'Every business the pipeline has ever surfaced. Nothing on this page comes back in a future search.',
      })),
    h('div', {
      class: 'tnum',
      style: { textAlign: 'right', fontSize: '13.5px', color: 'var(--ink-3)', lineHeight: '1.7', paddingBottom: '4px' },
    },
    h('div', {
      text: searches
        ? `${plural(s.rows.length, 'business', 'businesses')}  ·  ${plural(searches, 'search', 'searches')}`
        : plural(s.rows.length, 'business', 'businesses'),
    }),
    since ? h('div', { style: { color: 'var(--ink-4)' }, text: `since ${longDate(since)}` }) : null));
}

function oneSearchNote() {
  return h('div', {
    class: 'panel',
    style: { display: 'flex', alignItems: 'center', gap: '14px', marginTop: '26px', padding: '12px 16px' },
  },
  icon('info', { size: 15, stroke: 'var(--ink-3)' }),
  h('span', {
    style: { fontSize: '13px', color: 'var(--ink-2)' },
    text: 'One search so far. The trade and town filters start doing real work once there is a second.',
  }));
}

function controls(s, onChange) {
  const search = h('input', {
    class: 'hist__input',
    type: 'text',
    placeholder: 'Find a business',
    'aria-label': 'Find a business by name',
    onInput: (e) => { s.q = e.target.value; onChange(); },
  });

  const trades = uniq(s.rows.map((r) => r.trade));
  const towns = uniq(s.rows.map((r) => r.town));
  const outcomes = OUTCOME_ORDER.filter((o) => s.rows.some((r) => r.status === o));
  const anyUncalled = s.rows.some((r) => !r.status);

  return h('div', { class: 'hist__controls' },
    h('div', { class: 'hist__filters' },
      h('div', {
        class: 'field field--sm',
        style: { width: '270px', marginTop: '0', gap: '9px' },
      }, icon('search', { size: 15, stroke: 'var(--ink-5)', width: 2 }), search),

      trades.length ? picker(trades.map((t) => ({ value: t, label: t })), 'Any trade', s.trade, (v) => { s.trade = v; onChange(); }) : null,
      towns.length ? picker(towns.map((t) => ({ value: t, label: t })), 'Any town', s.town, (v) => { s.town = v; onChange(); }) : null,
      outcomes.length || anyUncalled
        ? picker([
          ...(anyUncalled ? [{ value: 'not_called', label: 'Not called' }] : []),
          ...outcomes.map((o) => ({ value: o, label: STATUS_LABEL[o] || o })),
        ], 'Any outcome', s.outcome, (v) => { s.outcome = v; onChange(); })
        : null),

    h('button', {
      class: 'btn btn--sm btn--outline',
      onClick: () => exportCsv(s, visible(s).all),
    }, icon('download', { size: 14 }), 'Export CSV'));
}

function picker(options, anyLabel, value, onChange) {
  const sel = h('select', {
    class: 'hist__select',
    'aria-label': anyLabel,
    onChange: (e) => onChange(e.target.value),
  }, h('option', { value: '' }, anyLabel), options.map((o) => h('option', { value: o.value }, o.label)));
  sel.value = value;
  return h('div', {
    class: 'field field--sm',
    style: { width: 'auto', marginTop: '0', gap: '8px' },
  }, sel, icon('chevronDown', { size: 10, stroke: 'var(--ink-5)', width: 2.6 }));
}

// ------------------------------------------------------------------ table

function matches(s, r) {
  if (s.q && !r.name.toLowerCase().includes(s.q.trim().toLowerCase())) return false;
  if (s.trade && r.trade !== s.trade) return false;
  if (s.town && r.town !== s.town) return false;
  if (s.outcome === 'not_called' && r.status) return false;
  if (s.outcome && s.outcome !== 'not_called' && r.status !== s.outcome) return false;
  return true;
}

function visible(s) {
  const kept = s.rows.filter((r) => matches(s, r));
  const leads = kept.filter((r) => r.verdict !== 'not_a_lead')
    .sort((a, b) => verdictRank(a.verdict) - verdictRank(b.verdict));
  const never = kept.filter((r) => r.verdict === 'not_a_lead');
  return { leads, never, all: [...leads, ...never] };
}

function repaint(s, body) {
  clear(body);
  const filtering = Boolean(s.q || s.trade || s.town || s.outcome);
  const { leads, never, all } = visible(s);

  if (!s.rows.length) {
    body.appendChild(h('div', { class: 'empty', style: { marginTop: '30px' } },
      icon('list', { size: 20, stroke: 'var(--ink-5)' }),
      h('div', { class: 'empty__title', text: 'Nothing has been searched yet' }),
      h('div', {
        class: 'empty__body',
        text: 'Every business a search surfaces is written to data/seen_leads.csv and shows up here, called or not.',
      }),
      h('a', { class: 'btn btn--sm btn--primary', style: { marginTop: '16px' }, href: '#/search' }, 'Run the first search')));
    return;
  }

  if (filtering) {
    body.appendChild(h('div', {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        gap: '12px', marginTop: '22px', fontSize: '12.5px', color: 'var(--ink-4)',
      },
    },
    h('span', { class: 'tnum', text: `Showing ${all.length} of ${s.rows.length}` }),
    h('button', {
      style: { fontSize: '12.5px', color: 'var(--ink-2)', textDecoration: 'underline' },
      onClick: () => {
        s.q = ''; s.trade = ''; s.town = ''; s.outcome = '';
        clear(s.root);
        s.root.appendChild(page(s));
      },
    }, 'Clear filters')));
  }

  if (!all.length) {
    body.appendChild(h('div', { class: 'empty', style: { marginTop: '18px' } },
      icon('search', { size: 20, stroke: 'var(--ink-5)', width: 2 }),
      h('div', { class: 'empty__title', text: 'No business here matches those filters' }),
      h('div', {
        class: 'empty__body',
        text: `${plural(s.rows.length, 'business', 'businesses')} on file — widen the filters to see them.`,
      })));
    return;
  }

  body.appendChild(h('div', { class: 'thead', style: { marginTop: filtering ? '14px' : '30px' } },
    h('span', { class: 'hist__cell-name', text: 'Business' }),
    h('span', { class: 'hist__cell-verdict', text: 'Verdict' }),
    h('span', { class: 'hist__cell-outcome', text: 'Outcome' }),
    h('span', { class: 'hist__cell-seen', style: { color: 'var(--ink-4)' }, text: 'First seen' })));

  leads.forEach((r, i) => body.appendChild(leadRow(r, i === leads.length - 1)));

  if (never.length) {
    body.appendChild(h('div', { class: 'hist__group', text: 'Never leads — kept so they do not resurface' }));
    never.forEach((r, i) => body.appendChild(neverRow(r, i === 0)));
  }
}

function nameCell(r) {
  const tail = [r.category, r.street].filter(Boolean).join(' · ');
  return h('span', { class: 'hist__cell-name' },
    h('span', { style: { fontWeight: '600' }, text: r.name || '(no name on the listing)' }),
    tail ? h('span', { style: { color: 'var(--ink-3)', fontSize: '13px' }, text: ` · ${tail}` }) : null);
}

function seenCell(r) {
  return h('span', { class: 'hist__cell-seen tnum', text: r.firstSeen ? fmtShortDate(r.firstSeen) : '—' });
}

function outcomeCell(r) {
  if (!r.status) {
    return h('span', { class: 'hist__cell-outcome', style: { color: 'var(--ink-3)' } },
      'Not called',
      r.phone ? null : h('span', { style: { color: 'var(--ink-5)' }, text: ' — no phone' }));
  }
  return h('span', {
    class: 'hist__cell-outcome',
    title: r.note || undefined,
    style: {
      display: 'inline-flex', alignItems: 'center', gap: '7px', fontWeight: '500',
      color: r.status === 'interested' ? 'var(--ink)' : 'var(--ink-2)',
      overflow: 'hidden', whiteSpace: 'nowrap',
    },
  },
  statusDot(r.status),
  h('span', { text: STATUS_LABEL[r.status] || r.status }),
  r.note
    ? h('span', {
      style: { color: 'var(--ink-3)', fontWeight: '400', overflow: 'hidden', textOverflow: 'ellipsis' },
      text: ` — ${r.note}`,
    })
    : null);
}

function leadRow(r, last) {
  return h('div', {
    class: `trow${r.status ? ' trow--tinted' : ''}`,
    style: last ? { borderBottomColor: 'var(--rule)' } : null,
  },
  nameCell(r),
  h('span', { class: 'hist__cell-verdict' },
    h('span', {
      class: `pill pill--sm pill--${r.verdict || 'needs_check'}`,
      text: TIER_LABEL[r.verdict] || r.verdict || 'Unknown',
    })),
  outcomeCell(r),
  seenCell(r));
}

function neverRow(r, first) {
  return h('div', {
    class: 'trow trow--muted',
    style: first ? { marginTop: '8px', borderTop: '1px solid var(--rule-soft)' } : null,
  },
  nameCell(r),
  h('span', { class: 'hist__cell-verdict', style: { fontSize: '12.5px', color: 'var(--ink-3)' }, text: TIER_LABEL.not_a_lead }),
  r.status
    ? outcomeCell(r)
    : h('span', { class: 'hist__cell-outcome', style: { color: 'var(--ink-4)' }, text: 'Dropped' }),
  seenCell(r));
}
