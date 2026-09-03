// Shell: hash router, API client, nav, toasts. Views are lazy ES modules
// under ./views/ and get a ctx with everything they need.

import { h, clear, icon } from './dom.js';

// ------------------------------------------------------------ API client

async function json(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = { ok: false, error: `${res.status} ${res.statusText}` }; }
  if (!res.ok || data.ok === false) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

/**
 * POST that streams server-sent events back. EventSource is GET-only, so the
 * stream is parsed off the fetch body directly.
 */
async function stream(url, body, handlers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok || !res.body) {
    let msg = `${res.status} ${res.statusText}`;
    try { const d = await res.json(); msg = d.error || msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done = null;
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    // Events are separated by a blank line; anything after the last one is a
    // partial event and stays in the buffer.
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      let payload;
      try { payload = JSON.parse(dataLines.join('\n')); } catch { payload = { message: dataLines.join('\n') }; }
      if (event === 'done') done = payload;
      else if (event === 'error') throw new Error(payload.error || 'the job failed');
      else handlers[event]?.(payload);
    }
  }
  return done;
}

export const api = {
  state: () => json('GET', '/api/state'),
  runs: () => json('GET', '/api/runs'),
  run: (slug) => json('GET', `/api/runs/${encodeURIComponent(slug)}`),
  history: () => json('GET', '/api/history'),
  email: (slug) => json('GET', `/api/email/${encodeURIComponent(slug)}`),
  outcome: (body) => json('POST', '/api/outcome', body),
  search: (body, handlers) => stream('/api/search', body, handlers),
  check: (slug, handlers) => stream(`/api/check/${encodeURIComponent(slug)}`, {}, handlers),
  scanEmails: (slug, handlers) => stream(`/api/email/${encodeURIComponent(slug)}/scan`, {}, handlers),
};

// ---------------------------------------------------------------- routes

const ROUTES = [
  { re: /^\/search$/, view: 'search', args: () => ({}) },
  { re: /^\/checking\/(.+)$/, view: 'checking', args: (m) => ({ slug: dec(m[1]) }) },
  { re: /^\/leads\/([^/]+)\/(.+)$/, view: 'sitecheck', args: (m) => ({ slug: dec(m[1]), placeId: dec(m[2]) }) },
  { re: /^\/leads\/(.+)$/, view: 'calllist', args: (m) => ({ slug: dec(m[1]) }) },
  { re: /^\/call\/(.+)$/, view: 'callmode', args: (m) => ({ slug: dec(m[1]) }) },
  { re: /^\/history$/, view: 'history', args: () => ({}) },
  { re: /^\/runs$/, view: 'runs', args: () => ({}) },
  { re: /^\/email\/(.+)$/, view: 'email', args: (m) => ({ slug: dec(m[1]) }) },
];

const dec = (s) => decodeURIComponent(s);

let state = { runs: [], activeRun: null, statuses: {}, config: {} };
let current = null;

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function toast(message, kind = 'ok') {
  const el = h('div', { class: `toast${kind === 'err' ? ' toast--err' : ''}` },
    icon(kind === 'err' ? 'alert' : 'check', { size: 15 }),
    h('span', { text: message }));
  document.body.appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3200);
}

async function refresh() {
  state = await api.state();
  renderNav();
  return state;
}

// ------------------------------------------------------------------- nav

function navLink(hash, label, count) {
  const active = location.hash === hash || (hash !== '#/search' && location.hash.startsWith(hash));
  return h('a', { class: 'nav__link', href: hash, ...(active ? { 'aria-current': 'page' } : {}) },
    h('span', { class: 'nav__dot' }),
    h('span', { text: label }),
    count !== undefined && count !== null ? h('span', { class: 'nav__count tnum', text: String(count) }) : null);
}

function renderNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  clear(nav);
  const slug = state.activeRun?.slug;
  const enc = slug ? encodeURIComponent(slug) : null;
  const leadCount = state.activeRun?.leads ?? null;
  const toCall = state.activeRun?.toCall ?? null;

  nav.appendChild(h('div', { class: 'nav__mark', text: 'web-leads' }));
  nav.appendChild(h('div', { class: 'nav__group', text: 'Pipeline' }));
  nav.appendChild(navLink('#/search', 'New search'));
  if (enc) {
    nav.appendChild(navLink(`#/checking/${enc}`, 'Check sites', state.activeRun.needsCheck || null));
    nav.appendChild(navLink(`#/leads/${enc}`, 'Call list', leadCount));
    nav.appendChild(navLink(`#/call/${enc}`, 'Call mode', toCall));
  }
  nav.appendChild(h('div', { class: 'nav__group', text: 'Records' }));
  nav.appendChild(navLink('#/history', 'Call history', state.historyCount ?? null));
  nav.appendChild(navLink('#/runs', 'Searches', state.runs.length || null));
  if (enc) nav.appendChild(navLink(`#/email/${enc}`, 'Cold email'));
}

// ---------------------------------------------------------------- render

async function render() {
  const path = location.hash.replace(/^#/, '') || '/';
  const root = document.getElementById('view');

  if (path === '/' || path === '') {
    const target = state.activeRun ? `#/leads/${encodeURIComponent(state.activeRun.slug)}` : '#/search';
    location.replace(target);
    return;
  }

  const route = ROUTES.map((r) => ({ r, m: path.match(r.re) })).find((x) => x.m);
  if (!route) { clear(root); root.appendChild(notFound(path)); return; }

  if (current?.destroy) { try { current.destroy(); } catch { /* view teardown is best-effort */ } }
  current = null;
  renderNav();
  clear(root);
  root.appendChild(h('div', { class: 'skeleton', style: { height: '18px', width: '160px' } }));

  try {
    const mod = await import(`./views/${route.r.view}.js`);
    current = mod;
    clear(root);
    await mod.render(root, {
      api, state, navigate, toast, refresh,
      ...route.r.args(route.m),
    });
  } catch (err) {
    clear(root);
    root.appendChild(errorPane(err));
  }
  root.scrollIntoView?.({ block: 'start' });
}

function notFound(path) {
  return h('div', {},
    h('div', { class: 'eyebrow', text: 'web-leads' }),
    h('h1', { class: 'title', style: { marginTop: '16px' }, text: 'No such screen' }),
    h('p', { class: 'subtitle', text: path }),
    h('a', { class: 'btn btn--outline', href: '#/search', style: { marginTop: '24px' } }, 'Start a search'));
}

function errorPane(err) {
  return h('div', {},
    h('div', { class: 'eyebrow', text: 'web-leads' }),
    h('h1', { class: 'title', style: { marginTop: '16px' }, text: 'That did not load' }),
    h('p', { class: 'subtitle', text: String(err && err.message ? err.message : err) }),
    h('button', {
      class: 'btn btn--outline',
      style: { marginTop: '24px' },
      onClick: () => render(),
    }, 'Try again'));
}

// ------------------------------------------------------------------ boot

window.addEventListener('hashchange', render);

(async function boot() {
  try {
    await refresh();
  } catch (err) {
    document.getElementById('view').appendChild(errorPane(
      new Error(`Could not reach the local server — ${err.message}`)));
    return;
  }
  await render();
})();
