// Shell: hash router, API client, pipeline nav + stage strip, toasts.
// Views are lazy ES modules under ./views/ and get a ctx with everything
// they need. The shell owns the workflow spine: search → check → call →
// follow up, with the current position and live counts rendered on every
// navigation.

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

// Long jobs keep running server-side wherever the user navigates; this
// registry is what lets the nav say so. Client-side on purpose: the server's
// per-run guard already 409s a double-start, so the only thing lost on a tab
// reload is the indicator itself.
const jobs = new Map();

function tracked(key, label, fn) {
  return async (...args) => {
    jobs.set(key, label);
    renderNav();
    try { return await fn(...args); } finally { jobs.delete(key); renderNav(); }
  };
}

export const api = {
  state: () => json('GET', '/api/state'),
  runs: () => json('GET', '/api/runs'),
  run: (slug) => json('GET', `/api/runs/${encodeURIComponent(slug)}`),
  history: () => json('GET', '/api/history'),
  activity: (placeId) => json('GET', `/api/activity/${encodeURIComponent(placeId)}`),
  email: (slug) => json('GET', `/api/email/${encodeURIComponent(slug)}`),
  outcome: (body) => json('POST', '/api/outcome', body),
  addLead: (slug, body) => json('POST', `/api/runs/${encodeURIComponent(slug)}/leads`, body),
  updateLead: (slug, placeId, body) => json('PATCH', `/api/runs/${encodeURIComponent(slug)}/leads/${encodeURIComponent(placeId)}`, body),
  removeLead: (slug, placeId) => json('DELETE', `/api/runs/${encodeURIComponent(slug)}/leads/${encodeURIComponent(placeId)}`),
  deleteRun: (slug) => json('DELETE', `/api/runs/${encodeURIComponent(slug)}`),
  exportUrl: (slug, kind = 'md') => `/api/runs/${encodeURIComponent(slug)}/export.${kind}`,
  search: tracked('search', 'Searching…',
    (body, handlers) => stream('/api/search', body, handlers)),
  check: tracked('check', 'Checking sites…',
    (slug, handlers, body) => stream(`/api/check/${encodeURIComponent(slug)}`, body || {}, handlers)),
  scanEmails: tracked('scan', 'Scanning for addresses…',
    (slug, handlers) => stream(`/api/email/${encodeURIComponent(slug)}/scan`, {}, handlers)),
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
  { re: /^\/settings$/, view: 'settings', args: () => ({}) },
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

// ----------------------------------------------------------- the pipeline

// The workflow spine. Everything the nav and stage strip say comes from here,
// derived from the active run, so both always agree.
function pipeline() {
  const r = state.activeRun;
  const enc = r ? encodeURIComponent(r.slug) : null;
  return [
    {
      key: 'search', n: '1', label: 'Search', hash: '#/search',
      count: null, done: Boolean(r), enabled: true,
    },
    {
      key: 'check', n: '2', label: 'Check sites', hash: enc ? `#/checking/${enc}` : null,
      count: r?.needsCheck || null, done: Boolean(r) && !r.needsCheck, enabled: Boolean(r),
    },
    {
      key: 'call', n: '3', label: 'Call', hash: enc ? `#/leads/${enc}` : null,
      count: r?.toCall || null, done: Boolean(r) && r.leads > 0 && !r.toCall, enabled: Boolean(r),
    },
    {
      key: 'follow', n: '4', label: 'Follow up', hash: enc ? `#/email/${enc}` : null,
      count: null, done: false, enabled: Boolean(r),
    },
  ];
}

function stageForPath(path) {
  if (path.startsWith('/search')) return 'search';
  if (path.startsWith('/checking/')) return 'check';
  if (path.startsWith('/leads/') || path.startsWith('/call/')) return 'call';
  if (path.startsWith('/email/')) return 'follow';
  return null;
}

/** The strip above every pipeline view: where you are, what is left, one tap
 *  to any stage. */
function stageStrip(currentKey) {
  const strip = h('div', { class: 'stages' });
  pipeline().forEach((s, i) => {
    if (i) strip.appendChild(h('span', { class: 'stages__sep' },
      icon('chevronRight', { size: 11, stroke: 'currentColor', width: 2.2 })));
    const isHere = s.key === currentKey;
    const bits = [
      h('span', { class: 'stage__n', text: s.n }),
      h('span', { text: s.label }),
      s.done && !isHere ? icon('check', { size: 11, stroke: 'currentColor', width: 2.6 }) : null,
      s.count ? h('span', { class: 'stage__count', text: String(s.count) }) : null,
    ];
    const cls = `stage${!s.enabled ? ' stage--wait' : ''}`;
    strip.appendChild(s.enabled && s.hash && !isHere
      ? h('a', { class: cls, href: s.hash }, bits)
      : h('span', { class: cls, ...(isHere ? { 'aria-current': 'step' } : {}) }, bits));
  });
  return strip;
}

// ------------------------------------------------------------------- nav

function navLink(hash, label, { count = null, n = null, sub = false, done = false } = {}) {
  const active = location.hash === hash
    || (hash !== '#/search' && hash && location.hash.startsWith(hash));
  return h('a', {
    class: `nav__link${sub ? ' nav__link--sub' : ''}`,
    href: hash,
    ...(active ? { 'aria-current': 'page' } : {}),
  },
    n !== null ? h('span', { class: 'nav__n', text: n }) : h('span', { class: 'nav__dot' }),
    h('span', { text: label }),
    done ? icon('check', { size: 11, stroke: 'var(--ink-4)', width: 2.4 }) : null,
    count !== null && count !== undefined
      ? h('span', { class: 'nav__count tnum', text: String(count) }) : null);
}

function renderNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  clear(nav);
  nav.appendChild(h('div', { class: 'nav__mark', text: 'web-leads' }));

  // A running job stays visible from every screen, not just the one that
  // started it.
  for (const label of jobs.values()) {
    nav.appendChild(h('div', { class: 'nav__job' },
      icon('spinner', { size: 12, cls: 'spin', width: 2.2 }),
      h('span', { text: label })));
  }

  nav.appendChild(h('div', { class: 'nav__group', text: 'Pipeline' }));
  const r = state.activeRun;
  const enc = r ? encodeURIComponent(r.slug) : null;
  for (const s of pipeline()) {
    if (!s.enabled) continue;
    nav.appendChild(navLink(s.hash, s.label, { n: s.n, count: s.count, done: s.done }));
    // Call mode is how stage 3 is worked, not a stage of its own.
    if (s.key === 'call' && enc) {
      nav.appendChild(navLink(`#/call/${enc}`, 'Call mode', { sub: true }));
    }
  }

  nav.appendChild(h('div', { class: 'nav__group', text: 'Records' }));
  nav.appendChild(navLink('#/add', 'Add a lead'));
  nav.appendChild(navLink('#/history', 'Call history', { count: state.historyCount ?? null }));
  nav.appendChild(navLink('#/runs', 'Searches', { count: state.runs.length || null }));
  nav.appendChild(navLink('#/settings', 'Settings', {}));
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

  // Counts in the nav and strip must reflect what just happened (an outcome
  // logged, a check finished), so state is refreshed on every navigation.
  try { await refresh(); } catch { renderNav(); }

  clear(root);
  const stage = stageForPath(path);
  // Call mode is deliberately stripless: full-bleed, heads-down, its own
  // progress bar.
  if (stage && !path.startsWith('/call/')) root.appendChild(stageStrip(stage));
  const inner = h('div');
  root.appendChild(inner);
  inner.appendChild(h('div', { class: 'skeleton', style: { height: '18px', width: '160px' } }));

  try {
    const mod = await import(`./views/${route.r.view}.js`);
    current = mod;
    clear(inner);
    await mod.render(inner, {
      api, state, navigate, toast, refresh,
      ...route.r.args(route.m),
    });
  } catch (err) {
    clear(inner);
    inner.appendChild(errorPane(err));
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
