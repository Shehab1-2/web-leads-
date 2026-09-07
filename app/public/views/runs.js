// Searches — every run the pipeline has made, what it cost, what it found and
// what it turned into. Layout follows design/Runs.dc.html.
//
// Nothing here is estimated silently. The tier bars are counted off the run's
// own CSV, the outcome tallies are the saved call outcomes, and the cost is
// max × USD_PER_PLACE with the basis printed next to it — an Apify list price,
// never an invoice. When a number is not on disk (older runs have no recorded
// request count) the screen says so instead of filling it in.

import { h, clear, icon, fmtShortDate } from '../dom.js';

export const meta = { title: 'Searches' };

// Mirrors USD_PER_PLACE in app/lib/apify.mjs. The lib/ modules are node-side
// and are not served to the browser, so the number is repeated, not imported.
const USD_PER_PLACE = 0.0015;

// Mirrors TIER_ORDER / TIER_LABEL in app/lib/rank.mjs, same reason.
const LEAD_TIERS = ['no_website', 'dead_site', 'social_only', 'free_host', 'very_dated', 'somewhat_dated'];

// The breakdown, in ramp order. Only rows with a count are drawn — a run with
// no free_host in it should not show an empty free_host bar.
const BREAKDOWN = [
  { tier: 'no_website', label: 'No website' },
  { tier: 'dead_site', label: 'Dead site' },
  { tier: 'social_only', label: 'Social only' },
  { tier: 'free_host', label: 'Free host' },
  { tier: 'very_dated', label: 'Very dated' },
  { tier: 'somewhat_dated', label: 'Somewhat dated' },
  { tier: 'needs_check', label: 'Not checked yet', muted: true },
  { tier: 'not_a_lead', label: 'Healthy — dropped', muted: true },
];

const OUTCOMES = [
  { status: 'interested', label: 'Interested' },
  { status: 'call_back', label: 'Call back' },
  { status: 'no_answer', label: 'No answer' },
  { status: 'not_interested', label: 'Not interested' },
];

// One live render at a time; destroy() marks it dead so an in-flight fetch
// cannot write into a detached DOM.
let session = null;

export function destroy() {
  if (session) session.dead = true;
  session = null;
}

// ----------------------------------------------------------------- utils

const effectiveTier = (lead) => lead.checked_tier || lead.tier || '';

function statusOf(value) {
  if (!value) return null;
  const s = typeof value === 'string' ? value : value.status;
  return s || null;
}

function numberOr(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sentence(s) {
  const t = String(s || '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

function msgOf(err) { return String(err && err.message ? err.message : err); }

function money(usd, digits = 2) {
  return `$${usd.toFixed(digits)}`;
}

/**
 * What the run cost. A recorded figure wins; otherwise it is the list price
 * times a count that really is on disk, and `basis` says which count.
 */
function costOf(runMeta, returned) {
  const recorded = numberOr(runMeta.costUsd, numberOr(runMeta.cost, null));
  if (recorded !== null) return { usd: recorded, basis: 'recorded for this run', estimated: false };

  const max = numberOr(runMeta.max, null);
  if (max && max > 0) {
    return { usd: max * USD_PER_PLACE, basis: `${max} requested × $0.0015 a place.`, estimated: true };
  }
  if (returned > 0) {
    return {
      usd: returned * USD_PER_PLACE,
      basis: `${returned} returned × $0.0015 a place — the number requested was never recorded for this run.`,
      estimated: true,
    };
  }
  return { usd: null, basis: 'Nothing came back, so there is nothing to price.', estimated: false };
}

/** Everything one row of the table needs, counted from that run's own leads. */
function summarize(run, detail, statuses) {
  const runMeta = { ...(run || {}), ...((detail && detail.meta) || {}) };
  const leads = Array.isArray(detail && detail.leads) ? detail.leads : [];
  const counts = {};
  for (const l of leads) {
    const t = effectiveTier(l);
    counts[t] = (counts[t] || 0) + 1;
  }
  const returned = leads.length || numberOr(run && run.total, 0) || 0;
  const leadCount = LEAD_TIERS.reduce((n, t) => n + (counts[t] || 0), 0);
  const dropped = counts.not_a_lead || 0;

  const tally = { called: 0, interested: 0, call_back: 0, no_answer: 0, not_interested: 0 };
  for (const l of leads) {
    if (!LEAD_TIERS.includes(effectiveTier(l))) continue;
    const st = statuses[l.place_id];
    if (!st) continue;
    tally.called += 1;
    if (tally[st] !== undefined) tally[st] += 1;
  }

  return {
    slug: (run && run.slug) || runMeta.slug || '',
    meta: runMeta,
    detail: detail || null,
    leads,
    counts,
    returned,
    leadCount,
    dropped,
    unchecked: Math.max(0, returned - leadCount - dropped),
    tally,
    cost: costOf(runMeta, returned),
    loaded: Boolean(detail),
    error: null,
  };
}

// ---------------------------------------------------------------- render

export async function render(root, ctx) {
  const s = { dead: false };
  session = s;
  clear(root);

  root.appendChild(h('div', { class: 'eyebrow', text: 'web-leads  /  searches' }));
  root.appendChild(h('div', { class: 'head-row' },
    h('div', {},
      h('h1', { class: 'title', text: 'Searches' }),
      h('p', {
        class: 'subtitle',
        style: { maxWidth: '620px' },
        text: 'What each run cost, what it found, and what it turned into — so the next trade you pick is not a guess.',
      })),
    h('a', { class: 'btn btn--primary', href: '#/search' },
      icon('plus', { size: 15, stroke: '#fdf4ef', width: 2 }),
      h('span', { text: 'New search' }))));

  const bodySlot = h('div', { style: { marginTop: '36px' } });
  root.appendChild(bodySlot);
  bodySlot.appendChild(loadingBlock());

  let runs;
  try {
    const data = await ctx.api.runs();
    runs = Array.isArray(data.runs) ? data.runs : [];
  } catch (err) {
    if (s.dead) return;
    clear(bodySlot);
    bodySlot.appendChild(errorBlock(err, () => render(root, ctx)));
    return;
  }
  if (s.dead) return;

  if (!runs.length) {
    clear(bodySlot);
    bodySlot.appendChild(noRunsBlock());
    return;
  }

  // One detail request per run. The list endpoint carries the run's row count
  // but not its tiers or its verdicts, and both the breakdown and the
  // cross-run comparison are counted from the leads themselves.
  const settled = await Promise.allSettled(runs.map((r) => ctx.api.run(r.slug)));
  if (s.dead) return;

  const statuses = {};
  for (const [id, value] of Object.entries((ctx.state && ctx.state.statuses) || {})) {
    const st = statusOf(value);
    if (st) statuses[id] = st;
  }

  const rows = runs.map((run, i) => {
    const got = settled[i];
    const row = summarize(run, got.status === 'fulfilled' ? got.value : null, statuses);
    if (got.status === 'rejected') row.error = msgOf(got.reason);
    return row;
  });

  clear(bodySlot);
  bodySlot.appendChild(screen(rows, ctx));
}

// ---------------------------------------------------------------- screen

function screen(rows, ctx) {
  const view = h('div', {});
  const activeSlug = ctx.state && ctx.state.activeRun ? ctx.state.activeRun.slug : null;
  let selected = rows.find((r) => r.slug === activeSlug) || rows[0];
  // The breakdown picker only earns a column once there is a second run to
  // switch to; with one run the table keeps the artboard's six columns.
  const multi = rows.length > 1;

  // ------------------------------------------------------------- table
  view.appendChild(h('div', { class: 'thead' },
    h('span', { style: { width: '100px', flexShrink: '0' }, text: 'Date' }),
    h('span', { style: { flex: '1' }, text: 'Trade and town' }),
    h('span', { style: { width: '110px', flexShrink: '0', textAlign: 'right' }, text: 'Returned' }),
    h('span', { style: { width: '90px', flexShrink: '0', textAlign: 'right' }, text: 'Leads' }),
    h('span', { style: { width: '90px', flexShrink: '0', textAlign: 'right' }, text: 'Dropped' }),
    h('span', { style: { width: '90px', flexShrink: '0', textAlign: 'right' }, text: 'Cost' }),
    multi ? h('span', { style: { width: '106px', flexShrink: '0' } }) : null));

  const tableSlot = h('div', {});
  view.appendChild(tableSlot);

  view.appendChild(h('p', {
    class: 'hint',
    style: { marginTop: '12px' },
    text: 'Cost is the Apify list price of $0.0015 a place, not an invoice. Clicking a row opens that call list.',
  }));

  // --------------------------------------------------- selected run panel
  const detailSlot = h('div', { style: { marginTop: '44px' } });
  view.appendChild(detailSlot);

  // ---------------------------------------------------- cross-run panel
  view.appendChild(comparison(rows));

  function paintTable() {
    clear(tableSlot);
    rows.forEach((row) => tableSlot.appendChild(tableRow(row, row === selected, multi, ctx, select)));
  }

  function paintDetail() {
    clear(detailSlot);
    detailSlot.appendChild(runDetail(selected, rows, ctx, select));
  }

  function select(row) {
    if (row === selected) return;
    selected = row;
    paintTable();
    paintDetail();
  }

  paintTable();
  paintDetail();
  return view;
}

// ------------------------------------------------------------- the table

function tableRow(row, isSelected, multi, ctx, select) {
  const runMeta = row.meta || {};
  const target = row.slug ? `#/leads/${encodeURIComponent(row.slug)}` : null;
  const open = () => { if (target) ctx.navigate(target); };

  const cell = (width, node, extra = {}) => h('span', {
    style: { width, flexShrink: '0', textAlign: 'right', ...extra },
  }, node);

  const returned = h('span', { class: 'tnum', style: { fontSize: '14px', color: 'var(--ink-2)' } },
    h('span', { text: String(row.returned) }),
    numberOr(runMeta.max, null)
      ? h('span', { style: { color: 'var(--ink-4)', fontSize: '12.5px' }, text: ` of ${numberOr(runMeta.max)}` })
      : null);

  const el = h('div', {
    class: `trow${isSelected ? ' trow--tinted' : ''}`,
    role: 'link',
    tabindex: '0',
    'aria-label': `${sentence(runMeta.niche) || row.slug} — open the call list`,
    style: {
      cursor: target ? 'pointer' : 'default',
      ...(isSelected ? { padding: '16px 18px' } : {}),
    },
    onClick: open,
    onKeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    },
  },
    h('span', {
      class: 'mono',
      style: { width: '100px', flexShrink: '0', fontSize: '13px', color: 'var(--ink-2)' },
    }, fmtShortDate(runMeta.date) || '—'),
    h('span', { style: { flex: '1', minWidth: '0', fontSize: '14.5px' } },
      h('span', { style: { fontWeight: '600' }, text: sentence(runMeta.niche) || row.slug }),
      runMeta.location ? h('span', { style: { color: 'var(--ink-3)' }, text: ` · ${runMeta.location}` }) : null),
    cell('110px', returned),
    cell('90px', row.loaded
      ? h('span', { class: 'tnum', style: { fontSize: '15px', fontWeight: '600' }, text: String(row.leadCount) })
      : h('span', { style: { color: 'var(--ink-4)' }, text: '—' })),
    cell('90px', row.loaded
      ? h('span', { class: 'tnum', style: { fontSize: '14px', color: 'var(--ink-3)' }, text: String(row.dropped) })
      : h('span', { style: { color: 'var(--ink-4)' }, text: '—' })),
    cell('90px', h('span', {
      class: 'mono tnum',
      style: { fontSize: '14px' },
      text: row.cost.usd === null ? '—' : money(row.cost.usd),
    })));

  // Selecting for the breakdown is a separate affordance: a click on the row
  // itself opens the call list, which is what a row click is for.
  if (multi) {
    el.appendChild(h('span', { style: { width: '106px', flexShrink: '0', display: 'flex', justifyContent: 'flex-end' } },
      isSelected
        ? h('span', { style: { fontSize: '12.5px', color: 'var(--ink-4)' }, text: 'Shown below' })
        : h('button', {
          type: 'button',
          class: 'chip',
          onClick: (e) => { e.stopPropagation(); select(row); },
          onKeydown: (e) => e.stopPropagation(),
        }, 'Breakdown')));
  }

  if (row.error) {
    const wrap = h('div', {}, el);
    wrap.appendChild(h('p', {
      style: { fontSize: '12.5px', color: 'var(--accent)', padding: '0 0 10px' },
      text: `This run's rows did not load — ${row.error}`,
    }));
    return wrap;
  }
  return el;
}

// ------------------------------------------------------- selected run

function runDetail(row, rows, ctx, select) {
  const wrap = h('div', { style: { display: 'flex', gap: '72px', flexWrap: 'wrap', alignItems: 'flex-start' } });
  const left = h('div', { style: { flex: '1', minWidth: '340px' } });
  const right = h('div', { style: { width: '320px', flexShrink: '0' } });
  wrap.appendChild(left);
  wrap.appendChild(right);

  // A switcher only makes sense once there is something to switch between.
  const heading = h('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '24px', flexWrap: 'wrap' },
  }, h('div', { class: 'eyebrow', text: 'What this run found' }));
  if (rows.length > 1) {
    const chips = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    for (const r of rows) {
      chips.appendChild(h('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': r === row ? 'true' : 'false',
        onClick: () => select(r),
      }, sentence(r.meta.niche) || r.slug,
        r.meta.date ? h('span', { class: 'chip__count', text: fmtShortDate(r.meta.date) }) : null));
    }
    heading.appendChild(chips);
  }
  left.appendChild(heading);

  if (!row.loaded) {
    left.appendChild(h('div', { class: 'empty', style: { marginTop: '18px' } },
      icon('alert', { size: 20, stroke: '#bcb2a0', width: 1.7 }),
      h('div', { class: 'empty__title', text: 'This run did not load' }),
      h('p', {
        class: 'empty__body',
        style: { maxWidth: '420px', margin: '7px auto 0' },
        text: row.error
          ? `${row.error}. Nothing is counted here rather than guessed at.`
          : 'Its rows could not be read, so there is nothing to count.',
      })));
    right.appendChild(outcomesCard(row));
    return wrap;
  }

  const shown = BREAKDOWN.map((b) => ({ ...b, count: b.tier === 'needs_check' ? row.unchecked : (row.counts[b.tier] || 0) }))
    .filter((b) => b.count > 0);

  const bars = h('div', { style: { marginTop: '20px' } });
  if (!shown.length) {
    bars.appendChild(h('p', {
      style: { fontSize: '13px', lineHeight: '1.6', color: 'var(--ink-3)' },
      text: 'This run has no rows in it, so there is nothing to break down.',
    }));
  } else {
    for (const b of shown) bars.appendChild(bar(b, row.returned));
  }
  left.appendChild(bars);
  left.appendChild(h('p', {
    style: { marginTop: '20px', fontSize: '13px', lineHeight: '1.6', color: 'var(--ink-3)', maxWidth: '520px' },
    text: ratioLine(row),
  }));

  right.appendChild(outcomesCard(row));
  right.appendChild(costCard(row));
  right.appendChild(runActions(row, ctx));
  return wrap;
}

/**
 * Export the finished call list, or delete the run. Deleting keeps
 * seen_leads and the outcomes log — the businesses were still seen, the
 * calls were still made — so it asks once, plainly, and says exactly that.
 */
function runActions(row, ctx) {
  const slug = row.slug;
  const del = h('button', { class: 'btn btn--quiet', type: 'button' },
    icon('x', { size: 13, width: 2.2 }), 'Delete this run');
  del.addEventListener('click', async () => {
    const label = sentence(row.meta.niche) || slug;
    if (!window.confirm(`Delete "${label}"? Its call list and site checks go away. Call history and logged outcomes are kept.`)) return;
    del.disabled = true;
    try {
      await ctx.api.deleteRun(slug);
      ctx.toast('Run deleted — history kept');
      await ctx.refresh();
      ctx.navigate('#/runs');
    } catch (err) {
      del.disabled = false;
      ctx.toast(String(err.message || err), 'err');
    }
  });
  return h('div', { class: 'panel', style: { marginTop: '18px' } },
    h('div', { class: 'eyebrow', text: 'This run' }),
    h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '14px' } },
      h('a', { class: 'btn btn--outline btn--sm', href: ctx.api.exportUrl(slug, 'md'), download: true },
        icon('download', { size: 13 }), 'Call list (.md)'),
      h('a', { class: 'btn btn--outline btn--sm', href: ctx.api.exportUrl(slug, 'csv'), download: true },
        icon('download', { size: 13 }), 'Rows (.csv)')),
    h('div', { style: { marginTop: '12px' } }, del));
}

/** One proportional bar. Colour comes from the tier ramp in design.css. */
function bar(b, total) {
  const pct = total > 0 ? Math.min(100, (b.count / total) * 100) : 0;
  const fill = h('span', {
    class: `swatch swatch--${b.tier}`,
    style: {
      display: 'block',
      width: `${pct}%`,
      height: '16px',
      borderRadius: '2px',
      ...(b.tier === 'not_a_lead' ? { borderStyle: 'dashed', borderColor: '#cfc6b4' } : {}),
    },
  });
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: '18px', padding: '8px 0' } },
    h('span', {
      style: { width: '132px', flexShrink: '0', fontSize: '13.5px', color: b.muted ? 'var(--ink-4)' : 'var(--ink-2)' },
      text: b.label,
    }),
    h('span', {
      'aria-hidden': 'true',
      style: {
        flex: '1', maxWidth: '400px', height: '16px', borderRadius: '2px',
        background: 'var(--rule-soft)', overflow: 'hidden',
      },
    }, fill),
    h('span', {
      class: 'tnum',
      style: { fontSize: '14px', fontWeight: b.muted ? '400' : '600', color: b.muted ? 'var(--ink-4)' : 'var(--ink)' },
      text: String(b.count),
    }));
}

/** The one sentence worth carrying between trades, counted not guessed. */
function ratioLine(row) {
  if (!row.leadCount) {
    return row.returned
      ? `Nothing in this run reached a lead tier${row.unchecked ? ` — ${row.unchecked} still need the site check` : ''}.`
      : 'This run returned no businesses.';
  }
  const noSite = (row.counts.no_website || 0) + (row.counts.dead_site || 0) + (row.counts.social_only || 0);
  if (!noSite) {
    return `Every one of the ${row.leadCount} leads here has a working site of its own, so each call is about `
      + 'replacing something rather than starting from nothing.';
  }
  return `${noSite} of the ${row.leadCount} leads have no working site of their own — nothing listed, a domain that will `
    + 'not load, or a page on someone else\'s platform. That ratio is the thing to watch across trades; it is what makes '
    + 'a town worth the drive.';
}

function outcomesCard(row) {
  const { tally, leadCount } = row;
  const card = h('div', { class: 'card', style: { marginTop: '20px' } });

  card.appendChild(h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px' } },
    h('span', {
      class: 'serif tnum',
      style: { fontSize: '40px', lineHeight: '1' },
      text: String(tally.called),
    }),
    h('span', {
      style: { fontSize: '13.5px', color: '#6b6558' },
      text: leadCount ? `of ${leadCount} called so far` : 'calls logged',
    })));

  const body = h('div', { style: { marginTop: '18px', paddingTop: '16px', borderTop: '1px solid var(--rule-soft)' } });
  if (!leadCount) {
    body.appendChild(h('p', {
      style: { fontSize: '12.5px', lineHeight: '1.6', color: 'var(--ink-3)' },
      text: 'No lead in this run is worth a call yet, so there is nothing to work through.',
    }));
  } else if (!tally.called) {
    body.appendChild(h('p', {
      style: { fontSize: '12.5px', lineHeight: '1.6', color: 'var(--ink-3)' },
      text: 'No outcome has been saved for this run yet. They are logged from the call list, one row at a time.',
    }));
    body.appendChild(outcomeLine('Still to call', leadCount, true, '10px'));
  } else {
    for (const o of OUTCOMES) {
      if (!tally[o.status]) continue;
      body.appendChild(outcomeLine(o.label, tally[o.status], false));
    }
    body.appendChild(outcomeLine('Still to call', Math.max(0, leadCount - tally.called), true));
  }
  card.appendChild(body);

  return h('div', {},
    h('div', { class: 'eyebrow', text: 'What it turned into' }),
    card);
}

function outcomeLine(label, count, muted, marginTop) {
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 0', fontSize: '13.5px', ...(marginTop ? { marginTop } : {}),
    },
  },
    h('span', { style: { color: muted ? 'var(--ink-4)' : 'var(--ink-2)' }, text: label }),
    h('span', {
      class: 'tnum',
      style: { fontWeight: muted ? '400' : '600', color: muted ? 'var(--ink-3)' : 'var(--ink)' },
      text: String(count),
    }));
}

function costCard(row) {
  const { cost, leadCount } = row;
  const perLead = cost.usd !== null && leadCount > 0 ? cost.usd / leadCount : null;
  return h('div', { class: 'card', style: { marginTop: '18px', padding: '18px 22px' } },
    h('div', { style: { fontSize: '12.5px', color: 'var(--ink-3)' }, text: 'Cost per lead' }),
    h('div', {
      class: 'mono tnum',
      style: { marginTop: '7px', fontSize: '26px', fontWeight: '500' },
      text: perLead === null ? '—' : money(perLead, 3),
    }),
    h('p', {
      style: { marginTop: '7px', fontSize: '12.5px', lineHeight: '1.55', color: 'var(--ink-4)' },
      text: cost.usd === null
        ? cost.basis
        : perLead === null
          ? `${money(cost.usd)} ${cost.estimated ? 'estimated' : 'recorded'} for the run — no lead came out of it yet.`
          : `${money(cost.usd)} ${cost.estimated ? 'estimated' : 'recorded'} for the run, ${leadCount} `
            + `${leadCount === 1 ? 'lead' : 'leads'} out.`,
    }),
    cost.usd !== null && cost.estimated
      ? h('p', {
        style: { marginTop: '5px', fontSize: '11.5px', lineHeight: '1.5', color: 'var(--ink-5)' },
        text: cost.basis,
      })
      : null);
}

// -------------------------------------------------------- cross-run panel

function comparison(rows) {
  const loaded = rows.filter((r) => r.loaded);
  if (loaded.length < 2) return comparisonEmpty(rows.length);

  const wrap = h('div', { style: { marginTop: '48px' } });
  wrap.appendChild(h('div', { class: 'eyebrow', text: 'Which trades and towns are worth it' }));
  wrap.appendChild(h('p', {
    style: { marginTop: '10px', marginBottom: '18px', fontSize: '13px', lineHeight: '1.6', color: 'var(--ink-3)', maxWidth: '620px' },
    text: 'No-website rate is the share of everything the search returned that has no site listed at all. Interested rate '
      + 'is out of the calls actually made in that run, so it only means something once the calling has started.',
  }));

  wrap.appendChild(h('div', { class: 'thead' },
    h('span', { style: { flex: '1' }, text: 'Trade and town' }),
    h('span', { style: { width: '210px', flexShrink: '0' }, text: 'No website' }),
    h('span', { style: { width: '210px', flexShrink: '0' }, text: 'Interested' })));

  for (const r of loaded) {
    const noSite = r.counts.no_website || 0;
    const interested = r.tally.interested;
    wrap.appendChild(h('div', { class: 'trow' },
      h('span', { style: { flex: '1', minWidth: '0', fontSize: '14px' } },
        h('span', { style: { fontWeight: '600' }, text: sentence(r.meta.niche) || r.slug }),
        r.meta.location ? h('span', { style: { color: 'var(--ink-3)' }, text: ` · ${r.meta.location}` }) : null),
      rateCell(noSite, r.returned, 'no_website', `${noSite} of ${r.returned} returned`),
      r.tally.called
        ? rateCell(interested, r.tally.called, 'no_website', `${interested} of ${r.tally.called} called`)
        : h('span', {
          style: { width: '210px', flexShrink: '0', fontSize: '12.5px', color: 'var(--ink-4)' },
          text: 'Not called yet',
        })));
  }
  return wrap;
}

function rateCell(count, total, tier, caption) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return h('span', { style: { width: '210px', flexShrink: '0' } },
    h('span', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
      h('span', {
        'aria-hidden': 'true',
        style: {
          flex: '1', height: '10px', borderRadius: '2px', background: 'var(--rule-soft)',
          overflow: 'hidden', maxWidth: '110px',
        },
      }, h('span', {
        class: `swatch swatch--${tier}`,
        style: { display: 'block', width: `${pct}%`, height: '10px', borderRadius: '2px' },
      })),
      h('span', { class: 'tnum', style: { fontSize: '14px', fontWeight: '600' }, text: `${Math.round(pct)}%` })),
    h('span', {
      class: 'tnum',
      style: { display: 'block', marginTop: '3px', fontSize: '12px', color: 'var(--ink-4)' },
      text: caption,
    }));
}

/** Honest until a second search exists — no placeholder chart, no fake trend. */
function comparisonEmpty(runCount) {
  const glyph = h('div', { style: { display: 'flex', gap: '7px', alignItems: 'flex-end', flexShrink: '0' } },
    [26, 44, 34, 56].map((height, i) => h('span', {
      style: {
        width: '14px', height: `${height}px`, borderRadius: '2px',
        background: ['#e9e3d7', '#e2dacb', '#e9e3d7', '#ddd4c4'][i],
      },
    })));

  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: '26px', marginTop: '40px',
      padding: '26px 30px', border: '1px dashed #d8cfbd', borderRadius: '6px',
    },
  }, glyph,
    h('div', {},
      h('div', { style: { fontSize: '14.5px', fontWeight: '600', color: 'var(--ink-2)' }, text: 'Which trades and towns are worth it' }),
      h('p', {
        style: { marginTop: '7px', fontSize: '13px', lineHeight: '1.6', color: 'var(--ink-3)', maxWidth: '620px' },
        text: runCount === 1
          ? 'Comparison needs a second search. Once another trade or another town is in, this is where the no-website rate '
            + 'and the interested rate sit side by side.'
          : 'Comparison needs two runs whose rows can be read. Only one loaded, so there is nothing to put side by side yet.',
      })));
}

// ------------------------------------------------------- loading / empty

function loadingBlock() {
  return h('div', {},
    h('div', { class: 'skeleton', style: { height: '13px', width: '100%' } }),
    [0, 1, 2].map((i) => h('div', {
      class: 'skeleton',
      style: { height: '42px', marginTop: '12px', opacity: String(1 - i * 0.22) },
    })),
    h('div', { style: { display: 'flex', gap: '72px', marginTop: '44px', flexWrap: 'wrap' } },
      h('div', { class: 'skeleton', style: { height: '220px', flex: '1', minWidth: '340px' } }),
      h('div', { class: 'skeleton', style: { height: '220px', width: '320px' } })));
}

function errorBlock(err, retry) {
  return h('div', {},
    h('div', { class: 'empty' },
      icon('alert', { size: 22, stroke: '#bcb2a0', width: 1.7 }),
      h('div', { class: 'empty__title', text: 'The list of searches did not load' }),
      h('p', {
        class: 'empty__body',
        style: { maxWidth: '440px', margin: '7px auto 0' },
        text: msgOf(err),
      })),
    h('div', { style: { display: 'flex', gap: '12px', marginTop: '22px' } },
      h('button', { class: 'btn btn--outline', type: 'button', onClick: retry }, 'Try again'),
      h('a', { class: 'btn btn--quiet', href: '#/search' }, 'Start a search')));
}

function noRunsBlock() {
  return h('div', {},
    h('div', { class: 'empty' },
      icon('search', { size: 22, stroke: '#bcb2a0', width: 1.7 }),
      h('div', { class: 'empty__title', text: 'No searches yet' }),
      h('p', {
        class: 'empty__body',
        style: { maxWidth: '440px', margin: '7px auto 0' },
        text: 'Nothing has been pulled from Google Maps on this machine. Pick a trade and a town — a 20-business run '
          + 'costs about two cents of the Apify free credit.',
      })),
    h('a', { class: 'btn btn--primary', style: { marginTop: '26px' }, href: '#/search' },
      icon('plus', { size: 15, stroke: '#fdf4ef', width: 2 }),
      h('span', { text: 'New search' })));
}
