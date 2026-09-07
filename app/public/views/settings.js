// Settings — what this workspace is actually configured to do, stated plainly,
// plus the surface for the pieces that are scaffolded but not built yet. Every
// value here comes from /api/state's config block; no secrets ever reach the
// browser, only booleans and paths.

import { h, clear, icon } from '../dom.js';

export const meta = { title: 'Settings' };

const CSS = `
.set { max-width: 760px; }
.set__grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 18px; }
.set__item { display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px; border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); }
.set__item-body { min-width: 0; }
.set__item-name { font-size: 13.5px; font-weight: 600; color: var(--ink); }
.set__item-detail { font-size: 12.5px; color: var(--ink-3); margin-top: 3px; line-height: 1.45; overflow-wrap: anywhere; }
.set__state { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; margin-top: 7px; }
.set__state--on { color: #3d6b34; }
.set__state--off { color: var(--warn-ink); }
.set__state--soon { color: var(--ink-4); }
.set__section { margin-top: 40px; }
.set__soon { opacity: 0.75; }
@media (max-width: 900px) { .set__grid { grid-template-columns: 1fr; } }
`;

function item({ name, detail, on, state, soon = false }) {
  return h('div', { class: `set__item${soon ? ' set__soon' : ''}` },
    icon(soon ? 'circle' : on ? 'check' : 'alert', {
      size: 15, width: 2.2,
      stroke: soon ? 'var(--ink-5)' : on ? '#3d6b34' : 'var(--warn-ink)',
    }),
    h('div', { class: 'set__item-body' },
      h('div', { class: 'set__item-name', text: name }),
      h('div', { class: 'set__item-detail', text: detail }),
      h('div', {
        class: `set__state ${soon ? 'set__state--soon' : on ? 'set__state--on' : 'set__state--off'}`,
        text: state,
      })));
}

function section(root, title, sub) {
  root.appendChild(h('div', { class: 'set__section' },
    h('div', { class: 'label', text: title }),
    sub ? h('p', { class: 'hint', style: { marginTop: '6px' }, text: sub }) : null));
}

export async function render(root, ctx) {
  const c = ctx.state?.config || {};
  const wrap = h('div', { class: 'set' });
  wrap.appendChild(h('style', { text: CSS }));

  wrap.appendChild(h('div', { class: 'eyebrow', text: 'web-leads / settings' }));
  wrap.appendChild(h('h1', { class: 'title', style: { marginTop: '14px' }, text: 'Settings' }));
  wrap.appendChild(h('p', { class: 'subtitle', text: 'Configuration is read from environment variables on the server — nothing here stores a secret in the browser.' }));

  // ------------------------------------------------------------- live config
  section(wrap, 'Workspace');
  const grid1 = h('div', { class: 'set__grid' });
  grid1.appendChild(item({
    name: 'Apify token', on: Boolean(c.apifyToken),
    detail: c.apifyToken
      ? 'Set. New searches pull live Google Maps data.'
      : 'Not set. Searching is disabled; set APIFY_API_TOKEN on the server and restart.',
    state: c.apifyToken ? 'configured' : 'not configured',
  }));
  grid1.appendChild(item({
    name: 'Instantly (cold email)', on: Boolean(c.instantly),
    detail: c.instantly
      ? 'Set. The email screen can push leads into your campaign.'
      : 'Not set. Drafting still works; the push needs INSTANTLY_API_KEY and INSTANTLY_CAMPAIGN_ID.',
    state: c.instantly ? 'configured' : 'not configured',
  }));
  grid1.appendChild(item({
    name: 'Access password', on: Boolean(c.passwordSet),
    detail: c.passwordSet
      ? 'Every request needs the password (any username works at the prompt).'
      : c.onPlatform
        ? 'NOT SET on a public deployment — anyone with the URL can read the call list. Set APP_PASSWORD.'
        : 'Not set — fine while the app only listens on this machine.',
    state: c.passwordSet ? 'enabled' : c.onPlatform ? 'missing' : 'off (local only)',
  }));
  const onPg = c.backend === 'postgres';
  grid1.appendChild(item({
    name: 'Storage', on: onPg || !c.onPlatform,
    detail: onPg
      ? 'Postgres. Runs, leads, site checks, call history and the outcomes log all live in the database, so a redeploy cannot lose them.'
      : c.onPlatform
        ? `CSV files at ${c.dataDir} inside the container — WIPED on every redeploy. Attach a database or a volume.`
        : `CSV files under ${c.dataDir}. Call history and the outcomes log are append-only.`,
    state: onPg ? 'postgres' : c.onPlatform ? 'ephemeral — not safe for real calls' : 'csv (local)',
  }));
  wrap.appendChild(grid1);

  // ------------------------------------------------------------- demo data
  section(wrap, 'Demo data',
    'The workspace ships with seeded demo searches so every screen has something to show.');
  wrap.appendChild(h('div', { class: 'note', style: { marginTop: '14px' } },
    h('div', { class: 'note__title', text: 'Reset to fresh demo data' }),
    h('div', { class: 'note__body' },
      'Run ', h('span', { class: 'mono', text: 'node app/tools/seed-demo.mjs --force' }),
      ' on the server. This wipes every run, the call history and the outcomes log, and reseeds two demo searches. There is deliberately no button for it — wiping call history should take more than a click.')));

  // ------------------------------------------------------------ scaffolds
  section(wrap, 'Coming soon',
    'Scaffolded but not yet connected — these describe the intended shape, nothing behind them works yet.');
  const grid2 = h('div', { class: 'set__grid' });
  grid2.appendChild(item({
    soon: true, name: 'Team members',
    detail: 'Multiple callers sharing one workspace, with outcomes attributed per person. Today the app is single-operator behind one shared password.',
    state: 'not built yet',
  }));
  grid2.appendChild(item({
    soon: true, name: 'Webhooks',
    detail: 'POST every logged outcome to a URL of yours, so a CRM can mirror the call log.',
    state: 'not built yet',
  }));
  grid2.appendChild(item({
    soon: true, name: 'Scheduled searches',
    detail: 'Re-run a saved niche + location weekly and get only the businesses not seen before.',
    state: 'not built yet',
  }));
  grid2.appendChild(item({
    soon: true, name: 'Reporting',
    detail: 'Conversion by tier over time — which lead tiers actually turn into paying clients.',
    state: 'not built yet',
  }));
  wrap.appendChild(grid2);

  clear(root);
  root.appendChild(wrap);
}
