// Data — every business ever scraped, in one dense table, so judgements can be
// made by eye rather than only through the ranking.
//
// The call list is opinionated on purpose: strongest first, healthy sites cut.
// This screen is the opposite. Nothing is hidden, nothing is dropped, every
// column is showable, and sorting is yours. Clicking a row opens the detail
// panel over the table instead of navigating away.

import { h, clear, icon, prettyHost, STATUS_LABEL, statusDot } from '../dom.js';
import { openPanel, closePanel } from '../panel.js';

export const meta = { title: 'Data' };

const CSS = `
.dt__bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 22px; }
.dt__search { flex: 1; min-width: 200px; max-width: 320px; }
.dt__wrap { margin-top: 16px; border: 1px solid var(--rule); border-radius: 8px; overflow: auto; max-height: calc(100vh - 260px); background: var(--surface); }
.dt__t { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 12.5px; }
.dt__t th { position: sticky; top: 0; z-index: 2; background: var(--tint); border-bottom: 1px solid var(--rule); padding: 8px 10px; text-align: left; white-space: nowrap; font-weight: 600; color: var(--ink-2); font-size: 11.5px; letter-spacing: 0.02em; cursor: pointer; user-select: none; }
.dt__t th:hover { color: var(--ink); }
.dt__t td { border-bottom: 1px solid var(--rule-soft); padding: 7px 10px; vertical-align: top; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt__t tbody tr { cursor: pointer; }
.dt__t tbody tr:hover td { background: var(--tint); }
.dt__arrow { color: var(--ink-4); margin-left: 3px; }
.dt__cols { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
.dt__col { font-size: 11.5px; padding: 4px 9px; border: 1px solid var(--rule); border-radius: 12px; background: transparent; cursor: pointer; color: var(--ink-3); }
.dt__col[aria-pressed="true"] { border-color: var(--ink-5); color: var(--ink); background: var(--surface); }
.dt__count { font-size: 12.5px; color: var(--ink-3); }
.dt__num { font-variant-numeric: tabular-nums; text-align: right; }
`;

// Shown by default. The rest are one click away rather than absent.
const DEFAULT_COLS = ['name', 'phone', 'email', 'website', 'tierLabel', 'rating', 'reviews', 'city', 'outcomeLabel', 'run'];

const TIER_LABEL = {
  no_website: 'No website', dead_site: 'Dead site', social_only: 'Social only',
  free_host: 'Free host', very_dated: 'Very dated', somewhat_dated: 'Somewhat dated',
  needs_check: 'Needs checking', not_a_lead: 'Healthy site',
};

// key -> [header, accessor, numeric?]
const COLUMNS = [
  ['name', 'Name', (r) => r.name],
  ['phone', 'Phone', (r) => r.phone],
  ['email', 'Email', (r) => r.email],
  ['website', 'Website', (r) => prettyHost(r.website)],
  ['tierLabel', 'Verdict', (r) => TIER_LABEL[r.effectiveTier] || r.effectiveTier || ''],
  ['rating', 'Rating', (r) => r.rating, true],
  ['reviews', 'Reviews', (r) => r.reviews, true],
  ['city', 'City', (r) => r.city],
  ['state', 'State', (r) => r.state],
  ['postal_code', 'ZIP', (r) => r.postal_code],
  ['category', 'Category', (r) => r.category],
  ['outcomeLabel', 'Outcome', (r) => (r.outcome && r.outcome.status ? (STATUS_LABEL[r.outcome.status] || r.outcome.status) : '')],
  ['run', 'Run', (r) => r.run],
  ['niche', 'Niche', (r) => r.niche],
  ['date', 'Date', (r) => r.date],
  ['address', 'Address', (r) => r.address],
  ['hours', 'Hours', (r) => r.hours],
  ['socials', 'Socials', (r) => r.socials],
  ['description', 'Description', (r) => r.description],
  ['claim_this_business', 'Claim prompt', (r) => r.claim_this_business],
  ['reason', 'Opener', (r) => r.reason],
  ['place_id', 'place_id', (r) => r.place_id],
];

const COL = new Map(COLUMNS.map((c) => [c[0], c]));

let live = null;
export function destroy() { if (live) live.dead = true; live = null; closePanel(); }

export async function render(root, ctx) {
  const s = { dead: false };
  live = s;

  const wrap = h('div');
  wrap.appendChild(h('style', { text: CSS }));
  wrap.appendChild(h('div', { class: 'eyebrow', text: 'web-leads / data' }));
  wrap.appendChild(h('h1', { class: 'title', style: { marginTop: '14px' }, text: 'Everything scraped' }));
  wrap.appendChild(h('p', { class: 'subtitle', text: 'Every business from every search, unranked and unfiltered — including the healthy sites the call list drops. Sort it, filter it, and judge for yourself.' }));

  const body = h('div');
  wrap.appendChild(body);
  body.appendChild(h('div', { class: 'skeleton', style: { height: '120px', marginTop: '24px' } }));

  clear(root);
  root.appendChild(wrap);

  let payload;
  try {
    payload = await ctx.api.leads();
  } catch (err) {
    if (s.dead) return;
    clear(body);
    body.appendChild(h('p', { class: 'hint', style: { marginTop: '20px' }, text: `Could not load — ${err.message}` }));
    return;
  }
  if (s.dead) return;

  const rows = payload.rows || [];
  clear(body);

  if (!rows.length) {
    body.appendChild(h('div', { class: 'empty', style: { marginTop: '34px' } },
      icon('list', { size: 20, stroke: '#bcb2a0', width: 1.7 }),
      h('div', { class: 'empty__title', text: 'Nothing scraped yet' }),
      h('p', { class: 'empty__body', text: 'Run a search and every business it finds will show up here.' }),
      h('a', { class: 'btn btn--primary', style: { marginTop: '18px' }, href: '#/search' }, 'Start a search')));
    return;
  }

  const view = {
    q: '',
    run: '',
    tier: '',
    onlyLeads: false,
    sort: 'reviews',
    dir: 'desc',
    cols: [...DEFAULT_COLS],
  };

  // ------------------------------------------------------------- controls
  const search = h('input', { class: 'field dt__search', placeholder: 'Search name, phone, site, city…', type: 'search' });
  search.addEventListener('input', () => { view.q = search.value.trim().toLowerCase(); paint(); });

  const runSel = h('select', { class: 'field', style: { width: 'auto' } },
    h('option', { value: '', text: 'All searches' }),
    (payload.runs || []).map((r) => h('option', { value: r, text: r })));
  runSel.addEventListener('change', () => { view.run = runSel.value; paint(); });

  const tierSel = h('select', { class: 'field', style: { width: 'auto' } },
    h('option', { value: '', text: 'All verdicts' }),
    Object.entries(TIER_LABEL).map(([k, v]) => h('option', { value: k, text: v })));
  tierSel.addEventListener('change', () => { view.tier = tierSel.value; paint(); });

  const leadsOnly = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false' }, 'Callable only');
  leadsOnly.addEventListener('click', () => {
    view.onlyLeads = !view.onlyLeads;
    leadsOnly.setAttribute('aria-pressed', String(view.onlyLeads));
    paint();
  });

  const count = h('span', { class: 'dt__count' });
  const csvBtn = h('button', { class: 'btn btn--quiet btn--sm', type: 'button' },
    icon('download', { size: 13 }), 'Download CSV');
  csvBtn.addEventListener('click', () => downloadCsv(visible(), view.cols, ctx));

  body.appendChild(h('div', { class: 'dt__bar' }, search, runSel, tierSel, leadsOnly, count,
    h('span', { style: { marginLeft: 'auto' } }, csvBtn)));

  // Column toggles — everything stored is one click from being visible.
  const colBar = h('div', { class: 'dt__cols' });
  for (const [key, label] of COLUMNS.map((c) => [c[0], c[1]])) {
    const b = h('button', {
      class: 'dt__col', type: 'button',
      'aria-pressed': String(view.cols.includes(key)),
    }, label);
    b.addEventListener('click', () => {
      const i = view.cols.indexOf(key);
      if (i === -1) view.cols.push(key); else view.cols.splice(i, 1);
      b.setAttribute('aria-pressed', String(view.cols.includes(key)));
      paint();
    });
    colBar.appendChild(b);
  }
  body.appendChild(colBar);

  const tableWrap = h('div', { class: 'dt__wrap' });
  body.appendChild(tableWrap);

  // ---------------------------------------------------------------- data
  function visible() {
    let out = rows;
    if (view.run) out = out.filter((r) => r.run === view.run);
    if (view.tier) out = out.filter((r) => r.effectiveTier === view.tier);
    if (view.onlyLeads) out = out.filter((r) => r.isLead);
    if (view.q) {
      out = out.filter((r) => [r.name, r.phone, r.website, r.city, r.email, r.category, r.address]
        .some((v) => String(v || '').toLowerCase().includes(view.q)));
    }
    const col = COL.get(view.sort);
    if (col) {
      const get = col[2];
      const numeric = col[3];
      out = [...out].sort((a, b) => {
        const av = get(a); const bv = get(b);
        let d;
        if (numeric) d = (Number(av) || 0) - (Number(bv) || 0);
        else d = String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true });
        return view.dir === 'desc' ? -d : d;
      });
    }
    return out;
  }

  function paint() {
    const list = visible();
    count.textContent = `${list.length} of ${rows.length}`;
    clear(tableWrap);

    const table = h('table', { class: 'dt__t' });
    const thead = h('thead');
    const tr = h('tr');
    for (const key of view.cols) {
      const col = COL.get(key);
      if (!col) continue;
      const th = h('th', { title: 'Sort by ' + col[1] }, col[1],
        view.sort === key ? h('span', { class: 'dt__arrow', text: view.dir === 'desc' ? '↓' : '↑' }) : null);
      th.addEventListener('click', () => {
        if (view.sort === key) view.dir = view.dir === 'desc' ? 'asc' : 'desc';
        else { view.sort = key; view.dir = col[3] ? 'desc' : 'asc'; }
        paint();
      });
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);

    const tbody = h('tbody');
    for (const r of list) {
      const row = h('tr');
      for (const key of view.cols) {
        const col = COL.get(key);
        if (!col) continue;
        const v = col[2](r);
        const cell = h('td', { class: col[3] ? 'dt__num' : '', title: String(v ?? '') });
        if (key === 'outcomeLabel' && r.outcome && r.outcome.status) {
          cell.appendChild(h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
            statusDot(r.outcome.status), h('span', { text: String(v) })));
        } else {
          cell.textContent = v === null || v === undefined ? '' : String(v);
        }
        row.appendChild(cell);
      }
      row.addEventListener('click', () => openPanel(r, { ...ctx, onChange: paint }));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  paint();
}

/** Export exactly what is on screen — same rows, same columns, same order. */
function downloadCsv(list, cols, ctx) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.map((k) => (COL.get(k) ? COL.get(k)[1] : k));
  const lines = [head.map(esc).join(',')];
  for (const r of list) lines.push(cols.map((k) => esc(COL.get(k) ? COL.get(k)[2](r) : '')).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: 'web-leads-data.csv' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  ctx.toast?.(`Downloaded ${list.length} row(s)`);
}
