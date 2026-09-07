// Call list — the screen a morning of calling is worked from.
//
// Strongest lead first, healthy sites cut from the list entirely: they get
// named in the quiet "dropped" footer next to the caveat about what was
// actually checked, never as rows padding the call order.
//
// The tier ramp below mirrors app/lib/rank.mjs. The server serves app/public/
// only, so app/lib is not importable here; the order and labels are duplicated
// deliberately rather than fetched.

import {
  h, clear, icon, meta as metaRow, ratingBits, statusDot,
  STATUS_LABEL, fmtDate,
} from '../dom.js';

import { openPanel, closePanel } from '../panel.js';

export const meta = { title: 'Call list' };

// --------------------------------------------------------------- tiers

const TIER_ORDER = [
  'no_website', 'dead_site', 'social_only', 'free_host', 'very_dated', 'somewhat_dated',
];

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

const OUTCOMES = ['no_answer', 'call_back', 'not_interested', 'interested'];

const tierRank = (tier) => {
  const i = TIER_ORDER.indexOf(tier);
  return i === -1 ? TIER_ORDER.length + 1 : i;
};
const isLead = (tier) => TIER_ORDER.includes(tier);
const effectiveTier = (lead) => lead.checked_tier || lead.tier || '';

/** Strongest tier first, busiest shop first inside a tier — rankLeads semantics. */
function rankLeads(leads) {
  return [...leads].sort((a, b) => {
    const d = tierRank(effectiveTier(a)) - tierRank(effectiveTier(b));
    if (d !== 0) return d;
    return (Number(b.reviews) || 0) - (Number(a.reviews) || 0);
  });
}

/** /api/state and /api/outcome may hand back either the plain status or the record. */
function statusOf(value) {
  if (!value) return null;
  const s = typeof value === 'string' ? value : value.status;
  return s || null;
}

/** "147 Stelton Rd, Piscataway, NJ 08854" -> "147 Stelton Rd", keeping an out-of-town line. */
function streetOf(lead, location) {
  const address = String(lead.address || '');
  if (!address) return '';
  const street = address.split(',')[0].trim();
  const city = String(lead.city || '').trim();
  if (city && !String(location || '').toLowerCase().includes(city.toLowerCase())) {
    return `${street}, ${city}`;
  }
  return street;
}

function sentence(s) {
  const t = String(s || '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

// ------------------------------------------------------- outcome menu

let openState = null;

function closeMenu() {
  if (!openState) return;
  const { el, onDown, onKey, onMove } = openState;
  el.remove();
  document.removeEventListener('pointerdown', onDown, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onMove);
  window.removeEventListener('scroll', onMove, true);
  openState = null;
}

function openOutcomeMenu(anchor, current, onPick) {
  closeMenu();
  const el = h('div', { class: 'menu', role: 'menu' },
    OUTCOMES.map((status) => h('button', {
      type: 'button',
      role: 'menuitem',
      onClick: (e) => { e.stopPropagation(); closeMenu(); onPick(status); },
    },
      statusDot(status),
      h('span', { text: STATUS_LABEL[status] }),
      status === current
        ? h('span', { style: { marginLeft: 'auto', display: 'inline-flex' } }, icon('check', { size: 13, stroke: '#8d8577' }))
        : null)));

  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const left = Math.max(8, r.right - width) + window.scrollX;
  const below = r.bottom + height + 12 <= window.innerHeight;
  const top = (below ? r.bottom + 6 : Math.max(8, r.top - height - 6)) + window.scrollY;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') { closeMenu(); anchor.focus(); } };
  const onMove = () => closeMenu();
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onMove);
  window.addEventListener('scroll', onMove, true);
  openState = { el, anchor, onDown, onKey, onMove };
  el.querySelector('button')?.focus();
}

function statusChip(status, onClick) {
  const set = Boolean(status);
  return h('button', {
    type: 'button',
    class: `status${set ? ' status--set' : ''}${status === 'interested' ? ' status--interested' : ''}`,
    'aria-haspopup': 'menu',
    onClick,
  },
    statusDot(status),
    h('span', { text: set ? STATUS_LABEL[status] : 'Not called' }),
    icon('chevronDown', { size: 9, stroke: '#b3aa98', width: 2.6 }));
}

// ------------------------------------------------------------- render

export async function render(root, ctx) {
  clear(root);
  root.appendChild(loadingPane());

  let data;
  try {
    data = await ctx.api.run(ctx.slug);
  } catch (err) {
    clear(root);
    root.appendChild(errorPane(err, ctx, () => render(root, ctx)));
    return;
  }

  clear(root);
  root.appendChild(screen(data, ctx));
}

export function destroy() {
  closeMenu();
  closePanel();
}

function loadingPane() {
  return h('div', {},
    h('div', { class: 'eyebrow', text: 'web-leads  /  call list' }),
    h('div', { class: 'skeleton', style: { height: '52px', width: '440px', marginTop: '20px' } }),
    h('div', { class: 'skeleton', style: { height: '14px', width: '300px', marginTop: '16px' } }),
    h('div', { style: { marginTop: '40px' } },
      [0, 1, 2, 3, 4].map((i) => h('div', {
        class: 'skeleton',
        style: { height: '86px', marginTop: i ? '10px' : '0', opacity: String(1 - i * 0.16) },
      }))));
}

function errorPane(err, ctx, retry) {
  return h('div', {},
    h('div', { class: 'eyebrow', text: 'web-leads  /  call list' }),
    h('h1', { class: 'title', style: { marginTop: '16px' }, text: 'The call list did not load' }),
    h('p', { class: 'subtitle', text: String(err && err.message ? err.message : err) }),
    h('div', { style: { display: 'flex', gap: '12px', marginTop: '26px' } },
      h('button', { class: 'btn btn--outline', type: 'button', onClick: retry }, 'Try again'),
      h('a', { class: 'btn btn--quiet', href: '#/runs' }, 'All searches')));
}

// -------------------------------------------------------------- screen

function screen(data, ctx) {
  const runMeta = data.meta || {};
  const slug = runMeta.slug || ctx.slug;
  const all = rankLeads(data.leads || []);

  const callable = all.filter((l) => isLead(effectiveTier(l)));
  const dropped = all.filter((l) => effectiveTier(l) === 'not_a_lead');
  const pending = all.filter((l) => !isLead(effectiveTier(l)) && effectiveTier(l) !== 'not_a_lead');
  const checkedLeads = all.filter((l) => l.check
    || (l.tier === 'needs_check' && l.checked_tier && l.checked_tier !== 'needs_check'));

  const counts = {};
  for (const l of callable) {
    const t = effectiveTier(l);
    counts[t] = (counts[t] || 0) + 1;
  }
  const rankOf = new Map(callable.map((l, i) => [l.place_id, i + 1]));

  // Local mirror of the call statuses so a saved outcome repaints without a
  // full reload; the server stays the source of truth.
  const statuses = {};
  for (const [id, value] of Object.entries(ctx.state?.statuses || {})) {
    const s = statusOf(value);
    if (s) statuses[id] = s;
  }

  const view = h('div', {});
  let filter = 'all';
  let query = '';
  let sortBy = 'rank'; // rank | reviews | name

  // ------------------------------------------------------------ header
  view.appendChild(h('div', {
    style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '40px' },
  },
    h('div', { class: 'eyebrow', text: 'web-leads  /  call list' }),
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '22px' } },
      h('span', {
        class: 'mono',
        style: { fontSize: '11px', color: 'var(--ink-5)' },
        text: `data/leads_${slug}.csv`,
      }),
      h('a', {
        href: '#/search',
        style: {
          fontSize: '13px', fontWeight: '500', color: 'var(--ink)',
          borderBottom: '1px solid var(--ink-6)', paddingBottom: '2px',
        },
      }, 'New search'))));

  const subtitleParts = [runMeta.location, fmtDate(runMeta.date), callable.length ? 'ranked strongest first' : null]
    .filter(Boolean).join('  ·  ');

  // The one thing this screen is for: working the phone. Everything else in
  // the header is context.
  const uncalled = callable.filter((l) => !l.outcome).length;
  view.appendChild(h('div', { class: 'head-row', style: { marginTop: '18px' } },
    h('div', {},
      h('h1', { class: 'title title--lg', text: sentence(runMeta.niche) || slug }),
      h('p', { class: 'subtitle', text: subtitleParts })),
    h('div', {
      style: {
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
        gap: '12px', paddingBottom: '4px',
      },
    },
      h('div', {
        style: {
          textAlign: 'right', fontSize: '13.5px', color: 'var(--ink-3)',
          lineHeight: '1.7',
        },
      },
        h('div', {
          text: all.length
            ? `${all.length} pulled  ·  ${checkedLeads.length
              ? `${checkedLeads.length} ${checkedLeads.length === 1 ? 'site' : 'sites'} checked`
              : 'no sites checked yet'}`
            : 'nothing pulled',
        }),
        all.length
          ? h('div', {
            style: { color: 'var(--ink-4)' },
            text: `${dropped.length} dropped as healthy  ·  ${callable.length} worth calling`,
          })
          : null),
      uncalled
        ? h('a', { class: 'btn btn--primary', href: `#/call/${encodeURIComponent(slug)}` },
          icon('phone', { size: 15, stroke: 'var(--accent-ink)' }),
          h('span', { text: `Start calling  ·  ${uncalled} to go` }))
        : null)));

  // ----------------------------------------------------- chips + summary
  const chipRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } });
  const summaryEl = h('div', {
    class: 'tnum',
    style: { fontSize: '12.5px', color: 'var(--ink-3)', whiteSpace: 'nowrap' },
  });

  // Nothing to filter or tally when no row reached a lead tier — the empty
  // state below says why, and a row of zeroes would only be noise.
  // Search, sort and export sit with the tally: find a lead by name while the
  // phone is ringing, reorder when review count matters more than tier, take
  // the working list with you.
  const searchEl = h('input', {
    class: 'field field--sm',
    type: 'search',
    placeholder: 'Find a lead',
    'aria-label': 'Find a lead by name, street or opener',
    style: { width: '190px', marginTop: '0' },
    onInput: (e) => { query = (e.target.value || '').trim().toLowerCase(); paintRows(); },
  });
  const sortEl = h('select', {
    class: 'field field--sm',
    'aria-label': 'Sort order',
    style: { width: 'auto', marginTop: '0' },
    onChange: (e) => { sortBy = e.target.value; paintRows(); },
  },
    h('option', { value: 'rank', text: 'Strongest first' }),
    h('option', { value: 'reviews', text: 'Most reviews' }),
    h('option', { value: 'name', text: 'Name A–Z' }));
  const exportBtn = h('button', {
    type: 'button', class: 'btn btn--quiet btn--sm',
    onClick: () => exportCsv(),
  }, icon('download', { size: 13 }), 'Export CSV');

  if (callable.length) {
    view.appendChild(h('div', {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '32px', marginTop: '34px', paddingBottom: '22px', flexWrap: 'wrap',
      },
    }, chipRow,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
        summaryEl, searchEl, sortEl, exportBtn)));
  }

  const rowsEl = h('div', { style: callable.length ? null : { marginTop: '34px' } });
  view.appendChild(rowsEl);

  if (pending.length) {
    view.appendChild(h('div', { class: 'note', style: { marginTop: '26px', maxWidth: '620px' } },
      h('div', { class: 'note__title' },
        icon('info', { size: 14, stroke: 'currentColor' }),
        h('span', {
          text: `${pending.length} ${pending.length === 1 ? 'site has' : 'sites have'} not been checked yet`,
        })),
      h('div', { class: 'note__body' },
        'Their tier still comes from the Maps listing alone, so they are held out of the call order rather than ranked on a guess. ',
        h('a', { href: `#/checking/${encodeURIComponent(slug)}` }, 'Check them now'),
        '.')));
  }

  if (all.length) view.appendChild(footer(dropped, checkedLeads, all));

  // ------------------------------------------------------------- paint
  function paintSummary() {
    clear(summaryEl);
    const tally = { not_called: 0, no_answer: 0, call_back: 0, not_interested: 0, interested: 0 };
    for (const l of callable) {
      const s = statuses[l.place_id];
      if (s && tally[s] !== undefined) tally[s] += 1;
      else tally.not_called += 1;
    }
    const parts = [];
    if (tally.not_called) parts.push(`${tally.not_called} not called`);
    for (const s of OUTCOMES) if (tally[s]) parts.push(`${tally[s]} ${STATUS_LABEL[s].toLowerCase()}`);
    summaryEl.textContent = callable.length ? parts.join('  ·  ') : '';
  }

  function paintChips() {
    clear(chipRow);
    chipRow.appendChild(chip('all', 'All', callable.length));
    for (const tier of TIER_ORDER) {
      if (!counts[tier]) continue;
      chipRow.appendChild(chip(tier, TIER_LABEL[tier], counts[tier]));
    }
  }

  function chip(value, label, count) {
    return h('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': filter === value ? 'true' : 'false',
      onClick: () => { filter = value; paintChips(); paintRows(); },
    }, label, h('span', { class: 'chip__count tnum', text: String(count) }));
  }

  function paintRows() {
    clear(rowsEl);
    closeMenu();

    if (!all.length) {
      rowsEl.appendChild(emptyBlock('search', 'This run has no rows',
        'The CSV for this search is empty. Run the search again, or pick another one from Searches.'));
      return;
    }
    if (!callable.length) {
      rowsEl.appendChild(emptyBlock('check', 'Nothing here is worth a call',
        dropped.length
          ? `Every site that was checked came back healthy — ${dropped.length} of them, listed below. Padding the list with those is what makes it stop being trusted.`
          : 'No row in this run has reached a lead tier yet. Check the sites first, then this list fills in.'));
      return;
    }

    let visible = filter === 'all' ? callable : callable.filter((l) => effectiveTier(l) === filter);
    if (query) {
      visible = visible.filter((l) => [l.name, l.reason, l.address, l.category]
        .some((v) => String(v || '').toLowerCase().includes(query)));
    }
    if (sortBy === 'reviews') {
      visible = [...visible].sort((a, b) => (Number(b.reviews) || 0) - (Number(a.reviews) || 0));
    } else if (sortBy === 'name') {
      visible = [...visible].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    }
    if (!visible.length) {
      rowsEl.appendChild(query
        ? emptyBlock('search', `Nothing matches “${query}”`,
          'No lead name, street, category or opener contains that. Clear the search to see the list again.')
        : emptyBlock('list', `No leads in ${TIER_LABEL[filter] || filter}`,
          'Nothing in this run scored that tier. Clear the filter to see the whole call order.'));
      return;
    }

    visible.forEach((lead, i) => {
      rowsEl.appendChild(leadRow(lead, rankOf.get(lead.place_id) || i + 1, i === visible.length - 1));
    });
  }

  /** The working list as a file — what is on screen right now (filter, search
   *  and sort applied), with the call status and note alongside. */
  function exportCsv() {
    let rows = filter === 'all' ? callable : callable.filter((l) => effectiveTier(l) === filter);
    if (query) {
      rows = rows.filter((l) => [l.name, l.reason, l.address, l.category]
        .some((v) => String(v || '').toLowerCase().includes(query)));
    }
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['rank', 'tier', 'name', 'phone', 'address', 'reviews', 'opener', 'status', 'note'];
    const lines = [header.join(',')];
    for (const l of rows) {
      lines.push([
        rankOf.get(l.place_id) || '', effectiveTier(l), l.name, l.phone, l.address,
        l.reviews ?? '', l.reason || '', statuses[l.place_id] || 'not_called',
        (l.outcome && l.outcome.note) || '',
      ].map(esc).join(','));
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `call-list-${slug}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    ctx.toast(`Exported ${rows.length} ${rows.length === 1 ? 'lead' : 'leads'}`);
  }

  function leadRow(lead, rank, isLast) {
    const tier = effectiveTier(lead);
    const status = statuses[lead.place_id] || null;
    const target = `#/leads/${encodeURIComponent(slug)}/${encodeURIComponent(lead.place_id)}`;
    // Opens beside the list rather than replacing it, so you keep your place.
    // The full-page route stays valid for deep links and for anyone who wants
    // it in its own tab (ctrl/cmd-click, or the "Open full page" link inside).
    const open = () => {
      closeMenu();
      openPanel({ ...lead, outcome: statuses[lead.place_id] || null, run: slug, fullPage: target },
        { ...ctx, onChange: () => paintRows() });
    };

    const row = h('div', {
      class: `lead${rank === 1 ? ' lead--top' : ''}${status ? ' lead--handled' : ''}`,
      role: 'link',
      tabindex: '0',
      'aria-label': `${lead.name || 'Unnamed business'} — open details`,
      style: { cursor: 'pointer', ...(isLast ? { borderBottom: '1px solid var(--rule)' } : {}) },
      onClick: open,
      onKeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      },
    });

    row.appendChild(h('div', { class: 'lead__rank', text: String(rank) }));

    const street = streetOf(lead, runMeta.location);
    const bits = ratingBits(lead);
    row.appendChild(h('div', { class: 'lead__main' },
      h('div', { class: 'lead__meta' },
        metaRow(h('span', { class: 'lead__name', text: lead.name || 'Unnamed business' }),
          lead.category || null,
          street || null),
        bits.length ? [h('span', { class: 'dot-sep', text: '·' }), bits] : null),
      lead.reason
        ? h('p', { class: 'lead__opener', text: lead.reason })
        : h('p', {
          class: 'lead__opener',
          style: { color: 'var(--ink-4)', fontStyle: 'italic' },
          text: 'No opener line was written for this row.',
        })));

    const chipSlot = h('div', { style: { display: 'flex' } });
    const side = h('div', { class: 'lead__side' },
      h('span', { class: `pill pill--${tier || 'needs_check'}`, text: TIER_LABEL[tier] || tier || 'Unknown' }),
      lead.phone
        ? h('div', { class: 'lead__phone tnum', text: lead.phone })
        : h('div', { class: 'lead__nophone' },
          icon('phoneOff', { size: 14, stroke: '#c4bba9', width: 1.8 }),
          'No phone listed'),
      chipSlot,
      // A note written in call mode surfaces here, so what they said is one
      // glance away next time the list is worked.
      lead.outcome && lead.outcome.note
        ? h('div', {
          class: 'serif',
          style: {
            fontSize: '13.5px', fontStyle: 'italic', color: 'var(--ink-3)',
            maxWidth: '230px', textAlign: 'right', lineHeight: '1.5',
          },
          text: `“${lead.outcome.note}”`,
        })
        : null);
    row.appendChild(side);

    mountChip(chipSlot, lead, row);
    return row;
  }

  function mountChip(slot, lead, row) {
    clear(slot);
    const status = statuses[lead.place_id] || null;
    const chipEl = statusChip(status, (e) => {
      e.stopPropagation();
      if (openState && openState.anchor === chipEl) { closeMenu(); return; }
      openOutcomeMenu(chipEl, status, (picked) => save(slot, lead, row, chipEl, picked));
    });
    chipEl.addEventListener('keydown', (e) => e.stopPropagation());
    slot.appendChild(chipEl);
  }

  async function save(slot, lead, row, chipEl, picked) {
    chipEl.setAttribute('aria-busy', 'true');
    chipEl.style.opacity = '0.5';
    try {
      const res = await ctx.api.outcome({ place_id: lead.place_id, status: picked, note: '' });
      const saved = statusOf(res && res.status) || picked;
      statuses[lead.place_id] = saved;
      row.classList.add('lead--handled');
      mountChip(slot, lead, row);
      paintSummary();
      ctx.toast(`${lead.name || 'Lead'} — ${STATUS_LABEL[saved] || saved}`);
      ctx.refresh().catch(() => { /* nav counts are cosmetic; the outcome is saved */ });
    } catch (err) {
      chipEl.removeAttribute('aria-busy');
      chipEl.style.opacity = '';
      ctx.toast(`Could not save that outcome — ${err.message}`, 'err');
    }
  }

  paintChips();
  paintSummary();
  paintRows();
  return view;
}

// -------------------------------------------------------------- pieces

function emptyBlock(iconName, title, body) {
  return h('div', { class: 'empty', style: { marginTop: '8px' } },
    icon(iconName, { size: 22, stroke: '#bcb2a0', width: 1.7 }),
    h('div', { class: 'empty__title', text: title }),
    h('p', { class: 'empty__body', style: { maxWidth: '460px', margin: '7px auto 0' }, text: body }));
}

/** The dropped list and the honest note about what stage 2 actually did.
 *  Neither is needed to decide who to call next, so both live behind a fold —
 *  the summary line carries the numbers, the detail is one tap away. */
function footer(dropped, checkedLeads, all) {
  const fold = h('details', { class: 'fold', style: { marginTop: '38px' } },
    h('summary', {},
      h('span', { class: 'fold__chev' },
        icon('chevronRight', { size: 11, stroke: 'var(--ink-4)', width: 2.2 })),
      h('span', {
        class: 'eyebrow',
        text: `${dropped.length} dropped as healthy  ·  what was actually checked`,
      })));

  const wrap = h('div', { style: { display: 'flex', gap: '72px', marginTop: '4px', flexWrap: 'wrap' } });

  const left = h('div', { style: { flex: '1', minWidth: '320px' } },
    h('div', { class: 'eyebrow', text: 'Dropped — not leads' }));
  const body = { fontSize: '13.5px', lineHeight: '1.75', color: '#6b6558', maxWidth: '460px' };

  if (dropped.length) {
    const list = h('div', { style: { marginTop: '10px', ...body } });
    for (const l of dropped) {
      list.appendChild(h('div', {
        text: l.reason ? `${l.name} — ${l.reason}` : `${l.name} — checked, no signals found.`,
      }));
    }
    left.appendChild(list);
  } else {
    left.appendChild(h('p', {
      style: { marginTop: '10px', ...body },
      text: checkedLeads.length
        ? 'Nothing was dropped — every site checked in this run scored at least one signal.'
        : 'Nothing dropped yet. Sites only get dropped once they have been checked and come back clean.',
    }));
  }

  const right = h('div', { style: { flex: '1', minWidth: '320px' } },
    h('div', { class: 'eyebrow', text: 'What was actually checked' }),
    h('p', { style: { marginTop: '10px', ...body, maxWidth: '520px' }, text: caveat(checkedLeads, all) }));

  wrap.appendChild(left);
  wrap.appendChild(right);
  fold.appendChild(wrap);
  return fold;
}

function caveat(checkedLeads, all) {
  const checks = checkedLeads.map((l) => l.check).filter(Boolean);
  if (!checkedLeads.length) {
    return `Nothing has been opened yet. All ${all.length} tiers here come from the Google Maps listing alone `
      + '— whether a website is listed, and whether it points at a social page or a free host.';
  }
  if (!checks.length) {
    return `${checkedLeads.length} ${checkedLeads.length === 1 ? 'site was' : 'sites were'} checked, but the `
      + 'per-signal detail is not on disk for this run, so the tiers below rest on the saved verdict line only.';
  }
  const base = 'HTTP only — load status, TLS, viewport meta, footer year, platform.';
  const unchecked = checks.filter((c) => (c.signals || []).some((s) => s.found === null)).length;
  if (unchecked) {
    return `${base} No browser was available to screenshot ${unchecked === checks.length ? 'these sites' : `${unchecked} of them`}, `
      + 'so those verdicts are the conservative floor rather than a full visual read.';
  }
  return `${base} The visual signals were checked as well, so these verdicts are a full read.`;
}
