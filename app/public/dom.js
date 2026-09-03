// Tiny DOM helpers. Everything the views build goes through h(), which sets
// text via textContent — business names and reason lines come from a
// third-party API and are never trusted as markup.

export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') throw new Error('h(): raw html is not allowed');
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  add(el, children);
  return el;
}

function add(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === '') continue;
    if (Array.isArray(c)) add(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  add(f, children);
  return f;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

// --------------------------------------------------------------- icons

const NS = 'http://www.w3.org/2000/svg';

/** Stroke icons on a 24px grid, one consistent weight. */
export function icon(name, { size = 16, stroke = 'currentColor', width = 1.9, fill = 'none', cls = '' } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', name === 'star' ? stroke : fill);
  if (name !== 'star') {
    svg.setAttribute('stroke', stroke);
    svg.setAttribute('stroke-width', width);
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  }
  if (cls) svg.setAttribute('class', cls);
  svg.style.flexShrink = '0';
  for (const d of PATHS[name] || []) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  for (const c of CIRCLES[name] || []) {
    const el = document.createElementNS(NS, 'circle');
    el.setAttribute('cx', c[0]); el.setAttribute('cy', c[1]); el.setAttribute('r', c[2]);
    if (c[3]) el.setAttribute('fill', stroke);
    svg.appendChild(el);
  }
  return svg;
}

const PATHS = {
  star: ['M12 3.4l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.8l6-.9z'],
  check: ['M20 6L9 17l-5-5'],
  dash: ['M6 12h12'],
  plus: ['M5 12h14', 'M12 5v14'],
  minus: ['M5 12h14'],
  chevronDown: ['M6 9l6 6 6-6'],
  chevronLeft: ['M15 6l-6 6 6 6'],
  chevronRight: ['M9 6l6 6-6 6'],
  arrowRight: ['M4 12h15', 'M13 6l6 6-6 6'],
  arrowLeft: ['M20 12H5', 'M11 6l-6 6 6 6'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  search: ['M16.5 16.5L21 21'],
  pin: ['M20 10.5c0 5.5-8 12-8 12s-8-6.5-8-12a8 8 0 0 1 16 0z'],
  phone: ['M8.5 4.6l1.6 3.3-1.9 1.9a13 13 0 0 0 5.9 5.9l1.9-1.9 3.4 1.6v3.1c0 .9-.8 1.6-1.7 1.5A16.4 16.4 0 0 1 4.4 6.2 1.6 1.6 0 0 1 6 4.5z'],
  phoneOff: ['M4 4l16 16', 'M8.5 4.6l1.6 3.3-1.9 1.9a13 13 0 0 0 5.9 5.9l1.9-1.9 3.4 1.6v3.1c0 .9-.8 1.6-1.7 1.5A16.4 16.4 0 0 1 4.4 6.2 1.6 1.6 0 0 1 6 4.5z'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1.6 1.6 0 0 1-1.6 1.6H5A1.6 1.6 0 0 1 3.4 19V7.6A1.6 1.6 0 0 1 5 6h5'],
  download: ['M12 4v11', 'M8 11l4 4 4-4', 'M4 19h16'],
  mail: ['M3 7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5z', 'M3.6 7l8.4 6 8.4-6'],
  eyeOff: ['M3 3l18 18', 'M10.6 6.2A9.6 9.6 0 0 1 12 6.1c5 0 9 5.9 9 5.9a17 17 0 0 1-2.7 3.3M6.5 7.6A17.4 17.4 0 0 0 3 12s4 5.9 9 5.9a8.9 8.9 0 0 0 4-1', 'M9.9 9.9a3 3 0 0 0 4.2 4.2'],
  alert: ['M12 8v5', 'M12 16.5v.1'],
  info: ['M12 11v5', 'M12 7.5v.1'],
  spinner: ['M12 4a8 8 0 0 1 8 8'],
  noAnswer: ['M6.6 12h10.8'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
};

const CIRCLES = {
  search: [[11, 11, 7]],
  pin: [[12, 10.5, 2.8]],
  alert: [[12, 12, 9]],
  info: [[12, 12, 9]],
  circle: [[12, 12, 8]],
  dot: [[12, 12, 7, true]],
  noAnswer: [[12, 12, 8]],
};

// ---------------------------------------------------------- formatting

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtShortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
}

export function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

/** Host without www, for showing a website compactly. */
export function prettyHost(url) {
  if (!url) return '';
  try {
    const u = new URL(url.includes('//') ? url : `http://${url}`);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname.replace(/\/$/, '');
    return path && path !== '' ? `${host}${path.length > 22 ? path.slice(0, 22) + '…' : path}` : host;
  } catch { return url; }
}

export const STATUS_LABEL = {
  no_answer: 'No answer',
  call_back: 'Call back',
  not_interested: 'Not interested',
  interested: 'Interested',
};

/** The dot that shows call state at a glance down the list. */
export function statusDot(status) {
  if (status === 'interested') return icon('dot', { size: 10, stroke: '#2a251d' });
  if (status === 'no_answer' || status === 'call_back') return icon('noAnswer', { size: 10, stroke: '#8d8577', width: 2 });
  if (status === 'not_interested') return icon('x', { size: 10, stroke: '#a89f8e', width: 2.2 });
  return icon('circle', { size: 10, stroke: '#c4bba9', width: 2 });
}

export function meta(...parts) {
  const out = [];
  parts.filter((p) => p !== null && p !== undefined && p !== '').forEach((p, i) => {
    if (i) out.push(h('span', { class: 'dot-sep', text: '·' }));
    out.push(p instanceof Node ? p : h('span', { text: String(p) }));
  });
  return out;
}

export function ratingBits(lead) {
  if (lead.rating === null || lead.rating === undefined || lead.rating === '') return [];
  return [
    h('span', { class: 'tnum', style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
      icon('star', { size: 11, stroke: '#8d8577' }), String(lead.rating)),
    lead.reviews ? h('span', { style: { color: 'var(--ink-4)' }, text: plural(lead.reviews, 'review', 'reviews') }) : null,
  ].filter(Boolean);
}
