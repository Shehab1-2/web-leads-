// Overview — the screen the app opens on. It answers three questions before
// you have to click anything: what is worth doing right now, what happened
// recently, and what state the pipeline is in.
//
// Deliberately not a metrics wall. Every number here is either a thing to act
// on or a thing that explains one.

import {
  h, clear, icon, fmtShortDate, plural, STATUS_LABEL, statusDot, prettyHost,
} from '../dom.js';

export const meta = { title: 'Overview' };

const CSS = `
.ov__lede { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
.ov__cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 28px; }
.ov__card { padding: 16px 18px; border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); }
.ov__card-n { font-family: var(--serif); font-size: 30px; line-height: 1.05; color: var(--ink); }
.ov__card-label { font-size: 12.5px; color: var(--ink-3); margin-top: 6px; }
.ov__card-sub { font-size: 11.5px; color: var(--ink-4); margin-top: 3px; }
.ov__cols { display: grid; grid-template-columns: 1.55fr 1fr; gap: 44px; margin-top: 46px; align-items: start; }
.ov__next { display: flex; align-items: center; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--rule-soft); }
.ov__next:last-child { border-bottom: 0; }
.ov__rank { font-family: var(--mono); font-size: 11px; color: var(--ink-5); width: 16px; flex-shrink: 0; }
.ov__next-main { flex: 1; min-width: 0; }
.ov__next-name { font-size: 14px; color: var(--ink); }
.ov__next-why { font-size: 12.5px; color: var(--ink-3); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
.ov__next-phone { font-family: var(--mono); font-size: 12.5px; color: var(--ink-2); flex-shrink: 0; }
.ov__act { display: flex; align-items: baseline; gap: 10px; padding: 9px 0; font-size: 13px; }
.ov__act-when { font-family: var(--mono); font-size: 11px; color: var(--ink-5); flex-shrink: 0; width: 52px; }
.ov__act-body { min-width: 0; }
.ov__act-note { color: var(--ink-3); font-size: 12.5px; margin-top: 2px; }
@media (max-width: 1000px) {
  .ov__cards { grid-template-columns: repeat(2, 1fr); }
  .ov__cols { grid-template-columns: 1fr; gap: 34px; }
}
@media (max-width: 560px) { .ov__cards { grid-template-columns: 1fr; } }
`;

function card(n, label, sub) {
  return h('div', { class: 'ov__card' },
    h('div', { class: 'ov__card-n tnum', text: String(n) }),
    h('div', { class: 'ov__card-label', text: label }),
    sub ? h('div', { class: 'ov__card-sub', text: sub }) : null);
}

function section(title, action) {
  return h('div', {
    style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '16px' },
  }, h('div', { class: 'label', text: title }), action || null);
}

/** Rough relative day, enough to read a trail at a glance. */
function ago(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const days = Math.floor((Date.now() - then.getTime()) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return fmtShortDate(iso);
}

export async function render(root, ctx) {
  const { api, state, navigate } = ctx;
  const wrap = h('div');
  wrap.appendChild(h('style', { text: CSS }));

  const run = state.activeRun;

  wrap.appendChild(h('div', { class: 'eyebrow', text: 'web-leads' }));
  wrap.appendChild(h('div', { class: 'ov__lede', style: { marginTop: '14px' } },
    h('div', {},
      h('h1', { class: 'title', text: 'Overview' }),
      h('p', {
        class: 'subtitle',
        text: run
          ? `Working ${run.niche || run.slug}${run.location ? ` in ${run.location}` : ''}.`
          : 'Nothing pulled yet — start with a trade and a town.',
      })),
    h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
      h('a', { class: 'btn btn--quiet', href: '#/add' }, 'Add a lead'),
      run ? h('a', { class: 'btn btn--outline', href: `#/call/${encodeURIComponent(run.slug)}` }, 'Call mode') : null,
      h('a', { class: 'btn btn--primary', href: '#/search' }, 'New search'))));

  // ------------------------------------------------------- nothing yet
  if (!run) {
    wrap.appendChild(h('div', { class: 'empty', style: { marginTop: '40px' } },
      icon('search', { size: 22, stroke: '#bcb2a0', width: 1.7 }),
      h('div', { class: 'empty__title', text: 'No searches yet' }),
      h('p', {
        class: 'empty__body',
        style: { maxWidth: '440px', margin: '8px auto 0' },
        text: 'Pull one trade in one town — "plumbers in New Brunswick, NJ". A general search returns a list nobody can work.',
      }),
      h('a', { class: 'btn btn--primary', style: { marginTop: '20px' }, href: '#/search' }, 'Start a search')));
    clear(root);
    root.appendChild(wrap);
    return;
  }

  // -------------------------------------------------------------- counts
  const cards = h('div', { class: 'ov__cards' });
  cards.appendChild(card(run.toCall ?? 0, 'Still to call',
    run.toCall ? 'nobody has picked these up yet' : 'this list is worked through'));
  cards.appendChild(card(run.leads ?? 0, 'Callable leads', `of ${run.total ?? 0} pulled`));
  cards.appendChild(card(run.needsCheck ?? 0, 'Sites unchecked',
    run.needsCheck ? 'verdicts still to gather' : 'every site has a verdict'));
  cards.appendChild(card(state.historyCount ?? 0, 'In call history', 'across every search'));
  wrap.appendChild(cards);

  const cols = h('div', { class: 'ov__cols' });
  const left = h('div');
  const right = h('div');
  cols.appendChild(left);
  cols.appendChild(right);
  wrap.appendChild(cols);

  // Placeholders while the run loads — the counts above are already useful.
  left.appendChild(section('Next to call',
    h('a', { class: 'btn btn--quiet btn--sm', href: `#/leads/${encodeURIComponent(run.slug)}` }, 'Full list')));
  const nextBox = h('div', { style: { marginTop: '12px' } },
    h('div', { class: 'skeleton', style: { height: '52px' } }));
  left.appendChild(nextBox);

  right.appendChild(section('Recent calls'));
  const actBox = h('div', { style: { marginTop: '12px' } },
    h('div', { class: 'skeleton', style: { height: '52px' } }));
  right.appendChild(actBox);

  clear(root);
  root.appendChild(wrap);

  // ------------------------------------------------- the two live panels
  try {
    const detail = await api.run(run.slug);
    clear(nextBox);
    const todo = (detail.leads || []).filter((l) => l.isLead && !l.outcome).slice(0, 6);
    if (!todo.length) {
      nextBox.appendChild(h('p', {
        style: { fontSize: '13px', color: 'var(--ink-3)', lineHeight: '1.6' },
        text: 'Every callable lead in this search has an outcome logged. Run another search when you want more.',
      }));
    } else {
      todo.forEach((l, i) => {
        const row = h('a', {
          class: 'ov__next',
          href: `#/leads/${encodeURIComponent(run.slug)}/${encodeURIComponent(l.place_id)}`,
        },
          h('span', { class: 'ov__rank tnum', text: String(i + 1) }),
          h('span', { class: 'ov__next-main' },
            h('span', { class: 'ov__next-name', text: l.name }),
            h('span', { class: 'ov__next-why', text: l.reason || prettyHost(l.website) || '' })),
          h('span', { class: 'ov__next-phone', text: l.phone || 'no phone' }));
        nextBox.appendChild(row);
      });
    }
  } catch (err) {
    clear(nextBox);
    nextBox.appendChild(h('p', { class: 'hint', text: `Could not load the list — ${err.message}` }));
  }

  try {
    const { rows } = await api.history();
    clear(actBox);
    const called = (rows || [])
      .filter((r) => r.outcome && r.outcome.at)
      .sort((a, b) => String(b.outcome.at).localeCompare(String(a.outcome.at)))
      .slice(0, 6);
    if (!called.length) {
      actBox.appendChild(h('p', {
        style: { fontSize: '13px', color: 'var(--ink-3)', lineHeight: '1.6' },
        text: 'No calls logged yet. Outcomes you mark while calling show up here.',
      }));
    } else {
      for (const r of called) {
        actBox.appendChild(h('div', { class: 'ov__act' },
          h('span', { class: 'ov__act-when', text: ago(r.outcome.at) }),
          h('span', { class: 'ov__act-body' },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
              statusDot(r.outcome.status),
              h('span', { text: r.name })),
            h('div', { class: 'ov__act-note', text: r.outcome.note || STATUS_LABEL[r.outcome.status] || '' }))));
      }
      actBox.appendChild(h('a', {
        class: 'btn btn--quiet btn--sm',
        style: { marginTop: '14px' },
        href: '#/history',
      }, 'All history'));
    }
  } catch (err) {
    clear(actBox);
    actBox.appendChild(h('p', { class: 'hint', text: `Could not load history — ${err.message}` }));
  }
}
