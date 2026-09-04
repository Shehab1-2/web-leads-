// Site check — one lead's stage-2 detail: what was checked, what was found,
// how that adds up to the tier, and the opener line it produced.
//
// A signal with found === null was never checked. It is drawn as not checked,
// never as passed — the whole point of the screen is that the verdict says only
// what was actually observed.

import {
  h, clear, icon, meta as metaRow, ratingBits, statusDot,
  STATUS_LABEL, fmtDate, prettyHost,
} from '../dom.js';

export const meta = { title: 'Site check' };

// --------------------------------------------------------------- tiers

// Mirrors app/lib/rank.mjs — the server serves app/public/ only, so app/lib is
// not importable from the browser.
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

const VISUAL_IDS = new Set(['not_mobile_friendly', 'dated_design_era']);
const OBJECTIVE_IDS = new Set(['no_https', 'no_viewport', 'stale_copyright', 'broken_elements', 'untouched_template']);

const tierRank = (tier) => {
  const i = TIER_ORDER.indexOf(tier);
  return i === -1 ? TIER_ORDER.length + 1 : i;
};
const isLead = (tier) => TIER_ORDER.includes(tier);
const effectiveTier = (lead) => lead.checked_tier || lead.tier || '';

function rankLeads(leads) {
  return [...leads].sort((a, b) => {
    const d = tierRank(effectiveTier(a)) - tierRank(effectiveTier(b));
    if (d !== 0) return d;
    return (Number(b.reviews) || 0) - (Number(a.reviews) || 0);
  });
}

function statusOf(value) {
  if (!value) return null;
  const s = typeof value === 'string' ? value : value.status;
  return s || null;
}

// ------------------------------------------------------- outcome menu

let openState = null;
let keyNav = null;

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

  const all = rankLeads(data.leads || []);
  const lead = all.find((l) => l.place_id === ctx.placeId);
  clear(root);

  if (!lead) {
    root.appendChild(missingPane(ctx));
    return;
  }
  root.appendChild(screen(lead, all, data.meta || {}, ctx));
}

export function destroy() {
  closeMenu();
  if (keyNav) { document.removeEventListener('keydown', keyNav); keyNav = null; }
}

function loadingPane() {
  return h('div', {},
    h('div', { class: 'eyebrow', text: 'web-leads  /  site check' }),
    h('div', { class: 'skeleton', style: { height: '46px', width: '380px', marginTop: '22px' } }),
    h('div', { class: 'skeleton', style: { height: '13px', width: '320px', marginTop: '14px' } }),
    h('div', { style: { display: 'flex', gap: '80px', marginTop: '40px' } },
      h('div', { class: 'skeleton', style: { width: '340px', height: '420px', flexShrink: '0' } }),
      h('div', { style: { flex: '1' } },
        [0, 1, 2, 3, 4].map((i) => h('div', {
          class: 'skeleton',
          style: { height: '42px', marginTop: i ? '10px' : '0', opacity: String(1 - i * 0.15) },
        })))));
}

function errorPane(err, ctx, retry) {
  return h('div', {},
    h('div', { class: 'eyebrow', text: 'web-leads  /  site check' }),
    h('h1', { class: 'title', style: { marginTop: '16px' }, text: 'That check did not load' }),
    h('p', { class: 'subtitle', text: String(err && err.message ? err.message : err) }),
    h('div', { style: { display: 'flex', gap: '12px', marginTop: '26px' } },
      h('button', { class: 'btn btn--outline', type: 'button', onClick: retry }, 'Try again'),
      h('a', { class: 'btn btn--quiet', href: `#/leads/${encodeURIComponent(ctx.slug)}` }, 'Back to call list')));
}

function missingPane(ctx) {
  return h('div', {},
    backLink(ctx),
    h('h1', { class: 'title', style: { marginTop: '26px' }, text: 'Not in this run' }),
    h('p', { class: 'subtitle', text: 'No business with that place id is in this search — it may belong to a different run.' }),
    h('a', {
      class: 'btn btn--outline',
      style: { marginTop: '24px' },
      href: `#/leads/${encodeURIComponent(ctx.slug)}`,
    }, 'Back to call list'));
}

function backLink(ctx) {
  return h('a', {
    href: `#/leads/${encodeURIComponent(ctx.slug)}`,
    style: {
      display: 'inline-flex', alignItems: 'center', gap: '9px',
      fontSize: '13px', fontWeight: '500', color: 'var(--ink-2)',
    },
  }, icon('arrowLeft', { size: 15, stroke: '#8d8577' }), 'Back to call list');
}

// -------------------------------------------------------------- screen

function screen(lead, all, runMeta, ctx) {
  const slug = runMeta.slug || ctx.slug;
  const tier = effectiveTier(lead);
  const check = lead.check || null;
  const callable = all.filter((l) => isLead(effectiveTier(l)));
  const index = callable.findIndex((l) => l.place_id === lead.place_id);

  const view = h('div', {});

  // ------------------------------------------------------- top bar
  const goTo = (other) => ctx.navigate(`#/leads/${encodeURIComponent(slug)}/${encodeURIComponent(other.place_id)}`);
  const prev = index > 0 ? callable[index - 1] : null;
  const next = index >= 0 && index < callable.length - 1 ? callable[index + 1] : null;

  const arrow = (name, target, label) => h('button', {
    type: 'button',
    'aria-label': label,
    disabled: !target,
    style: {
      display: 'inline-flex', padding: '2px',
      cursor: target ? 'pointer' : 'default',
    },
    onClick: () => { if (target) goTo(target); },
  }, icon(name, { size: 15, stroke: target ? '#5c564a' : '#cfc6b4', width: 2 }));

  view.appendChild(h('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '40px' },
  },
    backLink(ctx),
    h('div', {
      class: 'tnum',
      style: { display: 'inline-flex', alignItems: 'center', gap: '16px', fontSize: '12.5px', color: 'var(--ink-3)' },
    },
      h('span', {
        text: index >= 0
          ? `Lead ${index + 1} of ${callable.length}`
          : `Not in the call list  ·  ${TIER_LABEL[tier] || tier || 'untiered'}`,
      }),
      h('span', { style: { display: 'inline-flex', gap: '8px' } },
        arrow('chevronLeft', prev, 'Previous lead'),
        arrow('chevronRight', next, 'Next lead')))));

  if (index >= 0) {
    if (keyNav) document.removeEventListener('keydown', keyNav);
    keyNav = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft' && prev) { e.preventDefault(); goTo(prev); }
      if (e.key === 'ArrowRight' && next) { e.preventDefault(); goTo(next); }
    };
    document.addEventListener('keydown', keyNav);
  }

  // --------------------------------------------------------- heading
  view.appendChild(h('div', {
    style: { display: 'flex', alignItems: 'baseline', gap: '18px', marginTop: '26px', flexWrap: 'wrap' },
  },
    h('h1', { class: 'title', text: lead.name || 'Unnamed business' }),
    h('span', { class: `pill pill--${tier || 'needs_check'}`, text: TIER_LABEL[tier] || tier || 'Unknown' })));

  const bits = ratingBits(lead);
  view.appendChild(h('div', { class: 'lead__meta', style: { marginTop: '12px', fontSize: '13.5px' } },
    metaRow(lead.category || null, lead.address || null),
    bits.length ? [h('span', { class: 'dot-sep', text: '·' }), bits] : null));

  // ---------------------------------------------------------- columns
  const cols = h('div', {
    style: {
      display: 'flex', gap: '80px', marginTop: '38px', paddingTop: '34px',
      borderTop: '1px solid var(--rule)', flexWrap: 'wrap',
    },
  });
  cols.appendChild(leftColumn(lead, check, tier, slug));
  cols.appendChild(rightColumn(lead, check, tier, runMeta, ctx));
  view.appendChild(cols);

  return view;
}

// --------------------------------------------------- left: screenshot

function leftColumn(lead, check, tier, slug) {
  const col = h('div', { style: { width: '340px', flexShrink: '0' } });
  col.appendChild(h('div', { class: 'eyebrow', text: 'Site at phone width  ·  390 px' }));

  const shot = shotState(lead, check, tier, slug);
  col.appendChild(h('div', {
    class: 'empty',
    style: {
      marginTop: '12px', width: '340px', height: '600px', background: 'var(--tint)',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: '13px', padding: '0 40px',
    },
  },
    icon('eyeOff', { size: 28, stroke: '#bcb2a0', width: 1.6 }),
    h('div', { class: 'empty__title', style: { marginTop: '0', fontSize: '14.5px' }, text: shot.title }),
    h('p', { class: 'empty__body', style: { marginTop: '0', maxWidth: '215px' }, text: shot.body }),
    shot.link
      ? h('a', { href: shot.link, style: { fontSize: '12.5px', fontWeight: '500' }, text: shot.linkLabel })
      : null));

  const url = (check && (check.finalUrl || check.url)) || lead.website || '';
  if (url) {
    col.appendChild(h('a', {
      href: url,
      target: '_blank',
      rel: 'noopener noreferrer',
      style: {
        display: 'flex', alignItems: 'center', gap: '9px', marginTop: '15px',
        fontFamily: 'var(--mono)', fontSize: '12.5px', color: 'var(--ink-2)',
      },
    }, h('span', { text: prettyHost(url) }), icon('external', { size: 12, stroke: '#a89f8e', width: 2 })));
  } else {
    col.appendChild(h('div', {
      style: { marginTop: '15px', fontSize: '13px', color: 'var(--ink-3)' },
      text: 'No website listed on Maps',
    }));
  }

  if (check && check.https === false) {
    col.appendChild(h('span', {
      class: 'pill',
      style: { marginTop: '10px', background: '#f0ddd3', color: '#8a3a1c' },
      text: 'http:// — not secure',
    }));
  } else if (check && check.https === true) {
    col.appendChild(h('span', { class: 'status', style: { marginTop: '10px' } },
      icon('check', { size: 11, stroke: '#8d8577', width: 2.4 }),
      h('span', { text: 'Serves over https' })));
  }

  if (check && check.retriedWithBrowserUa) {
    col.appendChild(h('p', {
      style: { marginTop: '10px', fontSize: '12px', lineHeight: '1.6', color: 'var(--ink-4)' },
      text: 'The first request was rejected; the host answered once it was retried with a browser user agent.',
    }));
  }
  if (check && check.error) {
    col.appendChild(h('p', {
      class: 'mono',
      style: { marginTop: '10px', fontSize: '11.5px', lineHeight: '1.6', color: 'var(--accent)' },
      text: check.error,
    }));
  }

  return col;
}

function shotState(lead, check, tier, slug) {
  if (!lead.website && tier === 'no_website') {
    return {
      title: 'Nothing to screenshot',
      body: 'Google Maps lists no website for this business, so there was no page to open.',
    };
  }
  if (!check) {
    return {
      title: tier === 'needs_check' ? 'Not checked yet' : 'No site check on record',
      body: tier === 'needs_check'
        ? 'This domain has not been through stage 2, so the tier still comes from the Maps listing alone.'
        : 'This lead was tiered from the Maps listing, so no page was fetched.',
      link: tier === 'needs_check' && slug ? `#/checking/${encodeURIComponent(slug)}` : null,
      linkLabel: 'Check the sites',
    };
  }
  return {
    title: 'No screenshot captured',
    body: 'This run had no browser available, so the verdict below rests on the HTTP checks alone.',
  };
}

// ------------------------------------------------------ right: verdict

function rightColumn(lead, check, tier, runMeta, ctx) {
  const col = h('div', { style: { flex: '1', minWidth: '420px' } });
  const signals = (check && Array.isArray(check.signals)) ? check.signals : [];

  const found = signals.filter((s) => s.found === true).length;
  const unchecked = signals.filter((s) => s.found === null || s.found === undefined).length;

  col.appendChild(h('div', {
    style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '24px' },
  },
    h('div', { class: 'eyebrow', text: 'Signals' }),
    h('div', {
      style: { fontSize: '12.5px', color: 'var(--ink-3)' },
      text: signals.length
        ? [`${found} found`, unchecked ? `${unchecked} could not be checked` : null].filter(Boolean).join('  ·  ')
        : 'none recorded',
    })));

  if (!signals.length) {
    const state = !check
      ? {
        title: 'This lead never went through a site check',
        body: 'Its tier comes from the Google Maps listing — whether a website is listed at all, and whether it points at a social page or a free host.',
      }
      : tier === 'dead_site'
        ? {
          title: 'The page never loaded',
          body: 'Nothing on the page could be checked, so there are no signals to score. The load failure is the verdict on its own.',
        }
        : {
          title: 'No signals were recorded for this check',
          body: 'The check ran but stored no signal list, so the tier below rests on the load result alone.',
        };
    col.appendChild(h('div', { class: 'empty', style: { marginTop: '16px' } },
      icon('info', { size: 20, stroke: '#bcb2a0', width: 1.8 }),
      h('div', { class: 'empty__title', text: state.title }),
      h('p', {
        class: 'empty__body',
        style: { maxWidth: '420px', margin: '7px auto 0' },
        text: state.body,
      })));
  } else {
    const objective = signals.filter((s) => OBJECTIVE_IDS.has(s.id) || (!VISUAL_IDS.has(s.id) && s.found !== null));
    const visual = signals.filter((s) => !objective.includes(s));

    if (objective.length) {
      col.appendChild(groupHeading('Objective — checked over HTTP', '18px'));
      for (const s of objective) col.appendChild(signalRow(s));
    }
    if (visual.length) {
      col.appendChild(groupHeading('Visual — needs a browser', '22px'));
      for (const s of visual) col.appendChild(signalRow(s));
    }
  }

  // ------------------------------------------------------- the verdict
  col.appendChild(h('div', {
    class: 'panel',
    style: { display: 'flex', alignItems: 'center', gap: '16px', marginTop: '24px' },
  },
    h('span', {
      class: `pill pill--${tier || 'needs_check'}`,
      style: { flexShrink: '0' },
      text: TIER_LABEL[tier] || tier || 'Unknown',
    }),
    h('div', { style: { fontSize: '13.5px', lineHeight: '1.6', color: 'var(--ink-2)' }, text: verdictRule(tier) })));

  // -------------------------------------------------------- the opener
  col.appendChild(h('div', { class: 'eyebrow', style: { marginTop: '30px' }, text: 'Opener' }));
  const opener = h('textarea', {
    class: 'textarea',
    'aria-label': 'Opener line',
    rows: '3',
    value: lead.reason || '',
    placeholder: 'No opener line was written for this lead.',
    style: {
      marginTop: '11px', minHeight: '86px', padding: '15px 17px',
      fontFamily: 'var(--serif)', fontSize: '19px', lineHeight: '1.5', color: 'var(--ink-prose)',
    },
  });
  col.appendChild(opener);
  col.appendChild(h('p', {
    class: 'hint',
    style: { marginTop: '9px' },
    text: 'Specific, verifiable, neutral. The owner may well have built this site themselves.',
  }));
  col.appendChild(h('p', {
    class: 'hint',
    style: { marginTop: '4px', color: 'var(--ink-4)' },
    text: 'Edits here are for the call in front of you — the line saved in the run CSV is left as it is.',
  }));

  // -------------------------------------------------------- the actions
  const chipSlot = h('div', { style: { display: 'flex' } });
  const actions = h('div', {
    style: { display: 'flex', alignItems: 'center', gap: '14px', marginTop: '28px', flexWrap: 'wrap' },
  },
    lead.phone
      ? h('a', {
        class: 'btn btn--primary',
        style: { height: '48px' },
        href: `tel:${String(lead.phone).replace(/[^\d+]/g, '')}`,
      }, icon('phone', { size: 16, stroke: 'currentColor' }),
        h('span', { class: 'mono', style: { fontWeight: '500' }, text: lead.phone }))
      : h('span', {
        class: 'btn btn--quiet',
        style: { height: '48px', color: 'var(--ink-3)', cursor: 'default' },
      }, icon('phoneOff', { size: 16, stroke: '#c4bba9', width: 1.8 }), 'No phone listed'),
    h('button', {
      class: 'btn btn--quiet',
      type: 'button',
      style: { height: '48px' },
      onClick: () => copyOpener(opener, ctx),
    }, 'Copy opener'),
    h('div', { style: { flex: '1' } }),
    chipSlot);
  col.appendChild(actions);

  mountChip(chipSlot, lead, ctx);

  // ---------------------------------------------------------- the facts
  col.appendChild(factsRow(lead, check, runMeta.date || ''));

  // --------------------------------------------------------- activity
  // Every outcome ever logged for this business, from the append-only log —
  // what happened on each call, not just the latest state.
  const activityEl = h('div', { style: { marginTop: '30px' } });
  col.appendChild(activityEl);
  activityEl.appendChild(h('div', { class: 'eyebrow', text: 'Activity' }));
  const actBody = h('div', { style: { marginTop: '11px' } });
  activityEl.appendChild(actBody);
  actBody.appendChild(h('div', { class: 'skeleton', style: { height: '14px', width: '140px' } }));
  ctx.api.activity(lead.place_id).then(({ rows }) => {
    clear(actBody);
    if (!rows.length) {
      actBody.appendChild(h('p', {
        style: { fontSize: '13px', color: 'var(--ink-4)' },
        text: 'No calls logged yet.',
      }));
      return;
    }
    for (const r of rows) {
      actBody.appendChild(h('div', {
        style: {
          display: 'flex', alignItems: 'baseline', gap: '12px',
          padding: '8px 0', borderBottom: '1px solid var(--rule-soft)', fontSize: '13px',
        },
      },
        h('span', {
          class: 'mono tnum',
          style: { fontSize: '11.5px', color: 'var(--ink-4)', flexShrink: '0' },
          text: fmtWhen(r.at),
        }),
        h('span', { style: { fontWeight: '500', flexShrink: '0' }, text: STATUS_LABEL[r.status] || r.status }),
        r.note ? h('span', { style: { color: 'var(--ink-3)' }, text: r.note }) : null));
    }
  }).catch(() => {
    clear(actBody);
    actBody.appendChild(h('p', {
      style: { fontSize: '13px', color: 'var(--ink-4)' },
      text: 'Could not load the call log.',
    }));
  });
  return col;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function groupHeading(text, marginTop) {
  return h('div', {
    style: {
      marginTop, fontSize: '11px', fontWeight: '600', letterSpacing: '0.05em',
      textTransform: 'uppercase', color: 'var(--ink-5)',
    },
    text,
  });
}

function signalRow(signal) {
  const notChecked = signal.found === null || signal.found === undefined;
  const mark = signal.found === true
    ? icon('check', { size: 16, stroke: '#1d1a15', width: 2.4 })
    : notChecked
      ? icon('dash', { size: 16, stroke: '#cfc6b4', width: 2 })
      : icon('circle', { size: 16, stroke: '#c9c0ae', width: 2 });
  mark.style.marginTop = '2px';

  const label = signal.label || signal.id || 'Signal';
  const evidence = signal.evidence || (notChecked ? 'not checked' : '');

  const body = signal.found === true
    ? h('div', { style: { fontSize: '14px', lineHeight: '1.55' } },
      h('span', { style: { fontWeight: '600' }, text: label }),
      evidence ? h('span', { style: { color: '#6b6558' }, text: ` — ${evidence}` }) : null)
    : h('div', {
      style: { fontSize: '14px', lineHeight: '1.55', color: notChecked ? 'var(--ink-5)' : 'var(--ink-4)' },
    },
      h('span', { style: { fontWeight: '600', color: notChecked ? 'var(--ink-5)' : 'var(--ink-3)' }, text: label }),
      evidence ? h('span', { text: ` — ${evidence}` }) : null);

  return h('div', {
    style: {
      display: 'flex', alignItems: 'flex-start', gap: '13px',
      padding: '12px 0', borderBottom: '1px solid var(--rule-soft)',
    },
  }, mark, body);
}

function verdictRule(tier) {
  switch (tier) {
    case 'very_dated':
      return 'Three or more signals is the threshold. One or two would score as somewhat dated; none at all drops it off the list.';
    case 'somewhat_dated':
      return 'One or two signals scores as somewhat dated. Three or more would be very dated; none at all drops it off the list.';
    case 'dead_site':
      return 'The page does not load in a browser, so the signal count does not apply. It ranks near the top because the pitch is renewal rather than persuasion — they already bought into having a site.';
    case 'not_a_lead':
      return 'Nothing was found against it, so it is dropped from the call list rather than padding it.';
    case 'no_website':
      return 'Google Maps lists no website at all, so there was no page to check. Strongest tier there is.';
    case 'social_only':
      return 'The only web link on the listing is a social or booking page, so this was tiered from Maps without a site check.';
    case 'free_host':
      return 'The site sits on a free host subdomain, so this was tiered from Maps without a site check.';
    case 'needs_check':
      return 'A real domain that has not been through stage 2 yet, so it is held out of the call order rather than ranked on a guess.';
    default:
      return 'No tier is recorded for this row.';
  }
}

function fact(label, ...children) {
  return h('div', {},
    h('div', { class: 'label', text: label }),
    h('div', { style: { marginTop: '8px', fontSize: '14px', color: 'var(--ink-2)' } }, children));
}

function factsRow(lead, check, pulledDate) {
  const row = h('div', {
    style: {
      display: 'flex', flexWrap: 'wrap', gap: '46px', marginTop: '34px',
      paddingTop: '26px', borderTop: '1px solid var(--rule)',
    },
  });

  row.appendChild(fact('Phone', lead.phone
    ? h('span', { class: 'mono tnum', text: lead.phone })
    : h('span', { style: { color: 'var(--ink-4)' }, text: 'None listed on Maps' })));

  row.appendChild(fact('Website', lead.website
    ? h('a', { href: lead.website, target: '_blank', rel: 'noopener noreferrer', text: prettyHost(lead.website) })
    : h('span', { style: { color: 'var(--ink-4)' }, text: 'None listed on Maps' })));

  row.appendChild(fact('Listing', lead.maps_url
    ? h('a', {
      href: lead.maps_url,
      target: '_blank',
      rel: 'noopener noreferrer',
      style: { display: 'inline-flex', alignItems: 'center', gap: '7px' },
    }, 'Open in Google Maps', icon('external', { size: 12, stroke: '#a89f8e', width: 2 }))
    : h('span', { style: { color: 'var(--ink-4)' }, text: 'No Maps link recorded' })));

  // seen_leads carries a per-business first_seen; the run CSV does not, so this
  // falls back to the date the run itself was pulled and says which it is.
  row.appendChild(fact(lead.first_seen ? 'First seen' : 'Pulled',
    h('span', { class: 'tnum', text: fmtDate(lead.first_seen || pulledDate) || 'Not recorded' })));

  if (check && check.checkedAt) {
    row.appendChild(fact('Checked',
      h('span', { class: 'tnum', text: fmtDate(check.checkedAt) }),
      typeof check.ms === 'number'
        ? h('span', { class: 'mono', style: { color: 'var(--ink-4)', marginLeft: '8px' }, text: `${check.ms} ms` })
        : null));
  }
  if (check && typeof check.httpStatus === 'number') {
    row.appendChild(fact('HTTP', h('span', { class: 'mono tnum', text: String(check.httpStatus) })));
  }
  if (check && check.platform) {
    row.appendChild(fact('Platform', h('span', { text: check.platform })));
  }
  return row;
}

// ---------------------------------------------------------- outcome bits

function mountChip(slot, lead, ctx) {
  clear(slot);
  const status = statusOf((ctx.state?.statuses || {})[lead.place_id]);
  const chipEl = h('button', {
    type: 'button',
    class: `status${status ? ' status--set' : ''}${status === 'interested' ? ' status--interested' : ''}`,
    'aria-haspopup': 'menu',
    style: { height: '34px', padding: '0 12px', borderRadius: '17px', fontSize: '13px' },
    onClick: (e) => {
      e.stopPropagation();
      if (openState && openState.anchor === chipEl) { closeMenu(); return; }
      openOutcomeMenu(chipEl, status, (picked) => save(slot, lead, chipEl, picked, ctx));
    },
  },
    statusDot(status),
    h('span', { text: status ? STATUS_LABEL[status] : 'Not called' }),
    icon('chevronDown', { size: 10, stroke: '#b3aa98', width: 2.6 }));
  slot.appendChild(chipEl);
}

async function save(slot, lead, chipEl, picked, ctx) {
  chipEl.setAttribute('aria-busy', 'true');
  chipEl.style.opacity = '0.5';
  try {
    const res = await ctx.api.outcome({ place_id: lead.place_id, status: picked, note: '' });
    const saved = statusOf(res && res.status) || picked;
    if (ctx.state) {
      ctx.state.statuses = ctx.state.statuses || {};
      ctx.state.statuses[lead.place_id] = saved;
    }
    mountChip(slot, lead, ctx);
    ctx.toast(`${lead.name || 'Lead'} — ${STATUS_LABEL[saved] || saved}`);
    ctx.refresh().catch(() => { /* nav counts are cosmetic; the outcome is saved */ });
  } catch (err) {
    chipEl.removeAttribute('aria-busy');
    chipEl.style.opacity = '';
    ctx.toast(`Could not save that outcome — ${err.message}`, 'err');
  }
}

async function copyOpener(opener, ctx) {
  const text = opener.value.trim();
  if (!text) { ctx.toast('There is no opener line to copy', 'err'); return; }
  try {
    await navigator.clipboard.writeText(text);
    ctx.toast('Opener copied');
  } catch {
    opener.focus();
    opener.select();
    ctx.toast('The browser blocked the clipboard — the line is selected, copy it by hand', 'err');
  }
}
