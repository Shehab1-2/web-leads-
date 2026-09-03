// Stage 2: look at the sites that survived stage 1 and decide whether they are
// worth a phone call.
//
// This is an HTTP-only checker. There is no browser here, so the two visual
// signals (`not_mobile_friendly`, `dated_design_era`) are always emitted with
// `found: null` and are never scored - the verdicts below are the conservative
// floor described in CLAUDE.md, not a full visual read. Everything a `reason`
// line claims is something this module actually pulled off the wire.
//
// Redirects are followed by hand rather than by fetch() so every hop stays
// visible: an http:// address that 301s to https:// and then fails the TLS
// handshake is unreachable in a real browser and has to come out as
// `dead_site`, which a client that only reports the final error would hide.

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

// ---------------------------------------------------------------- constants

/** Sent first. Honest about what it is; some hosts dislike it - see BROWSER_UA. */
export const DEFAULT_UA = 'Mozilla/5.0 (compatible; web-leads-sitecheck/1.0)';

/**
 * Retry UA. Hosts behind mod_security routinely 403 or reset anything that
 * looks like a script while serving the same page fine to Chrome. One retry
 * with this happens before any site is called dead, because the difference
 * between "dead domain" and "live site" is the whole verdict.
 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

export const MAX_REDIRECTS = 10;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * How far behind the current year a footer year has to be to count as stale.
 *
 * references/outdated_signals.md says "more than about three years old". A bare
 * "2023" notice read in September 2026 is somewhere between 2.7 and 3.7 years
 * old, and the rubric says to keep a borderline site on the list with a lighter
 * pitch rather than force it off, so a three-calendar-year gap is the boundary.
 * Set this to 4 for the strict "strictly more than three years" reading.
 */
export const STALE_GAP_YEARS = 3;

export const SIGNAL_LABELS = {
  no_https: 'No HTTPS',
  no_viewport: 'No viewport meta tag',
  stale_copyright: 'Stale copyright',
  broken_elements: 'Broken elements',
  untouched_template: 'Untouched template',
  not_mobile_friendly: 'Not mobile-friendly',
  dated_design_era: 'Dated design era',
};

/** Scored, in the order they read best in a reason line. */
export const OBJECTIVE_SIGNAL_IDS = [
  'no_viewport', 'no_https', 'stale_copyright', 'broken_elements', 'untouched_template',
];

/** Never scored: there is no browser in this process. */
export const VISUAL_SIGNAL_IDS = ['not_mobile_friendly', 'dated_design_era'];

/**
 * A link to one of these is not the business's own website. Mirrors
 * SOCIAL_HOSTS in scripts/find_businesses.py, plus the booking hosts below:
 * stage 1 classifies from the Maps URL alone and lets e.g. squareup.com through
 * as `needs_check`, while README.md is explicit that a Square booking page is
 * `social_only`.
 */
export const SOCIAL_HOSTS = new Set([
  'facebook.com', 'm.facebook.com', 'fb.com', 'fb.me',
  'instagram.com', 'linktr.ee', 'linkin.bio', 'beacons.ai', 'carrd.co',
  'business.site', 'sites.google.com',
  'yelp.com', 'nextdoor.com', 'tripadvisor.com',
  'twitter.com', 'x.com', 'tiktok.com', 'youtube.com', 'linkedin.com',
  'wa.me', 'api.whatsapp.com', 't.me',
  'google.com', 'goo.gl', 'maps.app.goo.gl',
]);

/** How a social host is said out loud on a call. */
export const SOCIAL_NAMES = new Map([
  ['facebook.com', 'a Facebook page'],
  ['m.facebook.com', 'a Facebook page'],
  ['fb.com', 'a Facebook page'],
  ['fb.me', 'a Facebook page'],
  ['instagram.com', 'an Instagram profile'],
  ['linktr.ee', 'a Linktree'],
  ['beacons.ai', 'a Beacons link page'],
  ['linkin.bio', 'a link-in-bio page'],
  ['carrd.co', 'a one-page Carrd'],
  ['business.site', 'the free page Google generated for them'],
  ['sites.google.com', 'a Google Sites page'],
  ['yelp.com', 'their Yelp listing'],
  ['nextdoor.com', 'their Nextdoor page'],
  ['tripadvisor.com', 'their TripAdvisor listing'],
  ['twitter.com', 'a Twitter profile'],
  ['x.com', 'an X profile'],
  ['tiktok.com', 'a TikTok profile'],
  ['youtube.com', 'a YouTube channel'],
  ['linkedin.com', 'a LinkedIn page'],
  ['wa.me', 'a WhatsApp link'],
  ['api.whatsapp.com', 'a WhatsApp link'],
  ['t.me', 'a Telegram link'],
]);

/** Booking/scheduling pages: an audience, but nowhere of their own to send it. */
export const BOOKING_HOSTS = new Map([
  ['squareup.com', 'a Square booking page'],
  ['square.site', 'a Square booking page'],
  ['booksy.com', 'a Booksy booking page'],
  ['vagaro.com', 'a Vagaro booking page'],
  ['styleseat.com', 'a StyleSeat profile'],
  ['schedulicity.com', 'a Schedulicity booking page'],
  ['fresha.com', 'a Fresha booking page'],
  ['glossgenius.com', 'a GlossGenius booking page'],
  ['setmore.com', 'a Setmore booking page'],
  ['acuityscheduling.com', 'an Acuity booking page'],
  ['calendly.com', 'a Calendly page'],
  ['opentable.com', 'an OpenTable page'],
  ['toasttab.com', 'a Toast ordering page'],
]);

/** Free/entry-tier subdomains. Same list as stage 1. */
export const FREE_HOSTS = new Set([
  'wixsite.com', 'weebly.com', 'blogspot.com', 'wordpress.com',
  'godaddysites.com', 'webnode.com', 'jimdosite.com',
  'yolasite.com', 'tripod.com', 'angelfire.com', 'webs.com',
  'myfreesites.net', 'site123.me', 'strikingly.com',
]);

/** Substrings that only ever appear on a parked, expired or for-sale page. */
const PARKING_MARKERS = [
  ['parking-lander', 'a GoDaddy parking lander'],
  ['ap:"parking"', 'a GoDaddy parking lander'],
  ["ap:'parking'", 'a GoDaddy parking lander'],
  ['parkingcrew', 'a ParkingCrew lander'],
  ['sedoparking', 'a Sedo parking page'],
  ['bodis.com', 'a Bodis parking page'],
  ['afternic.com', 'an Afternic for-sale page'],
  ['hugedomains.com', 'a HugeDomains for-sale page'],
  ['dan.com/buy-domain', 'a Dan.com for-sale page'],
  ['cashparking', 'a GoDaddy CashParking page'],
  ['this domain is parked', 'a parked-domain notice'],
  ['domain is parked', 'a parked-domain notice'],
  ['this domain has expired', 'an expired-domain notice'],
  ['domain is for sale', 'a domain-for-sale page'],
  ['buy this domain', 'a domain-for-sale page'],
  ['the domain name you requested', 'a registrar holding page'],
  ['future home of something quite cool', 'a default hosting placeholder page'],
  ['welcome to nginx', 'a default nginx placeholder page'],
  ['apache2 ubuntu default page', 'a default Apache placeholder page'],
];

/**
 * Platform fingerprints, first match wins, so the specific retired builders sit
 * above the generic ones. `retired` marks a product the vendor has stopped
 * selling: a site still running on one has not been rebuilt in years, which is
 * exactly what `untouched_template` is trying to catch. A current Wix or Weebly
 * site is NOT a signal on its own - plenty of well-kept sites are built on them.
 */
const PLATFORMS = [
  { name: 'GoDaddy Website Builder 7', retired: true, test: (h) => /go\s?daddy website builder\s*7/i.test(h) },
  { name: 'Microsoft FrontPage', retired: true, test: (h) => /content=["'][^"']*frontpage|_vti_bin|<!--\s*mstheme/i.test(h) },
  { name: 'Adobe Muse', retired: true, test: (h) => /content=["']adobe muse/i.test(h) },
  { name: 'Apple iWeb', retired: true, test: (h) => /content=["']iweb/i.test(h) },
  { name: 'Yahoo SiteBuilder', retired: true, test: (h) => /yahoo!? ?sitebuilder/i.test(h) },
  { name: 'Dreamweaver template', retired: true, test: (h) => /dwsync\.xml|InstanceBegin template=/i.test(h) },
  { name: 'GoDaddy Website Builder', test: (h) => /go\s?daddy website builder|nebula\.wsimg\.com|wsb-canvas/i.test(h) },
  { name: 'GoDaddy Websites + Marketing', test: (h) => /websites\s*\+\s*marketing|img1\.wsimg\.com\/isteam/i.test(h) },
  { name: 'Wix', test: (h) => /static\.wixstatic\.com|wix\.com website builder|wixsite\.com|X-Wix-/i.test(h) },
  { name: 'Squarespace', test: (h) => /static1\.squarespace\.com|squarespace\.com|SQUARESPACE_CONTEXT/i.test(h) },
  { name: 'Weebly', test: (h) => /weebly\.com|editmysite\.com|content=["']weebly/i.test(h) },
  { name: 'Duda', test: (h) => /irp\.cdn-website\.com|dudamobile|content=["']duda/i.test(h) },
  { name: 'Webflow', test: (h) => /content=["']webflow|data-wf-page|assets\.website-files\.com/i.test(h) },
  { name: 'Shopify', test: (h) => /cdn\.shopify\.com|Shopify\.theme/i.test(h) },
  { name: 'Joomla', test: (h) => /content=["']joomla|\/media\/jui\/|option=com_content/i.test(h) },
  { name: 'Google Sites', test: (h) => /sites\.google\.com|_\/scs\/apps-static/i.test(h) },
  { name: 'Jimdo', test: (h) => /jimdo\.com|jimstatic\.com/i.test(h) },
  { name: 'Site123', test: (h) => /site123\.me|content=["']site123/i.test(h) },
  { name: 'WordPress', test: (h) => /wp-content|wp-includes|content=["']wordpress/i.test(h) },
];

// ------------------------------------------------------------- http layer

function classifyNetworkError(err) {
  const code = err && err.code ? String(err.code) : '';
  const msg = err && err.message ? err.message : String(err);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { kind: 'dns', text: 'the domain does not resolve' };
  }
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT' || /timed? ?out/i.test(msg)) {
    return { kind: 'timeout', text: 'the server did not respond in time' };
  }
  if (code === 'CERT_HAS_EXPIRED') {
    return { kind: 'tls', text: 'the security certificate has expired' };
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return { kind: 'tls', text: 'the security certificate is issued for a different domain' };
  }
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return { kind: 'tls', text: 'the security certificate is self-signed, so browsers reject it' };
  }
  if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'EPROTO' || code.startsWith('ERR_SSL')) {
    return { kind: 'tls', text: 'the secure connection could not be established' };
  }
  if (code === 'ECONNRESET') {
    return {
      kind: /TLS|SSL|secure/i.test(msg) ? 'tls' : 'reset',
      text: /TLS|SSL|secure/i.test(msg)
        ? 'the secure connection was dropped before it completed'
        : 'the server dropped the connection',
    };
  }
  if (code === 'ECONNREFUSED') return { kind: 'refused', text: 'the server refused the connection' };
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return { kind: 'refused', text: 'the server is unreachable' };
  }
  return { kind: 'network', text: msg };
}

/**
 * One request, no redirect following. Always resolves - a transport failure
 * comes back as `{ err }` rather than throwing, because every hop's outcome is
 * part of the verdict.
 */
function requestOnce(urlStr, { method = 'GET', ua, timeoutMs, maxBytes = MAX_BODY_BYTES, signal }) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      resolve({ url: urlStr, err: { kind: 'bad_url', text: 'the address is not a valid URL' } });
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      resolve({ url: urlStr, err: { kind: 'bad_url', text: `unsupported scheme ${url.protocol}` } });
      return;
    }

    const mod = url.protocol === 'https:' ? https : http;
    const budget = Math.max(1000, timeoutMs);
    let settled = false;
    let req = null;
    let onAbort = null;

    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const fail = (err) => done({ url: urlStr, err: classifyNetworkError(err) });

    const timer = setTimeout(() => {
      if (req) req.destroy(Object.assign(new Error('timed out'), { code: 'TIMEOUT' }));
      done({
        url: urlStr,
        err: { kind: 'timeout', text: `no response within ${Math.round(budget / 1000)}s` },
      });
    }, budget);

    if (signal) {
      if (signal.aborted) {
        done({ url: urlStr, err: { kind: 'aborted', text: 'cancelled' } });
        return;
      }
      onAbort = () => {
        if (req) req.destroy();
        done({ url: urlStr, err: { kind: 'aborted', text: 'cancelled' } });
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req = mod.request(url, {
      method,
      headers: {
        'user-agent': ua,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        connection: 'close',
      },
    }, (res) => {
      const status = res.statusCode || 0;
      const headers = res.headers || {};
      if (method === 'HEAD') {
        res.resume();
        done({ url: urlStr, status, headers, body: '' });
        return;
      }

      const enc = String(headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      try {
        if (enc.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      } catch {
        stream = res;
      }

      const chunks = [];
      let bytes = 0;
      const finish = () => done({
        url: urlStr, status, headers, body: Buffer.concat(chunks).toString('utf8'),
      });
      stream.on('data', (c) => {
        bytes += c.length;
        if (bytes <= maxBytes) chunks.push(c);
        else { res.destroy(); finish(); }
      });
      stream.on('end', finish);
      // A truncated or mislabelled compressed body still tells us plenty; keep
      // what arrived rather than throwing the whole page away.
      stream.on('error', () => (chunks.length ? finish() : fail(new Error('the response body could not be read'))));
      res.on('error', () => (chunks.length ? finish() : fail(new Error('the connection dropped mid-response'))));
    });

    req.on('error', fail);
    req.setTimeout(budget, () => {
      req.destroy(Object.assign(new Error('timed out'), { code: 'TIMEOUT' }));
    });
    req.end();
  });
}

/** `<meta http-equiv="refresh" content="0;url=...">`, or a top-level JS assignment. */
function clientSideRedirectTarget(body) {
  const meta = body.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/i);
  if (meta) {
    const m = meta[0].match(/content=["']?\s*\d+\s*;\s*url=([^"'>\s]+)/i);
    if (m) return { target: m[1], how: 'a meta refresh' };
  }
  const js = body.match(
    /(?:window\.)?location(?:\.href)?\s*(?:=|\.replace\s*\(|\.assign\s*\()\s*["']([^"']+)["']/i,
  );
  if (js) return { target: js[1], how: 'a JavaScript redirect' };
  return null;
}

/**
 * Follow the chain by hand, keeping every hop.
 *
 * Client-side redirects are only followed out of a near-empty page: that shape
 * is either a redirect shim or a parked domain bouncing to /lander, and both
 * need the destination before they can be judged. A real page that happens to
 * assign window.location somewhere in its scripts is left alone.
 */
async function fetchChain(startUrl, { ua, timeoutMs, signal }) {
  const hops = [];
  const seen = new Set();
  let current = startUrl;
  let clientHops = 0;
  const deadline = Date.now() + timeoutMs;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const key = current.replace(/#.*$/, '');
    if (seen.has(key)) {
      hops.push({ url: current, status: null, error: 'redirect loop' });
      return {
        hops, finalUrl: current,
        err: { kind: 'redirect_loop', text: 'the redirects loop back on themselves' },
      };
    }
    seen.add(key);

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        hops, finalUrl: current,
        err: { kind: 'timeout', text: `no response within ${Math.round(timeoutMs / 1000)}s` },
      };
    }

    const res = await requestOnce(current, { ua, timeoutMs: remaining, signal });
    if (res.err) {
      hops.push({ url: current, status: null, error: res.err.text, kind: res.err.kind });
      return { hops, finalUrl: current, err: res.err };
    }

    const loc = res.headers.location;
    if (res.status >= 300 && res.status < 400 && loc) {
      let next;
      try {
        next = new URL(loc, current).toString();
      } catch {
        hops.push({ url: current, status: res.status, error: `invalid Location header: ${loc}` });
        return {
          hops, finalUrl: current,
          err: { kind: 'bad_url', text: 'the redirect points at an invalid address' },
        };
      }
      hops.push({ url: current, status: res.status, to: next });
      current = next;
      continue;
    }

    const shim = res.body.length < 4000 ? clientSideRedirectTarget(res.body) : null;
    if (shim && clientHops < 2) {
      let next = null;
      try { next = new URL(shim.target, current).toString(); } catch { next = null; }
      if (next && next.replace(/#.*$/, '') !== key) {
        hops.push({ url: current, status: res.status, to: next, via: shim.how, body: res.body });
        current = next;
        clientHops += 1;
        continue;
      }
    }

    hops.push({ url: current, status: res.status });
    return { hops, finalUrl: current, status: res.status, headers: res.headers, body: res.body, err: null };
  }

  return {
    hops, finalUrl: current,
    err: { kind: 'redirect_loop', text: `more than ${MAX_REDIRECTS} redirects` },
  };
}

// ------------------------------------------------------------ html helpers

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&copy;': '(c)', '&#169;': '(c)', '&#xa9;': '(c)',
  '&mdash;': '-', '&ndash;': '-', '&#8211;': '-', '&#8212;': '-',
  '&#8216;': "'", '&#8217;': "'", '&#8220;': '"', '&#8221;': '"', '&#8203;': '',
};

function decodeEntities(s) {
  return s.replace(/&(?:#x?[0-9a-f]+|[a-z]+);/gi, (m) => {
    const key = m.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (ENTITIES[m] !== undefined) return ENTITIES[m];
    const dec = m.match(/^&#(\d+);$/);
    if (dec) {
      const n = Number(dec[1]);
      return n >= 32 && n < 0x10000 ? String.fromCharCode(n) : ' ';
    }
    return ' ';
  });
}

/** Markup with <script>/<style>/<!--comments--> removed. */
function stripCode(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/** Visible text, entities decoded, whitespace collapsed. */
function visibleText(html) {
  return decodeEntities(stripCode(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function findTitle(html) {
  const m = stripCode(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : null;
}

function findViewport(html) {
  const metas = stripCode(html).match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metas) {
    if (/name\s*=\s*["']?viewport["']?/i.test(tag)) {
      const c = tag.match(/content\s*=\s*["']([^"']*)["']/i);
      return { tag, content: c ? c[1].trim() : '' };
    }
  }
  return null;
}

function findGenerator(html) {
  const metas = stripCode(html).match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metas) {
    if (/name\s*=\s*["']?generator["']?/i.test(tag)) {
      const c = tag.match(/content\s*=\s*["']([^"']*)["']/i);
      if (c) return c[1].trim();
    }
  }
  return null;
}

export function hostOf(url) {
  if (!url) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Rough "last two labels" domain - enough to match the host lists. */
function registrable(host) {
  const parts = host.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : host;
}

/**
 * Is the listed "website" someone else's platform rather than a site of their
 * own? Stage 1 catches most of these from the URL; this catches the rest.
 */
function classifyHost(url) {
  const host = hostOf(url);
  if (!host) return null;
  const base = registrable(host);
  if (SOCIAL_HOSTS.has(host) || SOCIAL_HOSTS.has(base)) {
    return { kind: 'social_only', what: SOCIAL_NAMES.get(host) || SOCIAL_NAMES.get(base) || `a ${base} page` };
  }
  for (const [h, what] of BOOKING_HOSTS) {
    if (host === h || base === h || host.endsWith(`.${h}`)) return { kind: 'social_only', what };
  }
  for (const h of FREE_HOSTS) {
    if (base === h || host.endsWith(`.${h}`)) return { kind: 'free_host', what: `a free ${h} subdomain` };
  }
  return null;
}

// ------------------------------------------------------------ signal detail

/**
 * The newest year attached to a copyright notice. Scripts and styles are
 * stripped first: image dimensions ("height=2048"), asset hashes and analytics
 * config are full of four-digit numbers that are not years at all.
 */
function findFooterYear(html, now) {
  const text = visibleText(html);
  const thisYear = now.getFullYear();
  const inRange = (y) => y >= 1990 && y <= thisYear + 1;
  const years = [];

  const marker = /\(c\)|©|copyright|all rights reserved/gi;
  let m;
  while ((m = marker.exec(text)) !== null) {
    const window = text.slice(Math.max(0, m.index - 60), m.index + 120);
    for (const y of window.match(/\b(?:19|20)\d{2}\b/g) || []) {
      if (inRange(Number(y))) years.push(Number(y));
    }
  }

  if (!years.length) {
    // No copyright notice: fall back to any year inside a <footer> element.
    const footers = stripCode(html).match(/<footer\b[\s\S]*?<\/footer>/gi) || [];
    for (const f of footers) {
      for (const y of visibleText(f).match(/\b(?:19|20)\d{2}\b/g) || []) {
        if (inRange(Number(y))) years.push(Number(y));
      }
    }
  }

  return years.length ? Math.max(...years) : null;
}

function detectPlatform(html, finalUrl) {
  const generator = findGenerator(html);
  const haystack = `${generator || ''}\n${finalUrl}\n${html.slice(0, 200000)}`;
  for (const p of PLATFORMS) {
    if (p.test(haystack)) return { name: p.name, retired: !!p.retired, generator };
  }
  return { name: null, retired: false, generator };
}

const DEFAULT_TITLES = [
  'home page', 'untitled', 'untitled document', 'untitled page', 'new page 1',
  'my site', 'my website', 'website', 'site title', 'your website title',
  'new website', 'coming soon', 'index', 'default page', 'website builder',
  'your site name', 'example domain',
];

const PLACEHOLDER_COPY = [
  ['lorem ipsum', 'the page still has Lorem ipsum placeholder text'],
  ['dolor sit amet', 'the page still has Lorem ipsum placeholder text'],
  ['your text here', 'the page still has "Your text here" placeholder copy'],
  ['insert your text', 'the page still has "Insert your text" placeholder copy'],
  ['add your content here', 'the page still has "Add your content here" placeholder copy'],
  ['click here to edit', 'the page still has "Click here to edit" placeholder copy'],
  ['double click to edit', 'the page still has "Double click to edit" placeholder copy'],
  ['this is a sample page', 'the page still has sample-page placeholder copy'],
  ['your business name', 'the page still has "Your business name" placeholder copy'],
  ['tell people more about', 'the page still has the builder\'s default section copy'],
];

const NAV_WORDS = new Set(['home', 'about', 'about us', 'contact', 'contact us', 'services', 'gallery', 'blog', 'products']);

/**
 * Default-template giveaways. Deliberately narrow: being on Wix or Weebly is
 * not one of these. A retired builder, placeholder copy left in place, a nav
 * of dead default links, or a tab title that is still the raw domain are.
 */
function detectTemplateTells(html, platform, finalUrl) {
  // Each tell carries the evidence line for the signal list and the shorter
  // clause the reason line says out loud.
  const tells = [];
  if (platform.name && platform.retired) {
    tells.push({
      evidence: `built on ${platform.name}, a product its vendor has retired`,
      clause: `it\'s on the retired ${platform.name}`,
    });
  }

  const text = visibleText(html).toLowerCase();
  for (const [needle, phrase] of PLACEHOLDER_COPY) {
    if (text.includes(needle)) { tells.push({ evidence: phrase, clause: phrase }); break; }
  }

  const title = findTitle(html);
  if (title) {
    const whole = title.toLowerCase().trim();
    if (DEFAULT_TITLES.includes(whole)) {
      const t = `the browser tab still reads "${title}"`;
      tells.push({ evidence: t, clause: t });
    } else {
      // "jennyshairandbeautysalon - jennyshairandbeautysalon": every part of the
      // title is the bare domain with no spacing or capitalisation, which is the
      // builder's default, not a name anybody typed.
      const host = hostOf(finalUrl);
      const base = host.split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
      const parts = title.split(/\s*[|–—·:]\s*|\s+-\s+/).map((p) => p.trim()).filter(Boolean);
      const slugLike = parts.length > 0 && parts.every(
        (p) => !/\s/.test(p) && p.length >= 8 && p.replace(/[^a-z0-9]/gi, '').toLowerCase() === base,
      );
      if (slugLike && base.length >= 8) {
        const t = 'the browser tab title is still the raw domain name';
        tells.push({ evidence: t, clause: t });
      }
    }
  }

  // A default nav whose links all go nowhere.
  const anchors = stripCode(html).match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
  let dead = 0;
  for (const a of anchors) {
    const href = (a.match(/href\s*=\s*["']([^"']*)["']/i) || [, ''])[1].trim();
    const label = visibleText(a).toLowerCase();
    if ((href === '' || href === '#') && NAV_WORDS.has(label)) dead += 1;
  }
  if (dead >= 3) {
    const t = `${dead} of the main nav links still point nowhere (href="#")`;
    tells.push({ evidence: t, clause: t });
  }

  return tells;
}

/** Absolute URLs for the first `limit` real <img> sources on the page. */
function sampleImageUrls(html, finalUrl, limit) {
  const out = [];
  const seen = new Set();
  const tags = stripCode(html).match(/<img\b[^>]*>/gi) || [];
  for (const tag of tags) {
    let src = (tag.match(/\ssrc\s*=\s*["']([^"']+)["']/i) || [, ''])[1].trim();
    if (!src) {
      src = (tag.match(/\sdata-src\s*=\s*["']([^"']+)["']/i) || [, ''])[1].trim();
    }
    if (!src || /^data:|^about:|^javascript:/i.test(src)) continue;
    let abs;
    try { abs = new URL(decodeEntities(src), finalUrl).toString(); } catch { continue; }
    if (!/^https?:/i.test(abs) || seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * HEAD each sampled image, falling back to GET where HEAD is not allowed.
 * 401/403/429 are not counted: hotlink protection and rate limits are not the
 * same thing as a missing image, and a reason line has to survive being read
 * out loud to the owner.
 */
async function checkImages(urls, { ua, timeoutMs, signal }) {
  const results = await Promise.all(urls.map(async (u) => {
    let res = await requestOnce(u, { method: 'HEAD', ua, timeoutMs, signal });
    if (!res.err && (res.status === 405 || res.status === 501)) {
      res = await requestOnce(u, { method: 'GET', ua, timeoutMs, maxBytes: 4096, signal });
    }
    if (res.err) {
      const hard = res.err.kind === 'dns' || res.err.kind === 'refused';
      return { url: u, ok: !hard, status: null, why: hard ? res.err.text : null };
    }
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return { url: u, ok: true, status: res.status, why: null };
    }
    if (res.status >= 400) return { url: u, ok: false, status: res.status, why: `HTTP ${res.status}` };
    return { url: u, ok: true, status: res.status, why: null };
  }));
  return results;
}

function pathOf(url) {
  try {
    const u = new URL(url);
    const name = u.pathname.split('/').filter(Boolean).pop() || u.pathname;
    return name.length > 40 ? `${name.slice(0, 37)}...` : name;
  } catch {
    return url;
  }
}

function signal(id, found, evidence) {
  return { id, label: SIGNAL_LABELS[id], found, evidence };
}

/** The two signals that need a browser. Always null, never scored. */
function visualSignals() {
  return [
    signal('not_mobile_friendly', null, 'Not checked - needs a browser at a phone-width viewport.'),
    signal('dated_design_era', null, 'Not checked - needs a browser screenshot to judge.'),
  ];
}

/** All seven signals, marked unknown. Used when there is no page to read. */
function unknownSignals(why) {
  return [
    ...OBJECTIVE_SIGNAL_IDS.map((id) => signal(id, null, `Not checked - ${why}`)),
    ...visualSignals(),
  ];
}

// ---------------------------------------------------------------- scoring

/**
 * Count what was actually found and turn it into a tier.
 * 0 -> not_a_lead, 1-2 -> somewhat_dated, 3+ -> very_dated.
 *
 * `found: null` is never counted - an unchecked signal is not a clean one.
 * Sites that do not load at all are settled by checkSite before scoring, since
 * "unreachable" is not something a signal count can express.
 */
export function scoreSignals(signals) {
  const list = Array.isArray(signals) ? signals : [];
  const count = list.filter((s) => s && s.found === true).length;
  const tier = count === 0 ? 'not_a_lead' : count <= 2 ? 'somewhat_dated' : 'very_dated';
  return { tier, count };
}

// ------------------------------------------------------------ reason lines

function joinClauses(parts) {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]}, and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function capitalise(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function signalById(check, id) {
  return (check.signals || []).find((s) => s.id === id) || null;
}

/** What a broken image is, in words the caller can say without reading a URL. */
function describeImage(url) {
  let p = url.toLowerCase();
  try { p = new URL(url).pathname.toLowerCase(); } catch { /* keep the raw string */ }
  if (p.includes('captcha')) return 'the captcha image on their contact form';
  if (/\blogo\b/.test(p)) return 'the logo image';
  if (/banner|header|hero/.test(p)) return 'the banner image at the top';
  return `the image ${pathOf(url)}`;
}

/**
 * The clause each found signal contributes. Kept short and comma-free so three
 * of them still read as one sentence a person can say out loud.
 */
function clauseFor(check, sig) {
  switch (sig.id) {
    case 'no_viewport':
      return 'no mobile version (no viewport tag in the page source)';
    case 'no_https':
      return 'still on http so Chrome shows "Not secure" to every visitor';
    case 'stale_copyright':
      return `the footer copyright still reads ${check.footerYear}`;
    case 'broken_elements': {
      const broken = check.brokenImages || [];
      if (broken.length === 1) {
        return `${describeImage(broken[0].url)} doesn\'t load (${broken[0].why || 'no response'})`;
      }
      if (broken.length > 1) return `${broken.length} images on the page don\'t load`;
      return 'some images on the page don\'t load';
    }
    case 'untouched_template': {
      const clauses = check.templateTells || [];
      if (clauses.length) return clauses.join(' and ');
      const e = sig.evidence.replace(/\.$/, '');
      return e.charAt(0).toLowerCase() + e.slice(1);
    }
    default:
      return sig.evidence.replace(/\.$/, '');
  }
}

function deadReason(check) {
  const kind = check.errorKind;
  const hops = check.hops || [];
  const startedHttp = hops.length > 0 && hops[0].url.startsWith('http://');
  const failedHttps = String(check.finalUrl || '').startsWith('https://');

  if (check.parked) {
    const what = check.parkedAs || 'a placeholder page';
    return `The domain is registered but parked - it just bounces to ${what}, so there\'s no site behind it.`;
  }
  if (kind === 'dns') {
    return 'The site doesn\'t load - the domain doesn\'t resolve any more, so the address on their Google listing goes nowhere.';
  }
  if (kind === 'tls') {
    if (startedHttp && failedHttps && hops.length > 1) {
      return 'The site won\'t load - the http address redirects to https and the secure connection then fails, so browsers show an error page.';
    }
    const detail = (check.error || '').replace(/^.*?: /, '');
    return `The site won\'t load - ${detail || 'the secure connection fails'}, so browsers show a warning instead of the page.`;
  }
  if (kind === 'timeout') {
    return 'The site doesn\'t load - the server never answers, so visitors just get a spinner and leave.';
  }
  if (kind === 'refused' || kind === 'reset' || kind === 'network') {
    return 'The site doesn\'t load - the server refuses the connection, so the address on their Google listing goes nowhere.';
  }
  if (kind === 'redirect_loop') {
    return 'The site doesn\'t load - the address redirects in a loop, so browsers give up with an error.';
  }
  if (kind === 'http_error') {
    const s = check.httpStatus;
    if (s === 404) return 'The address on their Google listing returns a 404 - that page is gone.';
    if (s === 403) return 'The address on their Google listing returns a 403, so visitors are blocked from the page.';
    if (s && s >= 500) return `The site is returning a server error (HTTP ${s}) instead of the page.`;
    return `The site doesn\'t load - it returns HTTP ${s}.`;
  }
  if (kind === 'empty') {
    return 'The domain answers but serves an empty page - there\'s nothing there for a visitor to see.';
  }
  return 'The site doesn\'t load in a browser.';
}

function healthyReason(check) {
  const good = [];
  if (check.https) good.push('https');
  if (check.viewport) good.push('mobile viewport');
  if (check.footerYear) good.push(`${check.footerYear} footer`);
  else good.push('no stale year in the footer');
  const broken = signalById(check, 'broken_elements');
  if (broken && broken.found === false && /^\d+ image/.test(broken.evidence)) {
    good.push('images all loading');
  }
  const platform = check.platform ? `Current ${check.platform} site` : 'Current site';
  return `${platform}, ${good.join(', ')} - no pitch here.`;
}

/**
 * The opening line of a cold call. Specific, verifiable, neutral: the owner may
 * well have built the site themselves, so it names what is on the page and lets
 * them draw the conclusion. Never a word about how it looks - nothing here has
 * seen the site rendered.
 */
export function buildReason(check) {
  if (!check) return '';

  if (check.tier === 'social_only') {
    const what = check.hostWhat || 'someone else\'s page';
    return `Their only web link is ${what} - no site of their own.`;
  }
  if (check.tier === 'free_host') {
    const what = check.hostWhat || 'a free subdomain';
    return `Their site sits on ${what} rather than a domain of their own.`;
  }
  if (check.tier === 'dead_site') return deadReason(check);

  const found = OBJECTIVE_SIGNAL_IDS
    .map((id) => signalById(check, id))
    .filter((s) => s && s.found === true);

  if (!found.length) return healthyReason(check);

  const clauses = found.map((s) => clauseFor(check, s));
  let line = `${capitalise(joinClauses(clauses))}.`;

  // One or two signals on an otherwise clean site is a lighter pitch, and
  // saying so keeps the call honest.
  if (found.length <= 2) {
    const clean = [];
    if (check.https && !found.some((s) => s.id === 'no_https')) clean.push('https');
    if (check.viewport && !found.some((s) => s.id === 'no_viewport')) clean.push('mobile viewport');
    if (clean.length === 2) {
      const on = check.platform ? ` on ${check.platform}` : '';
      line = `${line.replace(/\.$/, '')} - otherwise clean on the HTTP checks (${clean.join(', ')}${on}), so a lighter pitch.`;
    }
  }
  return line;
}

// ------------------------------------------------------------- the check

function emptyCheck(url, extra) {
  return {
    place_id: null,
    url,
    finalUrl: null,
    ok: false,
    tier: 'dead_site',
    reason: '',
    signals: [],
    platform: null,
    httpStatus: null,
    https: null,
    viewport: null,
    footerYear: null,
    parked: false,
    retriedWithBrowserUa: false,
    ms: 0,
    checkedAt: new Date().toISOString(),
    error: null,
    ...extra,
  };
}

/** Would a browser show a real page here? */
function isUsable(chain) {
  return !chain.err && chain.status >= 200 && chain.status < 400;
}

function detectParking(chain) {
  const bodies = [chain.body || '', ...(chain.hops || []).map((h) => h.body || '')];
  const haystack = `${bodies.join('\n')}\n${chain.finalUrl || ''}`.toLowerCase();
  for (const [needle, what] of PARKING_MARKERS) {
    if (haystack.includes(needle)) return what;
  }
  // The shape from CLAUDE.md: HTTP 200, a body too small to be a page, and a
  // client-side bounce somewhere else. Status alone would call this healthy.
  const text = visibleText(chain.body || '');
  if ((chain.body || '').length < 1500 && text.length < 60) {
    const bounced = (chain.hops || []).some((h) => h.via);
    if (bounced || clientSideRedirectTarget(chain.body || '')) return 'a placeholder lander page';
  }
  return null;
}

/**
 * Check one site.
 *
 * opts: { timeoutMs = 12000, signal, place_id, checkImages = true }
 */
export async function checkSite(url, opts = {}) {
  const {
    timeoutMs = 12000,
    signal: abortSignal,
    place_id = null,
    checkImages: doImages = true,
    now = new Date(),
  } = opts;
  const started = Date.now();
  const raw = String(url || '').trim();

  if (!raw) {
    const c = emptyCheck(raw, {
      place_id,
      tier: 'dead_site',
      error: 'no website listed',
      signals: unknownSignals('there is no address to check.'),
      ms: 0,
    });
    c.reason = 'No website listed on Google Maps at all.';
    return c;
  }

  const startUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;

  // A link to someone else's platform is settled before a single byte is
  // fetched: there is no site of their own to score.
  const hostClass = classifyHost(startUrl);

  let chain = await fetchChain(startUrl, { ua: DEFAULT_UA, timeoutMs, signal: abortSignal });
  let retriedWithBrowserUa = false;

  // mod_security and friends: 403/406/429/503 or a dropped connection for a
  // non-browser UA, the same page served fine to Chrome. Retry once before
  // this site is called dead.
  const blocked = chain.err
    ? ['tls', 'reset', 'refused', 'network', 'timeout'].includes(chain.err.kind)
    : [401, 403, 405, 406, 409, 429, 500, 502, 503].includes(chain.status);
  if (blocked && chain.err?.kind !== 'aborted') {
    retriedWithBrowserUa = true;
    const retry = await fetchChain(startUrl, { ua: BROWSER_UA, timeoutMs, signal: abortSignal });
    if (isUsable(retry) || (!retry.err && !isUsable(chain))) chain = retry;
  }

  const ua = retriedWithBrowserUa ? BROWSER_UA : DEFAULT_UA;
  const finalUrl = chain.finalUrl || startUrl;
  const httpStatus = chain.err ? null : chain.status ?? null;
  const body = chain.body || '';

  const check = emptyCheck(startUrl, {
    place_id,
    finalUrl,
    httpStatus,
    retriedWithBrowserUa,
    hops: (chain.hops || []).map((h) => ({
      url: h.url, status: h.status ?? null, to: h.to || null, via: h.via || null, error: h.error || null,
    })),
    errorKind: null,
    checkedAt: new Date().toISOString(),
  });

  /**
   * Settle a check that never got a page. A `social_only` link keeps its tier:
   * Facebook and the booking platforms routinely serve a login wall or a
   * JS-only shell to anything without a browser, and "their only link is a
   * Facebook page" is true whether or not Facebook answered us. Everything
   * else - including a free-host site that has gone 404 - is a dead site.
   */
  const settleDead = (kind, errorText, why) => {
    check.errorKind = kind;
    check.error = errorText;
    check.ok = false;
    if (hostClass && hostClass.kind === 'social_only') {
      check.tier = 'social_only';
      check.hostWhat = hostClass.what;
      check.signals = unknownSignals(`the listed link is ${hostClass.what}, not a site of their own.`);
    } else {
      check.tier = 'dead_site';
      check.signals = unknownSignals(why);
    }
    check.ms = Date.now() - started;
    check.reason = buildReason(check);
    return check;
  };

  // --- did not load at all
  if (chain.err) {
    check.https = null;
    return settleDead(chain.err.kind, chain.err.text, `the site did not load (${chain.err.text}).`);
  }

  check.https = finalUrl.startsWith('https://');

  const parkedAs = detectParking(chain);
  if (parkedAs) {
    check.parked = true;
    check.parkedAs = parkedAs;
    return settleDead('parked', `parked: ${parkedAs}`,
      `the domain is parked (${parkedAs}), so there is no site to score.`);
  }

  if (httpStatus >= 400) {
    return settleDead('http_error', `HTTP ${httpStatus}`, `the server returned HTTP ${httpStatus}.`);
  }

  if (visibleText(body).length < 40 && !/<img\b/i.test(body)) {
    return settleDead('empty', 'the page has no content', 'the page came back empty.');
  }

  // --- a real page: read it
  check.ok = true;
  const platform = detectPlatform(body, finalUrl);
  check.platform = platform.name;
  check.title = findTitle(body);

  const vp = findViewport(body);
  check.viewport = !!vp;
  check.footerYear = findFooterYear(body, now);

  const signals = [];

  signals.push(check.https
    ? signal('no_https', false, 'Served over https with a certificate the connection accepted.')
    : signal('no_https', true, 'Serves over http:// only, so Chrome flags every visit as Not secure.'));

  signals.push(vp
    ? signal('no_viewport', false, `Has <meta name="viewport" content="${vp.content}">.`)
    : signal('no_viewport', true, 'The source has no <meta name="viewport">, so the page predates mobile layout entirely.'));

  const thisYear = now.getFullYear();
  if (check.footerYear === null) {
    signals.push(signal('stale_copyright', false, 'No copyright year in the page source to go stale.'));
  } else {
    const gap = thisYear - check.footerYear;
    signals.push(gap >= STALE_GAP_YEARS
      ? signal('stale_copyright', true, `Newest copyright year on the page is ${check.footerYear}, ${gap} years behind ${thisYear}.`)
      : signal('stale_copyright', false, `Footer year is current (${check.footerYear}).`));
  }

  if (doImages) {
    const imgUrls = sampleImageUrls(body, finalUrl, 5);
    if (!imgUrls.length) {
      signals.push(signal('broken_elements', false, 'No <img> tags in the page source to check.'));
    } else {
      const imgTimeout = Math.max(4000, Math.min(8000, Math.round(timeoutMs / 2)));
      const results = await checkImages(imgUrls, { ua, timeoutMs: imgTimeout, signal: abortSignal });
      const bad = results.filter((r) => !r.ok);
      check.brokenImages = bad.map((b) => ({ url: b.url, why: b.why || 'no response' }));
      signals.push(bad.length
        ? signal('broken_elements', true,
          `${bad.length} of ${results.length} images sampled did not load (${bad.map((b) => `${pathOf(b.url)}: ${b.why || 'no response'}`).join('; ')}).`)
        : signal('broken_elements', false, `${results.length} images sampled, all loaded.`));
    }
  } else {
    signals.push(signal('broken_elements', null, 'Not checked - image sampling was turned off for this run.'));
  }

  const tells = detectTemplateTells(body, platform, finalUrl);
  check.templateTells = tells.map((t) => t.clause);
  signals.push(tells.length
    ? signal('untouched_template', true, `${capitalise(tells.map((t) => t.evidence).join('; '))}.`)
    : signal('untouched_template', false, platform.name
      ? `Built on ${platform.name}, with no placeholder copy or default template text left in the page.`
      : 'No placeholder copy or default template text left in the page.'));

  signals.push(...visualSignals());
  check.signals = signals;

  if (hostClass && hostClass.kind === 'social_only') {
    // There is no site of their own to score, so the signal list would be
    // measuring somebody else's platform. Say that rather than reporting a
    // clean sheet next to a `social_only` verdict.
    check.tier = 'social_only';
    check.hostWhat = hostClass.what;
    check.signals = unknownSignals(`the listed link is ${hostClass.what}, not a site of their own.`);
  } else if (hostClass) {
    check.tier = hostClass.kind;
    check.hostWhat = hostClass.what;
  } else {
    check.tier = scoreSignals(signals).tier;
  }

  check.ms = Date.now() - started;
  check.reason = buildReason(check);
  return check;
}

/**
 * Check every lead that has a website, `concurrency` at a time.
 *
 * Leads with no website are skipped rather than reported as failures - stage 1
 * already tiered those as `no_website` and there is nothing here to fetch.
 *
 * onProgress({ done, total, lead, check, message }) is called after each site.
 */
export async function checkAll(leads, opts = {}) {
  const { concurrency = 4, onProgress, timeoutMs = 12000, signal: abortSignal } = opts;
  const list = (leads || []).filter((l) => l && String(l.website || '').trim());
  const out = {};
  const total = list.length;
  let done = 0;
  let next = 0;

  const report = (lead, check) => {
    done += 1;
    if (typeof onProgress !== 'function') return;
    const message = `[${done}/${total}] ${lead.name || lead.place_id || check.url}: ${check.tier} - ${check.reason}`;
    try {
      onProgress({ done, total, lead, check, message });
    } catch { /* a progress sink must never take the run down */ }
  };

  const worker = async () => {
    while (next < list.length) {
      if (abortSignal && abortSignal.aborted) return;
      const lead = list[next++];
      let check;
      try {
        check = await checkSite(lead.website, {
          timeoutMs, signal: abortSignal, place_id: lead.place_id || null,
        });
      } catch (err) {
        // Nothing in checkSite is meant to throw; if it ever does, the run
        // keeps going and the failure is recorded against that one lead.
        check = emptyCheck(String(lead.website || ''), {
          place_id: lead.place_id || null,
          error: `check failed: ${err && err.message ? err.message : String(err)}`,
          errorKind: 'internal',
          signals: unknownSignals('the check itself failed.'),
        });
        check.reason = 'Could not be checked - the check itself failed, so this one needs a look by hand.';
      }
      if (lead.place_id) out[lead.place_id] = check;
      else out[check.url] = check;
      report(lead, check);
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, list.length || 1)) },
    () => worker(),
  );
  await Promise.all(workers);
  return out;
}
