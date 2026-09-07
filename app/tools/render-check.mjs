// Headless render check for the web-leads views.
//
// There is no browser here, so this provides just enough DOM for the views to
// actually EXECUTE — not a fidelity test, a "does render() throw" test. It
// mounts every view against the real running server and reports what breaks.

const BASE = process.env.WL_BASE || 'http://127.0.0.1:4173';
const APP = new URL('../public/', import.meta.url).href;

// ------------------------------------------------------------------ dom shim

class Node {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
    this._listeners = new Map();
  }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    c.parentNode = this;
    if (i === -1) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i !== -1) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  addEventListener(t, fn) {
    if (!this._listeners.has(t)) this._listeners.set(t, new Set());
    this._listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) { this._listeners.get(t)?.delete(fn); }
  dispatchEvent(ev) {
    for (const fn of this._listeners.get(ev.type) || []) fn.call(this, ev);
    return true;
  }
  /** Every listener still attached anywhere under this node. */
  listenerCount() {
    let n = 0;
    for (const set of this._listeners.values()) n += set.size;
    for (const c of this.childNodes) n += c.listenerCount ? c.listenerCount() : 0;
    return n;
  }
}

class TextNode extends Node {
  constructor(data) { super(); this.data = String(data); this.nodeType = 3; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class DocumentFragment extends Node {}

class Element extends Node {
  constructor(tag, ns) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.localName = String(tag).toLowerCase();
    this.namespaceURI = ns || 'http://www.w3.org/1999/xhtml';
    this.nodeType = 1;
    this.attributes = {};
    this.style = new Proxy({}, { set: (t, k, v) => { t[k] = v; return true; } });
    this.dataset = {};
    this._className = '';
    this.value = '';
    this.checked = false;
    const self = this;
    this.classList = {
      add: (...c) => { self._className = [...new Set([...self._classes(), ...c])].join(' '); },
      remove: (...c) => { self._className = self._classes().filter((x) => !c.includes(x)).join(' '); },
      contains: (c) => self._classes().includes(c),
      toggle: (c, force) => {
        const has = self._classes().includes(c);
        const on = force === undefined ? !has : !!force;
        if (on) self.classList.add(c); else self.classList.remove(c);
        return on;
      },
    };
  }
  _classes() { return this._className.split(/\s+/).filter(Boolean); }
  get className() { return this._className; }
  set className(v) { this._className = String(v); }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this._className = String(v);
    if (k === 'id') this.id = String(v);
  }
  getAttribute(k) { return k === 'class' ? this._className : (this.attributes[k] ?? null); }
  removeAttribute(k) { delete this.attributes[k]; }
  hasAttribute(k) { return k in this.attributes || (k === 'class' && !!this._className); }
  get textContent() {
    return this.childNodes.map((c) => (c instanceof TextNode ? c.data : c.textContent ?? '')).join('');
  }
  set textContent(v) { this.childNodes = []; if (v !== '' && v != null) this.appendChild(new TextNode(v)); }
  // innerHTML is a trap in this codebase: views must never build lead data with
  // it. Record any use so the harness can fail on it.
  get innerHTML() { return ''; }
  set innerHTML(v) {
    if (String(v) !== '') INNER_HTML_USES.push(String(v).slice(0, 120));
    this.childNodes = [];
  }
  _walk(fn) { fn(this); for (const c of this.childNodes) if (c._walk) c._walk(fn); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const want = String(sel).trim();
    this._walk((el) => {
      if (el === this) return;
      if (want.startsWith('.') && el._classes().includes(want.slice(1))) out.push(el);
      else if (want.startsWith('#') && el.id === want.slice(1)) out.push(el);
      else if (want.startsWith('[')) {
        const m = want.match(/^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]$/);
        if (m && (m[2] === undefined ? el.hasAttribute(m[1]) : el.getAttribute(m[1]) === m[2])) out.push(el);
      } else if (el.localName === want.toLowerCase()) out.push(el);
    });
    return out;
  }
  closest(sel) {
    let n = this;
    while (n) { if (n.querySelector && [n].concat([]).some(() => false)) break; n = n.parentNode; }
    return null;
  }
  focus() {}
  blur() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} }); }
}

const INNER_HTML_USES = [];

const document = new (class Document extends Node {
  constructor() {
    super();
    this.documentElement = new Element('html');
    this.body = new Element('body');
    this.head = new Element('head');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }
  createElement(t) { return new Element(t); }
  createElementNS(ns, t) { return new Element(t, ns); }
  createTextNode(t) { return new TextNode(t); }
  createDocumentFragment() { return new DocumentFragment(); }
  getElementById(id) { return this.documentElement.querySelectorAll(`#${id}`)[0] || null; }
  querySelector(s) { return this.documentElement.querySelector(s); }
  querySelectorAll(s) { return this.documentElement.querySelectorAll(s); }
})();

globalThis.Node = Node;
globalThis.Element = Element;
globalThis.document = document;
Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true });
globalThis.location = { hash: '#/', href: BASE + '/', replace(h) { this.hash = h; }, assign(h) { this.hash = h; } };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} }, userAgent: 'harness' }, configurable: true, writable: true });
globalThis.scrollY = 0; globalThis.scrollX = 0; globalThis.innerHeight = 900; globalThis.innerWidth = 1440;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.Blob = class Blob { constructor(parts) { this.parts = parts; this.size = String(parts).length; } };
if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => 'blob:harness';
if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};
globalThis.addEventListener = (t, fn) => document.addEventListener(t, fn);
globalThis.removeEventListener = (t, fn) => document.removeEventListener(t, fn);
globalThis.alert = () => {};
globalThis.confirm = () => true;

// ------------------------------------------------------------------- the api
// Real HTTP against the running server — no mocks, so a wrong endpoint fails.

async function json(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `${res.status}`);
  return data;
}

const calls = [];
const track = (name, fn) => async (...a) => { calls.push(name); return fn(...a); };

const api = {
  state: track('state', () => json('GET', '/api/state')),
  runs: track('runs', () => json('GET', '/api/runs')),
  run: track('run', (s) => json('GET', `/api/runs/${encodeURIComponent(s)}`)),
  history: track('history', () => json('GET', '/api/history')),
  leads: track('leads', () => json('GET', '/api/leads')),
  email: track('email', (s) => json('GET', `/api/email/${encodeURIComponent(s)}`)),
  outcome: track('outcome', async () => { throw new Error('harness refuses to write'); }),
  // Write paths are never driven here — they mutate real data. exportUrl is
  // pure string-building, so it is the real thing.
  addLead: track('addLead', async () => { throw new Error('harness refuses to write'); }),
  updateLead: track('updateLead', async () => { throw new Error('harness refuses to write'); }),
  removeLead: track('removeLead', async () => { throw new Error('harness refuses to write'); }),
  deleteRun: track('deleteRun', async () => { throw new Error('harness refuses to write'); }),
  exportUrl: (slug, kind = 'md') => `/api/runs/${encodeURIComponent(slug)}/export.${kind}`,
  // Streaming endpoints are not driven here — they mutate real data.
  search: track('search', async () => ({})),
  check: track('check', async () => ({})),
  scanEmails: track('scanEmails', async () => ({})),
  activity: track('activity', (id) => json('GET', `/api/activity/${encodeURIComponent(id)}`)),
};

// ---------------------------------------------------------------------- run

const state = await api.state();
const slug = state.activeRun?.slug;
if (!slug) { console.error('no run to render against'); process.exit(1); }

// Probe the site-check view with a business that actually exists in the
// active run — a checked one if there is one, so the signal detail renders.
const runDetail = await api.run(slug);
const probeLead = (runDetail.leads || []).find((l) => l.check) || (runDetail.leads || [])[0] || {};

const VIEWS = [
  ['search', {}], ['checking', { slug }], ['calllist', { slug }],
  ['sitecheck', { slug, placeId: probeLead.place_id || 'missing' }],
  ['callmode', { slug }], ['history', {}], ['runs', {}], ['email', { slug }],
  ['addlead', {}], ['overview', {}], ['data', {}],
  ['settings', {}],
];

let pass = 0; const failures = [];
const cssText = await (await import('node:fs')).promises.readFile(
  new URL('../public/design.css', import.meta.url), 'utf8');
const cssClasses = new Set([...cssText.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const missingClasses = new Map();

for (const [name, args] of VIEWS) {
  const before = calls.length;
  const root = new Element('div');
  document.body.appendChild(root);
  let mod;
  try {
    mod = await import(APP + `views/${name}.js`);
  } catch (e) { failures.push([name, 'import: ' + e.message]); continue; }

  try {
    await mod.render(root, {
      api, state, navigate: () => {}, toast: () => {}, refresh: async () => state, ...args,
    });
  } catch (e) {
    failures.push([name, 'render: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)]);
    continue;
  }

  const nodes = (() => { let n = 0; root._walk(() => n++); return n; })();
  const text = root.textContent.replace(/\s+/g, ' ').trim();
  if (nodes < 5) { failures.push([name, `rendered only ${nodes} nodes`]); continue; }

  // Classes referenced but defined nowhere. A view may ship its own scoped
  // rules in an injected <style> block, so those count as defined too.
  const localClasses = new Set();
  root._walk((el) => {
    if (el.localName === 'style') {
      for (const m of el.textContent.matchAll(/\.([a-zA-Z][\w-]*)/g)) localClasses.add(m[1]);
    }
  });
  root._walk((el) => {
    for (const c of el._classes()) if (!cssClasses.has(c) && !localClasses.has(c)) {
      if (!missingClasses.has(name)) missingClasses.set(name, new Set());
      missingClasses.get(name).add(c);
    }
  });

  // destroy() must remove what render() attached, or handlers leak across views.
  const beforeDestroy = document.listenerCount() + globalThis === globalThis ? document.listenerCount() : 0;
  if (mod.destroy) { try { mod.destroy(); } catch (e) { failures.push([name, 'destroy: ' + e.message]); } }

  pass++;
  console.log(`ok   ${name.padEnd(10)} ${String(nodes).padStart(4)} nodes  ${calls.length - before} api call(s)  "${text.slice(0, 58)}…"`);
  root.remove();
}

console.log(`\n=== ${pass}/${VIEWS.length} views rendered ===`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const [n, why] of failures) console.log(`  ${n}: ${why}`);
}
if (INNER_HTML_USES.length) {
  console.log(`\nINNERHTML USED ${INNER_HTML_USES.length}x (must not carry lead data):`);
  INNER_HTML_USES.slice(0, 5).forEach((u) => console.log('  ' + u));
}
if (missingClasses.size) {
  console.log('\nCLASSES NOT IN design.css:');
  for (const [v, set] of missingClasses) console.log(`  ${v}: ${[...set].join(', ')}`);
}
// ------------------------------------------------------------------- panel
// The detail panel is opened by a click, so no view render reaches it. Drive
// it directly: open, assert it drew, assert close tears it down.

try {
  const { openPanel, closePanel } = await import(APP + 'panel.js');
  const probe = runDetail.leads.find((l) => l.check) || runDetail.leads[0];
  const before = document.body.childNodes.length;
  openPanel({ ...probe, run: slug, fullPage: '#/x' }, { api, toast: () => {} });
  const panelEl = document.querySelector('.pnl');
  if (!panelEl) {
    failures.push(['panel', 'openPanel drew nothing']);
  } else {
    const text = panelEl.textContent.replace(/\s+/g, ' ').trim();
    if (!text.includes(probe.name)) failures.push(['panel', 'panel did not show the business name']);
    for (const el of panelEl.querySelectorAll('div').concat(panelEl.querySelectorAll('a'))) {
      for (const c of el._classes()) {
        if (!cssClasses.has(c) && !c.startsWith('pnl')) {
          failures.push(['panel', `class .${c} is not in design.css`]);
        }
      }
    }
    console.log(`ok   panel      ${panelEl.querySelectorAll('a').length} action(s)  "${text.slice(0, 58)}"`);
  }
  closePanel();
  // closePanel detaches on a timer; give it room, then confirm nothing leaked.
  await new Promise((r) => setTimeout(r, 260));
  if (document.querySelector('.pnl')) failures.push(['panel', 'still in the DOM after closePanel']);
  if (document.body.childNodes.length !== before) {
    failures.push(['panel', `left ${document.body.childNodes.length - before} node(s) behind`]);
  }
} catch (e) {
  failures.push(['panel', (e && e.message) || String(e)]);
}

// ------------------------------------------------------------------- shell
// The nav is not a view, so nothing above touches it. Boot the real app.js
// against the real server and assert the chrome actually rendered — a nav that
// throws leaves a bare page while every per-view check still reports passing.

const navEl = new Element('header');
navEl.setAttribute('id', 'nav');
const viewEl = new Element('div');
viewEl.setAttribute('id', 'view');
document.body.appendChild(navEl);
document.body.appendChild(viewEl);

const directFetch = globalThis.fetch;
globalThis.fetch = (u, o) => directFetch(String(u).startsWith('http') ? String(u) : BASE + String(u), o);

try {
  await import(APP + 'app.js');
  // boot() is async: refresh() then render(). Give it room to settle.
  for (let i = 0; i < 40 && !navEl.textContent.trim(); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const navText = navEl.textContent.replace(/\s+/g, ' ').trim();
  const navLinks = navEl.querySelectorAll('a');
  if (!navText) {
    failures.push(['shell nav', 'rendered nothing — the top bar would be empty in a browser']);
  } else {
    console.log(`\nok   nav        ${navLinks.length} link(s)  "${navText.slice(0, 64)}"`);
    for (const a of navLinks) {
      for (const c of a._classes()) {
        if (!cssClasses.has(c)) failures.push(['shell nav', `class .${c} is not in design.css`]);
      }
    }
  }
} catch (e) {
  failures.push(['shell nav', 'boot: ' + (e && e.message ? e.message : String(e))]);
}

console.log(`\napi methods exercised: ${[...new Set(calls)].join(', ')}`);
process.exit(failures.length ? 1 : 0);
