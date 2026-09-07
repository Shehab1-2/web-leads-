// A slide-over detail panel, shared by the call list and the data table.
//
// Opens over the current screen instead of navigating away, so you keep your
// place in the list. One panel exists at a time; opening a second replaces the
// first. Escape and the backdrop both close it.

import { h, clear, icon, prettyHost, STATUS_LABEL, statusDot, plural } from './dom.js';

const CSS = `
.pnl__back { position: fixed; inset: 0; background: rgba(29,26,21,0.28); z-index: 40; opacity: 0; transition: opacity 140ms ease; }
.pnl__back--in { opacity: 1; }
.pnl { position: fixed; top: 0; right: 0; bottom: 0; width: 520px; max-width: 94vw; background: var(--surface); border-left: 1px solid var(--rule); z-index: 41; overflow-y: auto; transform: translateX(14px); opacity: 0; transition: transform 150ms ease, opacity 150ms ease; }
.pnl--in { transform: none; opacity: 1; }
.pnl__head { position: sticky; top: 0; background: var(--surface); border-bottom: 1px solid var(--rule-soft); padding: 18px 22px 14px; display: flex; align-items: flex-start; gap: 14px; }
.pnl__title { font-family: var(--serif); font-size: 21px; line-height: 1.2; color: var(--ink); }
.pnl__sub { font-size: 12.5px; color: var(--ink-3); margin-top: 4px; }
.pnl__x { margin-left: auto; border: 0; background: transparent; cursor: pointer; padding: 4px; color: var(--ink-3); display: flex; }
.pnl__x:hover { color: var(--ink); }
.pnl__body { padding: 4px 22px 40px; }
.pnl__sec { margin-top: 24px; }
.pnl__row { display: flex; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--rule-soft); font-size: 13px; align-items: baseline; }
.pnl__row:last-child { border-bottom: 0; }
.pnl__k { width: 140px; flex-shrink: 0; color: var(--ink-4); font-size: 12px; }
.pnl__v { flex: 1; min-width: 0; color: var(--ink-prose); overflow-wrap: anywhere; }
.pnl__acts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
.pnl__raw { font-family: var(--mono); font-size: 11.5px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink-2); background: var(--tint); border-radius: 6px; padding: 12px; max-height: 320px; overflow: auto; }
`;

let open = null;

export function closePanel() {
  if (!open) return;
  const { back, panel, onKey } = open;
  open = null;
  document.removeEventListener('keydown', onKey);
  back.classList.remove('pnl__back--in');
  panel.classList.remove('pnl--in');
  setTimeout(() => { back.remove(); panel.remove(); }, 160);
}

function row(k, v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return null;
  return h('div', { class: 'pnl__row' },
    h('div', { class: 'pnl__k', text: k }),
    h('div', { class: 'pnl__v' }, v instanceof Node ? v : String(v)));
}

function link(url, label) {
  if (!url) return null;
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label || prettyHost(url));
}

const TIER_LABEL = {
  no_website: 'No website', dead_site: 'Dead site', social_only: 'Social only',
  free_host: 'Free host', very_dated: 'Very dated', somewhat_dated: 'Somewhat dated',
  needs_check: 'Needs checking', not_a_lead: 'Healthy site',
};

/**
 * @param lead  a row from /api/leads or /api/runs/:slug
 * @param ctx   { api, toast, refresh, navigate } — outcome logging needs them
 */
export function openPanel(lead, ctx = {}) {
  closePanel();
  if (!document.getElementById('pnl-css')) {
    const style = h('style', { id: 'pnl-css', text: CSS });
    document.head.appendChild(style);
  }

  const back = h('div', { class: 'pnl__back' });
  const panel = h('aside', { class: 'pnl', role: 'dialog', 'aria-label': lead.name || 'Business detail' });
  const tier = lead.effectiveTier || lead.checked_tier || lead.tier || '';

  const closeBtn = h('button', { class: 'pnl__x', type: 'button', 'aria-label': 'Close' },
    icon('x', { size: 17, width: 2.2 }));
  closeBtn.addEventListener('click', closePanel);

  panel.appendChild(h('div', { class: 'pnl__head' },
    h('div', {},
      h('div', { class: 'pnl__title', text: lead.name || '(no name)' }),
      h('div', { class: 'pnl__sub', text: [TIER_LABEL[tier] || tier, lead.category, lead.city].filter(Boolean).join(' · ') })),
    closeBtn));

  const body = h('div', { class: 'pnl__body' });
  panel.appendChild(body);

  // --- the call-relevant facts, first ------------------------------------
  const acts = h('div', { class: 'pnl__acts' });
  if (lead.phone) acts.appendChild(h('a', { class: 'btn btn--primary btn--sm', href: `tel:${lead.phone}` }, lead.phone));
  if (lead.website) acts.appendChild(h('a', { class: 'btn btn--outline btn--sm', href: lead.website, target: '_blank', rel: 'noopener noreferrer' }, 'Open site'));
  if (lead.maps_url) acts.appendChild(h('a', { class: 'btn btn--quiet btn--sm', href: lead.maps_url, target: '_blank', rel: 'noopener noreferrer' }, 'Maps'));
  if (lead.email) acts.appendChild(h('a', { class: 'btn btn--quiet btn--sm', href: `mailto:${lead.email}` }, 'Email'));
  // The full screen still exists; the panel is a faster way in, not a
  // replacement for the deep link.
  if (lead.fullPage) {
    const full = h('a', { class: 'btn btn--quiet btn--sm', href: lead.fullPage }, 'Full page');
    full.addEventListener('click', () => closePanel());
    acts.appendChild(full);
  }
  body.appendChild(acts);

  if (lead.reason) {
    body.appendChild(h('div', { class: 'note', style: { marginTop: '18px' } },
      h('div', { class: 'note__title', text: 'Opener' }),
      h('div', { class: 'note__body', text: lead.reason })));
  }

  // --- the stored columns -------------------------------------------------
  const facts = h('div', { class: 'pnl__sec' }, h('div', { class: 'label', text: 'Details' }));
  const table = h('div', { style: { marginTop: '8px' } });
  const bits = [
    ['Phone', lead.phone],
    ['Email', lead.email],
    ['Website', link(lead.website)],
    ['Address', [lead.address, lead.state, lead.postal_code].filter(Boolean).join(', ')],
    ['Category', lead.category],
    ['Rating', lead.rating ? `${lead.rating}${lead.reviews ? ` · ${plural(Number(lead.reviews), 'review', 'reviews')}` : ''}` : ''],
    ['Hours', lead.hours],
    ['Description', lead.description],
    ['Socials', lead.socials ? h('span', {}, lead.socials.split(/\s+/).filter(Boolean).map((u, i) => h('span', {}, i ? ' · ' : '', link(u)))) : ''],
    ['Claim prompt', lead.claim_this_business],
    ['Coordinates', lead.lat && lead.lng ? `${lead.lat}, ${lead.lng}` : ''],
    ['Run', lead.run || ''],
    ['First tier', TIER_LABEL[lead.tier] || lead.tier],
    ['Checked tier', TIER_LABEL[lead.checked_tier] || lead.checked_tier],
    ['place_id', lead.place_id],
  ];
  for (const [k, v] of bits) { const r = row(k, v); if (r) table.appendChild(r); }
  facts.appendChild(table);
  body.appendChild(facts);

  // --- outcome -------------------------------------------------------------
  const oc = lead.outcome;
  const outcomeSec = h('div', { class: 'pnl__sec' }, h('div', { class: 'label', text: 'Call outcome' }));
  const current = h('div', { style: { marginTop: '8px', fontSize: '13px', color: 'var(--ink-2)' } });
  if (oc && oc.status) {
    current.appendChild(h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '7px' } },
      statusDot(oc.status), h('span', { text: STATUS_LABEL[oc.status] || oc.status })));
    if (oc.note) current.appendChild(h('div', { class: 'hint', style: { marginTop: '5px' }, text: oc.note }));
  } else {
    current.appendChild(h('span', { class: 'hint', text: 'Not called yet.' }));
  }
  outcomeSec.appendChild(current);

  if (ctx.api && ctx.api.outcome) {
    const buttons = h('div', { class: 'pnl__acts' });
    for (const [status, label] of Object.entries(STATUS_LABEL)) {
      const b = h('button', { class: 'btn btn--quiet btn--sm', type: 'button' }, label);
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await ctx.api.outcome({ place_id: lead.place_id, status });
          ctx.toast?.(`${lead.name} — ${label}`);
          lead.outcome = { status, note: '' };
          clear(current);
          current.appendChild(h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '7px' } },
            statusDot(status), h('span', { text: label })));
          await ctx.refresh?.();
          ctx.onChange?.();
        } catch (err) {
          ctx.toast?.(String(err.message || err), 'err');
          b.disabled = false;
        }
      });
      buttons.appendChild(b);
    }
    outcomeSec.appendChild(buttons);
  }
  body.appendChild(outcomeSec);

  // --- site check ----------------------------------------------------------
  if (lead.check && Array.isArray(lead.check.signals) && lead.check.signals.length) {
    const sec = h('div', { class: 'pnl__sec' }, h('div', { class: 'label', text: 'Site check' }));
    const list = h('div', { style: { marginTop: '8px' } });
    for (const sig of lead.check.signals) {
      list.appendChild(h('div', { class: 'pnl__row' },
        h('div', { class: 'pnl__k' },
          icon(sig.found ? 'alert' : 'check', { size: 12, width: 2.2, stroke: sig.found ? 'var(--warn-ink)' : '#3d6b34' }),
          h('span', { text: ` ${sig.label || sig.id}` })),
        h('div', { class: 'pnl__v', text: sig.evidence || '' })));
    }
    sec.appendChild(list);
    body.appendChild(sec);
  }

  // --- everything Google returned -----------------------------------------
  if (lead.details && Object.keys(lead.details).length) {
    const sec = h('details', { class: 'pnl__sec fold' });
    sec.appendChild(h('summary', {},
      h('span', { class: 'fold__chev' }, icon('chevronRight', { size: 12, width: 2.2 })),
      h('span', { class: 'label', text: `Everything Google returned (${Object.keys(lead.details).length} fields)` })));
    sec.appendChild(h('div', {
      class: 'pnl__raw',
      style: { marginTop: '10px' },
      text: JSON.stringify(lead.details, null, 2),
    }));
    body.appendChild(sec);
  }

  const onKey = (e) => { if (e.key === 'Escape') closePanel(); };
  back.addEventListener('click', closePanel);
  document.addEventListener('keydown', onKey);

  document.body.appendChild(back);
  document.body.appendChild(panel);
  open = { back, panel, onKey };
  // Next frame, so the transition has a start state to move from.
  requestAnimationFrame(() => {
    back.classList.add('pnl__back--in');
    panel.classList.add('pnl--in');
  });
  closeBtn.focus?.();
}
