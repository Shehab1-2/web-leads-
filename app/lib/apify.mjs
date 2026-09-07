// Stage 1: pull local businesses from Apify and pre-classify by web presence.
//
// A dependency-free port of scripts/find_businesses.py. The classification
// rules, the actor input, the start-then-poll flow and the error messages are
// deliberately kept as they were: the Python's output is the ground truth the
// existing call lists in data/ were produced with, and a drifted classifier
// would silently change which businesses get called.
//
// Node >= 20, node: builtins + global fetch only.

import { STAGE1_TIERS } from './rank.mjs';

export const ACTOR = 'compass~crawler-google-places';
// Overridable so the stage-1 flow can be exercised end to end against a fake
// Apify — otherwise the only way to test this path is to spend real credit.
export const API_ROOT = (process.env.APIFY_API_ROOT || '').trim() || 'https://api.apify.com/v2';

// Approximate actor pricing, used only for the pre-run cost estimate.
export const USD_PER_PLACE = 0.0015;

// A "website" on one of these hosts is not a real website. For a web-design
// pitch these are the best leads in the list: the business has an audience but
// nowhere of their own to send it.
export const SOCIAL_HOSTS = new Set([
  'facebook.com', 'm.facebook.com', 'fb.com', 'fb.me',
  'instagram.com', 'linktr.ee', 'linkin.bio', 'beacons.ai', 'carrd.co',
  'business.site',           // Google My Business auto-generated pages
  'sites.google.com',
  'yelp.com', 'nextdoor.com', 'tripadvisor.com',
  'twitter.com', 'x.com', 'tiktok.com', 'youtube.com', 'linkedin.com',
  'wa.me', 'api.whatsapp.com', 't.me',
  'google.com', 'goo.gl', 'maps.app.goo.gl',
]);

// Free/entry-tier website hosts. These ARE real sites, but a business still on
// the free subdomain years later is almost always running an untouched template.
export const FREE_HOSTS = new Set([
  'wixsite.com', 'weebly.com', 'blogspot.com', 'wordpress.com',
  'godaddysites.com', 'square.site', 'webnode.com', 'jimdosite.com',
  'yolasite.com', 'tripod.com', 'angelfire.com', 'webs.com',
  'myfreesites.net', 'site123.me', 'strikingly.com',
]);

/** Terminal Apify run statuses, exactly as the Python treats them. */
const TERMINAL_STATUSES = new Set([
  'SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT', 'TIMING-OUT',
]);

/**
 * Everything the Python's die() would have printed, raised instead. `status`
 * carries the HTTP status when the failure came from the API.
 */
export class ApifyError extends Error {
  constructor(message, { status = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApifyError';
    this.status = status;
  }
}

function abortError() {
  const e = new Error('Search cancelled.');
  e.name = 'AbortError';
  return e;
}

/**
 * The token rides in the query string (as it does in the Python), so never let
 * a URL reach an error message, a log line or the browser with it attached.
 */
function redact(url) {
  return String(url).replace(/token=[^&]*/g, 'token=***');
}

function makeLogger(onProgress) {
  return (msg) => {
    if (typeof onProgress !== 'function') return;
    // A broken progress sink must not take the run down with it.
    try { onProgress(msg); } catch { /* ignore */ }
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ------------------------------------------------------------ classification

/**
 * CPython's urlsplit strips C0 controls and spaces (everything <= 0x20) from
 * both ends before parsing. Matching that keeps a copy-pasted URL with a stray
 * newline on it classifying the way it did under the Python.
 */
function stripC0OrSpace(s) {
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) <= 0x20) a += 1;
  while (b > a && s.charCodeAt(b - 1) <= 0x20) b -= 1;
  return s.slice(a, b);
}

/** The `netloc` CPython's urlsplit would produce; '' where it raises. */
function netlocOf(url) {
  // urlsplit also removes tab/CR/LF from anywhere in the URL.
  let rest = stripC0OrSpace(String(url)).replace(/[\t\r\n]/g, '');
  const scheme = /^[A-Za-z][A-Za-z0-9+\-.]*:/.exec(rest);
  if (scheme) rest = rest.slice(scheme[0].length);
  if (!rest.startsWith('//')) return '';
  rest = rest.slice(2);
  const cut = rest.search(/[/?#]/);
  const netloc = cut === -1 ? rest : rest.slice(0, cut);
  // urlsplit raises ValueError('Invalid IPv6 URL') on unbalanced brackets;
  // host_of() catches it and returns ''.
  if (netloc.includes('[') !== netloc.includes(']')) return '';
  return netloc;
}

export function hostOf(url) {
  if (!url) return '';
  const raw = String(url);
  const netloc = netlocOf(raw.includes('//') ? raw : 'http://' + raw);
  const host = netloc.toLowerCase().split(':')[0];
  return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * Rough 'last two labels' domain. Good enough to match our host lists; we are
 * not trying to be a full public-suffix implementation here.
 */
export function registrable(host) {
  const parts = String(host).split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : String(host);
}

/** Decide whether a listed 'website' is actually a website. */
export function classify(website) {
  if (!website || !String(website).trim()) return 'no_website';
  const host = hostOf(website);
  if (!host) return 'no_website';
  const base = registrable(host);
  if (SOCIAL_HOSTS.has(base) || SOCIAL_HOSTS.has(host)) return 'social_only';
  // free hosts appear as <business>.wixsite.com, so check the suffix too
  for (const h of FREE_HOSTS) {
    if (base === h || host.endsWith('.' + h)) return 'free_host';
  }
  return 'needs_check';
}

/**
 * Python writes '' for a missing or zero rating/review count; toCsv() renders
 * null identically, and the Lead shape in CONTRACTS.md asks for number|null.
 */
function numOrNull(value) {
  if (!value) return null;                       // matches Python's `or ""`
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** "Mon 10 AM to 6 PM · Tue …" — the array is kept whole in details. */
function compactHours(hours) {
  if (!Array.isArray(hours) || !hours.length) return '';
  return hours
    .map((h) => `${String(h?.day || '').slice(0, 3)} ${h?.hours || ''}`.trim())
    .filter(Boolean)
    .join(' · ');
}

/**
 * Social links, wherever the contacts add-on put them. The actor names these
 * per-network and pluralised (facebooks, instagrams, …); take the first of
 * each so one cell reads as a list rather than a blob.
 */
function socialsOf(src) {
  const out = [];
  for (const key of ['facebooks', 'instagrams', 'linkedIns', 'twitters', 'tiktoks', 'youtubes']) {
    const v = src[key];
    if (Array.isArray(v) && v.length) out.push(String(v[0]));
    else if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  return out.join(' ');
}

/** First usable email from the contacts add-on, if it ran. */
function emailOf(src) {
  const list = Array.isArray(src.emails) ? src.emails : [];
  const first = list.find((e) => typeof e === 'string' && e.includes('@'));
  return first ? String(first).trim() : '';
}

// Fields not worth carrying: always-null verticals, and arrays big enough to
// bloat every row. Everything else is kept so the detail panel can show it.
const DETAIL_DROP = new Set([
  'hotelStars', 'hotelDescription', 'hotelAds', 'checkInDate', 'checkOutDate',
  'gasPrices', 'googleFoodUrl', 'menu', 'price',
  'reviews', 'images', 'imageUrls', 'popularTimesHistogram', 'peopleAlsoSearch',
]);

/** The whole Apify record minus the noise, for the detail panel. */
export function details(item) {
  const out = {};
  for (const [k, v] of Object.entries(item || {})) {
    if (DETAIL_DROP.has(k)) continue;
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out;
}

/** One Apify place -> the lead shape stored in data/leads_<slug>.csv. */
export function slim(item) {
  const src = item || {};
  const website = String(src.website || '').trim();
  return {
    place_id: src.placeId || '',
    name: src.title || '',
    phone: src.phone || src.phoneUnformatted || '',
    address: src.address || '',
    city: src.city || '',
    state: src.state || '',
    postal_code: src.postalCode || '',
    category: src.categoryName || '',
    website,
    email: emailOf(src),
    socials: socialsOf(src),
    tier: classify(website),
    rating: numOrNull(src.totalScore),
    reviews: numOrNull(src.reviewsCount),
    // Google's own "claim this business" prompt. Stored as the API reports it
    // and NOT used for ranking — every row seen so far reads false, so the
    // semantics are unconfirmed against a genuinely unclaimed listing.
    claim_this_business: src.claimThisBusiness === true ? 'true'
      : src.claimThisBusiness === false ? 'false' : '',
    hours: compactHours(src.openingHours),
    image_url: src.imageUrl || '',
    description: src.description || '',
    lat: src.location && src.location.lat !== undefined ? String(src.location.lat) : '',
    lng: src.location && src.location.lng !== undefined ? String(src.location.lng) : '',
    maps_url: src.url || '',
    checked_tier: '',   // filled in by stage 2
    reason: '',
  };
}

function tierOrder(tier) {
  const i = STAGE1_TIERS.indexOf(tier);
  return i === -1 ? 9 : i;
}

/** Strongest tier first, busiest first inside a tier. */
function sortLeads(rows) {
  return rows.sort((a, b) => {
    const d = tierOrder(a.tier) - tierOrder(b.tier);
    if (d !== 0) return d;
    const ar = typeof a.reviews === 'number' ? -a.reviews : 0;
    const br = typeof b.reviews === 'number' ? -b.reviews : 0;
    return ar - br;
  });
}

export function countByTier(leads) {
  const counts = {};
  for (const l of leads) counts[l.tier] = (counts[l.tier] || 0) + 1;
  return counts;
}

// Joins the parts of a composite key. NUL never occurs in Maps data, so this
// behaves like the Python's tuple key: two fields can't collide by splicing.
const SEP = String.fromCharCode(0);

/**
 * Drop businesses an earlier run already surfaced, so repeat runs don't
 * re-pitch the same shops. Keyed by place_id, falling back to name+address for
 * older rows. `seenRows` comes from store.readSeen(); this module never touches
 * disk itself.
 */
export function filterSeen(leads, seenRows = []) {
  const nameKey = (r) => String(r?.name || '').trim().toLowerCase()
    + SEP + String(r?.address || '').trim().toLowerCase();
  const ids = new Set();
  const keys = new Set();
  for (const row of seenRows) {
    if (row?.place_id) ids.add(row.place_id);
    const key = nameKey(row);
    if (key !== SEP) keys.add(key);   // Python: skip rows with neither field
  }
  const kept = [];
  let skipped = 0;
  for (const l of leads) {
    if ((l.place_id && ids.has(l.place_id)) || keys.has(nameKey(l))) {
      skipped += 1;
      continue;
    }
    kept.push(l);
  }
  return { kept, skipped };
}

// ---------------------------------------------------------------- API calls

function describeNetworkError(err) {
  return err?.cause?.code || err?.cause?.message || err?.message || 'network error';
}

async function apiRequest(url, { method = 'GET', payload = null, timeoutMs = 60000, signal } = {}) {
  if (signal?.aborted) throw abortError();

  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });

  let status = 0;
  let body = '';
  try {
    const resp = await fetch(url, {
      method,
      headers: payload === null ? {} : { 'Content-Type': 'application/json' },
      body: payload === null ? undefined : JSON.stringify(payload),
      signal: ctl.signal,
    });
    status = resp.status;
    body = await resp.text();
  } catch (err) {
    if (signal?.aborted) throw abortError();
    if (timedOut) throw new ApifyError('Timed out talking to the Apify API.');
    throw new ApifyError(
      `Could not reach the Apify API (${describeNetworkError(err)}).\n`
      + 'If you are running inside a sandboxed/cloud session, outbound network '
      + 'is probably blocked - run this from Claude Code on your own machine instead.',
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (status >= 400) {
    const detail = body.slice(0, 600);
    if (status === 401) {
      throw new ApifyError(
        'Apify rejected the token (401). Check APIFY_API_TOKEN is the full '
        + 'token from https://console.apify.com/account/integrations',
        { status },
      );
    }
    if (status === 402) {
      throw new ApifyError(
        'Apify says you are out of credit (402). Check your usage at '
        + 'https://console.apify.com/billing',
        { status },
      );
    }
    if (status === 404) {
      throw new ApifyError(`Apify endpoint not found (404): ${redact(url)}\n${detail}`, { status });
    }
    throw new ApifyError(`Apify HTTP ${status}: ${detail}`, { status });
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new ApifyError(`Apify returned non-JSON:\n${body.slice(0, 600)}`, { status });
  }
}

/**
 * Start the actor asynchronously.
 *
 * Deliberately NOT using run-sync-get-dataset-items: that endpoint hard-fails
 * at 300 seconds, which a larger search can exceed, and it gives no progress
 * signal while waiting. Starting + polling costs a few extra lines and removes
 * that whole class of failure.
 */
async function startRun({ niche, location, max, token, signal }) {
  const payload = {
    searchStringsArray: [niche],
    locationQuery: location,
    maxCrawledPlacesPerSearch: max,
    language: 'en',
    website: 'allPlaces',   // we classify ourselves; see SOCIAL_HOSTS
    skipClosedPlaces: true,
    maxReviews: 0,          // keep the run cheap and fast
    maxImages: 0,
    maxQuestions: 0,
  };
  const url = `${API_ROOT}/acts/${ACTOR}/runs?token=${encodeURIComponent(token)}`;
  const resp = await apiRequest(url, { method: 'POST', payload, signal });
  const data = resp?.data || {};
  const runId = data.id;
  const datasetId = data.defaultDatasetId;
  if (!runId || !datasetId) {
    throw new ApifyError(
      'Apify did not return a run id/dataset id. Response:\n'
      + String(JSON.stringify(resp)).slice(0, 600),
    );
  }
  return { runId, datasetId };
}

/** Poll until the run finishes. Returns the terminal status. */
async function waitForRun(runId, token, { log, signal, maxWaitSeconds = 600 }) {
  const url = `${API_ROOT}/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(token)}`;
  let waited = 0;
  let delay = 5;
  let lastStatus = null;
  while (waited < maxWaitSeconds) {
    const data = (await apiRequest(url, { signal }))?.data || {};
    const status = data.status;
    if (status !== lastStatus) {
      log(`  run status: ${status}`);
      lastStatus = status;
    }
    if (TERMINAL_STATUSES.has(status)) return status;
    await sleep(delay * 1000, signal);
    waited += delay;
    delay = Math.min(delay + 2, 15);
  }
  log(`  still running after ${maxWaitSeconds}s - giving up on waiting.`);
  log(`  check it here: https://console.apify.com/actors/runs/${runId}`);
  return 'TIMEOUT_WAITING';
}

async function fetchItems(datasetId, token, { signal }) {
  const url = `${API_ROOT}/datasets/${encodeURIComponent(datasetId)}/items`
    + `?token=${encodeURIComponent(token)}&clean=true&format=json`;
  const items = await apiRequest(url, { timeoutMs: 120000, signal });
  if (!Array.isArray(items)) {
    throw new ApifyError(
      `Expected a list of places, got: ${String(JSON.stringify(items)).slice(0, 400)}`,
    );
  }
  return items;
}

// -------------------------------------------------------------------- search

/**
 * Run stage 1 end to end: start the actor, poll it, fetch the dataset, and
 * pre-classify every business from the Maps data alone.
 *
 * Nothing here touches disk - persisting the run, and filtering out businesses
 * already in seen_leads.csv, is the caller's job (see filterSeen above).
 *
 * @param {object} opts
 * @param {string} opts.niche      a trade, e.g. "plumbers". Never "small businesses".
 * @param {string} opts.location   a real city/area, e.g. "Austin, TX" or "78704".
 * @param {number} [opts.max=15]   max places to pull.
 * @param {string} [opts.token]    Apify token; defaults to APIFY_API_TOKEN.
 * @param {(msg: string) => void} [opts.onProgress]  human-readable log lines.
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.yes]     confirm a run of more than 50 places.
 */
export async function search({
  niche, location, max = 15, token, onProgress, signal, yes = false,
} = {}) {
  const log = makeLogger(onProgress);

  const q = String(niche ?? '').trim();
  const where = String(location ?? '').trim();
  if (!q) {
    throw new ApifyError(
      'A niche is required - a specific trade like "plumbers" or "hair salons". '
      + 'Searching "small businesses" returns an unworkable list.',
    );
  }
  if (!where) {
    throw new ApifyError('A location is required - a city/area like "Austin, TX" or "78704".');
  }

  const apiToken = String(token ?? process.env.APIFY_API_TOKEN ?? '').trim();
  if (!apiToken) {
    throw new ApifyError(
      'APIFY_API_TOKEN is not set.\n'
      + '  PowerShell:  $env:APIFY_API_TOKEN = "apify_api_xxx"\n'
      + '  bash/zsh:    export APIFY_API_TOKEN=apify_api_xxx\n'
      + '  Get a token at https://console.apify.com/account/integrations',
    );
  }
  if (!apiToken.startsWith('apify_api_')) {
    log("  (warning: token does not start with 'apify_api_' - continuing anyway, "
      + 'but check it if the next step fails)');
  }

  const maxPlaces = Number(max);
  if (!Number.isInteger(maxPlaces) || maxPlaces < 1) {
    throw new ApifyError('max must be a whole number of at least 1');
  }
  if (maxPlaces > 200) {
    throw new ApifyError('max above 200 is almost certainly a mistake for this workflow.');
  }

  // Cost guard. Cheap, but on the free tier the monthly credit is small enough
  // that an accidental 3-digit run is worth one confirmation.
  const est = maxPlaces * USD_PER_PLACE;
  if (maxPlaces > 50 && !yes) {
    throw new ApifyError(
      `About to scrape up to ${maxPlaces} places (~$${est.toFixed(2)}). `
      + 'Re-run with yes: true to confirm.',
    );
  }

  log(`Searching Apify for: ${q} in ${where} (max ${maxPlaces}, est ~$${est.toFixed(2)})`);

  const { runId, datasetId } = await startRun({
    niche: q, location: where, max: maxPlaces, token: apiToken, signal,
  });
  log(`  started run ${runId}`);

  const status = await waitForRun(runId, apiToken, { log, signal });
  if (status !== 'SUCCEEDED' && status !== 'TIMEOUT_WAITING') {
    throw new ApifyError(
      `Apify run ended with status ${status}. `
      + `Details: https://console.apify.com/actors/runs/${runId}`,
    );
  }

  const raw = await fetchItems(datasetId, apiToken, { signal });
  log(`  got ${raw.length} places back`);
  if (!raw.length) {
    throw new ApifyError(
      'Apify returned zero places. That usually means the niche or location '
      + 'did not match anything - check the spelling, or try a broader area, '
      + 'before re-running.',
    );
  }

  const rows = [];
  const detailsById = {};
  const dupes = new Set();
  for (const item of raw) {
    const r = slim(item);
    if (!r.name) continue;
    const key = r.place_id
      ? 'id' + SEP + r.place_id
      : 'na' + SEP + r.name.toLowerCase() + SEP + r.address.toLowerCase();
    if (dupes.has(key)) continue;
    dupes.add(key);
    rows.push(r);
    // The full record, kept beside the row rather than in it: the CSV stays
    // workable while the detail panel still has everything Apify sent.
    if (r.place_id) detailsById[r.place_id] = details(item);
  }

  sortLeads(rows);

  const counts = countByTier(rows);
  log('');
  log('Results by tier:');
  for (const tier of STAGE1_TIERS) {
    if (counts[tier]) log(`  ${tier.padEnd(12)} ${counts[tier]}`);
  }

  const needs = counts.needs_check || 0;
  log('');
  log(needs
    ? `${needs} business(es) have a real domain and need the site check (stage 2).`
    : 'No sites need the site check - every lead is already classified from the Maps data.');

  return { leads: rows, details: detailsById, runId, datasetId, raw: raw.length, status, counts, estimatedUsd: est };
}
