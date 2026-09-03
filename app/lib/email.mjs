// Cold email, and the honest limit on it.
//
// Google Maps hands back a phone number, never an email address. An address can
// therefore only come off the business's own website — which means the leads at
// the very top of the ranking, the ones with no website at all, are exactly the
// ones email cannot reach. Email is the follow-up channel on this pipeline, not
// the main one, and this module is built to say so rather than to quietly
// produce a shorter list and let the gap go unnoticed.
//
// So `emailability()` sorts a run into four buckets — one reachable, three
// phone-only — and `findAddresses()` reports what it actually found on the page,
// including nothing.

import { effectiveTier } from './rank.mjs';

/**
 * The one-paragraph version of the above, kept here so the screen, the report
 * and the CLI all say the same thing instead of three paraphrases.
 */
export const EMAIL_REACH_NOTE =
  'Google Maps does not return email addresses - they come off the site itself. '
  + 'The strongest leads on the list, the ones with no site at all, are the ones '
  + 'email cannot reach. Email is the follow-up channel here, not the main one.';

// Mirrors SOCIAL_HOSTS in scripts/find_businesses.py (stage 1). Kept as a local
// copy rather than imported from apify.mjs so this module stands on its own;
// the two lists must stay in step.
const SOCIAL_HOSTS = new Set([
  'facebook.com', 'm.facebook.com', 'fb.com', 'fb.me',
  'instagram.com', 'linktr.ee', 'linkin.bio', 'beacons.ai', 'carrd.co',
  'business.site',
  'sites.google.com',
  'yelp.com', 'nextdoor.com', 'tripadvisor.com',
  'twitter.com', 'x.com', 'tiktok.com', 'youtube.com', 'linkedin.com',
  'wa.me', 'api.whatsapp.com', 't.me',
  'google.com', 'goo.gl', 'maps.app.goo.gl',
]);

// Booking platforms. Stage 1 files these under `needs_check` because they are a
// real, working URL, but there is no page of the business's own to read an
// address off - the whole page belongs to the platform. Phone-only, same as a
// Facebook page. (The Square booking link in the Piscataway run is this case.)
const BOOKING_HOSTS = new Set([
  'squareup.com', 'book.squareup.com', 'square.site',
  'booksy.com', 'vagaro.com', 'styleseat.com', 'schedulicity.com',
  'fresha.com', 'setmore.com', 'acuityscheduling.com', 'calendly.com',
  'getsquire.com', 'mytime.com', 'genbook.com',
]);

/** Bucket metadata, in the order the screen shows them. */
export const BUCKETS = [
  {
    id: 'emailable',
    label: 'Emailable',
    channel: 'email',
    note: 'Working site of their own - an address may be on the page',
  },
  {
    id: 'deadDomain',
    label: 'Phone only',
    channel: 'phone',
    note: 'Domain is parked or will not load - no mail behind it',
  },
  {
    id: 'socialOnly',
    label: 'Phone only',
    channel: 'phone',
    note: 'Profile or booking page on someone else’s domain',
  },
  {
    id: 'noWebsite',
    label: 'Phone only',
    channel: 'phone',
    note: 'No website at all - nothing to read an address off',
  },
];

// ------------------------------------------------------------------ urls

/** Hostname without `www.`, lowercased. '' when the URL is unusable. */
export function hostOf(url) {
  const u = normalizeUrl(url);
  if (!u) return '';
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Add a scheme when the CSV holds a bare domain; '' when there is nothing. */
function normalizeUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '';   // mailto:, tel:, javascript:
  return `https://${s}`;
}

function isSocialHost(host) {
  if (!host) return false;
  if (SOCIAL_HOSTS.has(host) || BOOKING_HOSTS.has(host)) return true;
  // Match a registrable-domain suffix too: `book.squareup.com`, `m.yelp.com`.
  for (const known of [...SOCIAL_HOSTS, ...BOOKING_HOSTS]) {
    if (host === known || host.endsWith(`.${known}`)) return true;
  }
  return false;
}

// --------------------------------------------------------- emailability

/**
 * Which bucket one lead falls in, or null when it is not a lead at all
 * (a healthy site checked as `not_a_lead` is cut from the call list, so it is
 * cut from here too rather than padding the counts).
 */
export function bucketOf(lead) {
  const tier = effectiveTier(lead);
  if (tier === 'not_a_lead') return null;

  const website = normalizeUrl(lead.website);
  const host = hostOf(website);
  const check = lead.check || null;

  if (!website) return 'noWebsite';
  if (tier === 'no_website') return 'noWebsite';
  if (tier === 'social_only' || isSocialHost(host)) return 'socialOnly';
  if (tier === 'dead_site') return 'deadDomain';
  if (check && (check.ok === false || check.parked === true)) return 'deadDomain';

  // Everything left has a page of its own that loads - including `free_host`
  // (a wixsite.com/weebly.com subdomain is someone else's domain, but it is
  // still the business's own page with a contact section to read).
  return 'emailable';
}

/**
 * Sort a run into who email can even reach.
 *
 * Returns the four buckets as arrays of the leads themselves, plus `buckets`:
 * the same four with label/note/count attached, ready to render. `excluded`
 * holds the healthy sites that are not leads at all, so a screen can say
 * "2 healthy sites not shown" instead of silently losing them.
 */
export function emailability(leads) {
  const out = { emailable: [], deadDomain: [], socialOnly: [], noWebsite: [], excluded: [] };
  for (const lead of leads || []) {
    const id = bucketOf(lead);
    if (id === null) out.excluded.push(lead);
    else out[id].push(lead);
  }
  const buckets = BUCKETS.map((b) => ({ ...b, count: out[b.id].length, leads: out[b.id] }));
  const total = out.emailable.length + out.deadDomain.length + out.socialOnly.length + out.noWebsite.length;
  return {
    emailable: out.emailable,
    deadDomain: out.deadDomain,
    socialOnly: out.socialOnly,
    noWebsite: out.noWebsite,
    excluded: out.excluded,
    buckets,
    total,
    reachable: out.emailable.length,
    phoneOnly: total - out.emailable.length,
    note: EMAIL_REACH_NOTE,
  };
}

// ------------------------------------------------------------- fetching

// app/lib/sitecheck.mjs does not exist yet, and the contract's exports for it
// (checkSite/checkAll/scoreSignals/buildReason) return a SiteCheck, not page
// HTML - so there is nothing there to import for this. The two behaviours that
// bite in practice are reproduced here deliberately and identically: a hard
// timeout, and one retry with a normal browser UA for hosts (mod_security and
// friends) that reject a scripted user agent. If a raw-fetch helper is later
// exported from sitecheck.mjs, this should collapse into it.

const PLAIN_UA = 'web-leads/1.0 (+lead qualification; one request per page)';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAX_BODY = 1_500_000;   // enough for a contact page; caps a runaway response

function linkAbort(signal, ctrl) {
  if (!signal) return () => {};
  if (signal.aborted) { ctrl.abort(signal.reason); return () => {}; }
  const onAbort = () => ctrl.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

async function fetchOnce(url, { timeoutMs, signal, ua }) {
  const ctrl = new AbortController();
  const unlink = linkAbort(signal, ctrl);
  const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': ua,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    const type = res.headers.get('content-type') || '';
    let html = '';
    if (!type || /html|text|xml|json/i.test(type)) {
      const body = await res.text();
      html = body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body;
    }
    return { ok: res.ok, status: res.status, finalUrl: res.url || url, html, error: null };
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

/**
 * Fetch one page. One retry with a browser UA when the first attempt throws or
 * comes back with a status that usually means "we don't like your user agent".
 */
async function fetchPage(url, { timeoutMs = 12000, signal } = {}) {
  let first;
  try {
    first = await fetchOnce(url, { timeoutMs, signal, ua: PLAIN_UA });
    if (first.ok) return { ...first, retriedWithBrowserUa: false };
  } catch (err) {
    first = { ok: false, status: null, finalUrl: url, html: '', error: describeError(err) };
  }
  if (signal?.aborted) return { ...first, retriedWithBrowserUa: false };
  // A name that does not resolve will not resolve for a second user agent
  // either - only retry where the UA could plausibly be the thing being
  // rejected, so `retriedWithBrowserUa` stays a true statement.
  const dns = /ENOTFOUND|EAI_AGAIN/i.test(first.error || '');
  const uaLikelyBlocked = !dns && (
    first.status === null
    || [401, 403, 405, 406, 409, 429].includes(first.status)
    || first.status >= 500
  );
  if (!uaLikelyBlocked) return { ...first, retriedWithBrowserUa: false };
  try {
    const second = await fetchOnce(url, { timeoutMs, signal, ua: BROWSER_UA });
    return { ...second, retriedWithBrowserUa: true };
  } catch (err) {
    return {
      ok: false, status: first.status, finalUrl: url, html: '',
      error: describeError(err), retriedWithBrowserUa: true,
    };
  }
}

function describeError(err) {
  const cause = err?.cause;
  const bits = [err?.message, cause?.message, cause?.code].filter(Boolean);
  const seen = [];
  for (const b of bits) if (!seen.includes(b)) seen.push(b);
  return seen.join(': ') || String(err);
}

// ------------------------------------------------------ address scraping

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

// Addresses that are never the business's own.
const JUNK_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'domain.com', 'yourdomain.com',
  'mydomain.com', 'yoursite.com', 'mysite.com', 'website.com', 'email.com',
  'company.com', 'test.com', 'localhost', 'sentry.io', 'wix.com',
  'wixpress.com', 'sentry.wixpress.com', 'sentry-next.wixpress.com',
  'squarespace.com', 'godaddy.com', 'w3.org', 'schema.org', 'jquery.com',
  'sentry.local',
]);
const JUNK_DOMAIN_SUFFIXES = ['.sentry.io', '.ingest.sentry.io', '.wixpress.com', '.example.com'];
const JUNK_LOCAL_RE = /^(no-?reply|do-?not-?reply|noreply|postmaster|abuse|sentry|username|youremail|your-email|name|email|user|test|demo|admin@example)$/i;
// `logo@2x.png`, `icon@3x.jpg` and friends parse as an address; they are files.
const FILE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|ico|bmp|tiff?|avif|css|js|mjs|json|xml|mp4|webm|mp3|woff2?|ttf|eot|otf|pdf|zip)$/i;

function cleanAddress(raw) {
  let s = String(raw || '').trim().replace(/^[<("']+/, '').replace(/[>)"'.,;:]+$/, '');
  s = s.replace(/^mailto:/i, '');
  try { s = decodeURIComponent(s); } catch { /* leave as-is if not encoded */ }
  s = s.split('?')[0].trim();
  return s.toLowerCase();
}

/** True when this looks like a real address someone reads. */
export function isUsableAddress(address) {
  const s = cleanAddress(address);
  if (!s || s.length > 254) return false;
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return false;
  if (FILE_EXT_RE.test(s)) return false;
  const [local, domain] = s.split('@');
  if (!local || !domain) return false;
  if (JUNK_LOCAL_RE.test(local)) return false;
  if (/^[0-9a-f]{20,}$/.test(local)) return false;          // sentry/analytics keys
  if (JUNK_DOMAINS.has(domain)) return false;
  if (JUNK_DOMAIN_SUFFIXES.some((suf) => domain.endsWith(suf))) return false;
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  if (!/^[a-z]{2,24}$/.test(tld)) return false;             // `2x.png`, `1.0.0`
  return true;
}

/** Every usable address on one page: mailto: links first, then plain text. */
export function extractEmails(html) {
  const found = [];
  const push = (raw) => {
    const s = cleanAddress(raw);
    if (isUsableAddress(s) && !found.includes(s)) found.push(s);
  };
  const source = String(html || '');

  for (const m of source.matchAll(/mailto:([^"'\s>)\\]+)/gi)) push(m[1]);

  // Plain text, with scripts and styles dropped - that is where the analytics
  // and template junk lives, and it is a lot of it.
  const text = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
  for (const m of text.matchAll(EMAIL_RE)) push(m[0]);

  return found;
}

/** The most contact-page-looking same-site link on the page, or null. */
export function findContactLink(html, baseUrl) {
  let base;
  try { base = new URL(baseUrl); } catch { return null; }
  const baseHost = base.hostname.toLowerCase().replace(/^www\./, '');
  let best = null;
  let bestScore = 0;

  const anchors = String(html || '').matchAll(
    /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]{0,200}?)<\/a>/gi,
  );
  for (const m of anchors) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let url;
    try { url = new URL(href, base); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    if (url.hostname.toLowerCase().replace(/^www\./, '') !== baseHost) continue;
    const label = m[4].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const hay = `${url.pathname} ${label}`.toLowerCase();
    let score = 0;
    if (/\bcontact\b|contact-?us|contactus/.test(hay)) score = 3;
    else if (/get in touch|reach us|find us/.test(hay)) score = 2;
    else if (/\babout\b/.test(hay)) score = 1;
    if (score > bestScore) {
      bestScore = score;
      url.hash = '';
      best = url.toString();
    }
  }
  return best;
}

/**
 * Really fetch each emailable lead's homepage and its likely contact page and
 * report the addresses that were actually on them.
 *
 * Leads outside the `emailable` bucket are skipped, not failed - there is no
 * page to read. Nothing found is a normal, expected result and is returned as
 * an empty list, never as a guess.
 *
 * -> Record<place_id, { emails, source, error, pages, checkedAt }>
 */
export async function findAddresses(leads, { concurrency = 4, onProgress, timeoutMs = 12000, signal } = {}) {
  const log = typeof onProgress === 'function' ? onProgress : () => {};
  const { emailable } = emailability(leads || []);
  const out = {};

  if (!emailable.length) {
    log('No lead in this run has a working site of its own - nothing to scan.');
    return out;
  }
  log(`Scanning ${emailable.length} site${emailable.length === 1 ? '' : 's'} for an address.`);

  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, emailable.length)) }, async () => {
    while (next < emailable.length) {
      if (signal?.aborted) return;
      const i = next++;
      const lead = emailable[i];
      const label = `[${i + 1}/${emailable.length}] ${lead.name || lead.place_id}`;
      log(`${label} - reading ${hostOf(lead.website) || lead.website}`);
      const result = await scanOne(lead, { timeoutMs, signal });
      out[lead.place_id] = result;
      if (result.emails.length) {
        log(`${label} - found ${result.emails.length}: ${result.emails.join(', ')}`);
      } else if (result.error) {
        log(`${label} - no address (${result.error})`);
      } else {
        log(`${label} - no address published on the site`);
      }
    }
  });
  await Promise.all(workers);

  const withAddress = Object.values(out).filter((r) => r.emails.length).length;
  log(`Done - ${withAddress} of ${emailable.length} site${emailable.length === 1 ? '' : 's'} published an address.`);
  return out;
}

async function scanOne(lead, { timeoutMs, signal }) {
  const home = normalizeUrl(lead.website);
  const result = { emails: [], source: null, error: null, pages: [], checkedAt: new Date().toISOString() };
  if (!home) { result.error = 'no website on the listing'; return result; }

  const sources = [];
  const add = (emails, from) => {
    let added = 0;
    for (const e of emails) if (!result.emails.includes(e)) { result.emails.push(e); added++; }
    if (added && !sources.includes(from)) sources.push(from);
  };

  const first = await fetchPage(home, { timeoutMs, signal });
  result.pages.push({
    url: home, finalUrl: first.finalUrl, status: first.status,
    ok: first.ok, retriedWithBrowserUa: first.retriedWithBrowserUa,
  });
  if (!first.ok) {
    result.error = first.error || `homepage returned HTTP ${first.status}`;
  } else {
    add(extractEmails(first.html), first.finalUrl);
  }

  // The likely contact page: a same-site contact/about link if the homepage has
  // one, otherwise the conventional /contact path. If the homepage never loaded
  // there is no reason to believe /contact will, so do not spend the request.
  if (!first.ok) return result;
  let contact = findContactLink(first.html, first.finalUrl);
  if (!contact) {
    try { contact = new URL('/contact', first.finalUrl || home).toString(); } catch { contact = null; }
  }
  const alreadyRead = result.pages.some((p) => p.finalUrl === contact || p.url === contact);
  if (contact && !alreadyRead && !signal?.aborted) {
    const second = await fetchPage(contact, { timeoutMs, signal });
    result.pages.push({
      url: contact, finalUrl: second.finalUrl, status: second.status,
      ok: second.ok, retriedWithBrowserUa: second.retriedWithBrowserUa,
    });
    if (second.ok) add(extractEmails(second.html), second.finalUrl);
  }

  result.source = sources.length ? sources.join(', ') : null;
  if (result.emails.length) result.error = null;
  return result;
}

// ---------------------------------------------------------- the opener

// The reason line is written about the business ("their only web link ..."),
// because it is read aloud on a call. In an email it is read by the owner, so
// pronouns shift. Only pronouns - every fact in the sentence stays exactly as
// it was verified.
const PRONOUNS = { their: 'your', theirs: 'yours', they: 'you', them: 'you', "they're": "you're", 'they’re': 'you’re' };

function secondPerson(text) {
  return String(text || '').replace(/\b(their|theirs|they['’]re|they|them)\b/gi, (word) => {
    const swap = PRONOUNS[word.toLowerCase()];
    if (!swap) return word;
    return /^[A-Z]/.test(word) ? swap[0].toUpperCase() + swap.slice(1) : swap;
  });
}

function pluralCategory(category) {
  const c = String(category || '').trim().toLowerCase();
  if (!c) return 'small businesses';
  if (/s$/.test(c)) return c;
  return `${c}s`;
}

/** The verified line this lead earned in stage 2, or stage 1's. */
function reasonOf(lead) {
  return String(lead?.reason || lead?.check?.reason || '').trim();
}

function subjectFor(lead, domain) {
  const reason = reasonOf(lead).toLowerCase();
  const bucket = bucketOf(lead);
  const name = String(lead?.name || '').trim();
  if (bucket === 'noWebsite') return `a website for ${name || 'your shop'}`;
  if (bucket === 'socialOnly') return `a site of your own for ${name || 'your shop'}`;
  if (bucket === 'deadDomain') return `${domain || 'your domain'} is not loading`;
  if (/mobile|viewport|phone/.test(reason)) return `${domain || 'your site'} on a phone`;
  if (/not secure|http\b|https/.test(reason)) return `the "Not secure" warning on ${domain || 'your site'}`;
  if (/footer|copyright|20\d\d/.test(reason)) return `the footer year on ${domain || 'your site'}`;
  return `a quick note about ${domain || 'your website'}`;
}

function openingLine(lead, domain) {
  const bucket = bucketOf(lead);
  const name = String(lead?.name || '').trim() || 'your shop';
  if (bucket === 'noWebsite') return `Hi - I came across ${name} on Google Maps.`;
  if (bucket === 'socialOnly') return `Hi - I went looking for a website for ${name} and found the booking link.`;
  if (bucket === 'deadDomain') return `Hi - I tried to open ${domain || `${name}'s website`}.`;
  return `Hi - I had a look at ${domain || `${name}'s website`}.`;
}

/**
 * Step 1 of the sequence, built out of this lead's own reason line - the same
 * sentence the call opens with. Same rules as the reason lines: specific,
 * verifiable, neutral. The owner may have built the site themselves.
 *
 * Placeholders stay bracketed. Nothing here invents a name, a number, a price
 * or a postal address, and the unsubscribe line is part of the body, not an
 * afterthought - it is what keeps a sending domain alive.
 */
export function draftOpener(lead) {
  const domain = hostOf(lead?.website);
  const reason = secondPerson(reasonOf(lead));
  const where = String(lead?.city || '').trim();
  const trade = pluralCategory(lead?.category);

  const observation = reason
    // No verdict has been written for this lead yet; say that instead of
    // inventing an observation about a site nobody looked at.
    || '[NO REASON LINE YET - run the site check before sending this]';

  const offer = where
    ? `I build small sites for ${trade} around ${where}. Want me to send over what a current one would look like for you?`
    : `I build small sites for ${trade}. Want me to send over what a current one would look like for you?`;

  const body = [
    openingLine(lead, domain),
    '',
    observation,
    '',
    offer,
    '',
    '[YOUR NAME]',
    '[YOUR PHONE]',
    '',
    '--',
    '[YOUR BUSINESS ADDRESS]',
    'Not interested? Reply "stop" and I will not write again, or unsubscribe here: [UNSUBSCRIBE LINK]',
  ].join('\n');

  return { subject: subjectFor(lead, domain), body };
}

// ------------------------------------------------------------- Instantly

// The request shape below was written from Instantly's published v2 API
// documentation. NO Instantly API key exists in this session, so it has NOT
// been verified against a live account - no real request/response pair was ever
// observed. Treat the field names as documentation-derived until a first real
// send confirms them, and expect to adjust them if the API answers differently.
export const INSTANTLY_API_ROOT = 'https://api.instantly.ai/api/v2';

/** Is a real Instantly config present? Used by GET /api/config. */
export function instantlyStatus(env = process.env) {
  const apiKey = env.INSTANTLY_API_KEY || '';
  const campaignId = env.INSTANTLY_CAMPAIGN_ID || '';
  return {
    configured: Boolean(apiKey && campaignId),
    hasApiKey: Boolean(apiKey),
    hasCampaignId: Boolean(campaignId),
    verifiedAgainstLiveAccount: false,
  };
}

function unconfiguredError(missing) {
  return new Error(
    `Instantly is not configured, so nothing was sent. Missing: ${missing.join(' and ')}. `
    + 'Set INSTANTLY_API_KEY (Instantly -> Settings -> Integrations -> API keys, a v2 key) '
    + 'and INSTANTLY_CAMPAIGN_ID (the campaign id from its URL), or pass { apiKey, campaignId } '
    + 'to pushToInstantly(). Note: this request shape comes from the v2 docs and has not yet '
    + 'been confirmed against a live account.',
  );
}

/** The exact body that would be POSTed for one lead. */
function instantlyPayload(lead, email, campaignId) {
  const name = String(lead?.name || '').trim();
  const { subject, body } = draftOpener(lead);
  return {
    campaign: campaignId,
    email,
    company_name: name,
    website: lead?.website || undefined,
    phone: lead?.phone || undefined,
    personalization: subject,
    custom_variables: {
      place_id: lead?.place_id || '',
      reason: reasonOf(lead),
      tier: effectiveTier(lead),
      city: lead?.city || '',
      draft_subject: subject,
      draft_body: body,
    },
  };
}

/**
 * Push leads into an Instantly campaign as step-1 recipients.
 *
 * Throws when unconfigured or when no lead has an address - it never reports a
 * send it did not make. `previewOnly: true` returns the exact request bodies
 * without contacting the API at all, and says so in the result (`sent: 0`).
 *
 * `leads` may carry `email`/`emails` directly, or `addresses` (the findAddresses
 * result) can be passed and the address looked up by place_id.
 */
export async function pushToInstantly({
  apiKey = process.env.INSTANTLY_API_KEY,
  campaignId = process.env.INSTANTLY_CAMPAIGN_ID,
  leads = [],
  addresses = null,
  previewOnly = false,
  onProgress,
  signal,
  timeoutMs = 20000,
  apiRoot = INSTANTLY_API_ROOT,
} = {}) {
  const log = typeof onProgress === 'function' ? onProgress : () => {};

  // Resolve one address per lead. A lead without one is skipped by name, not
  // silently dropped and not given an invented address.
  const recipients = [];
  const skipped = [];
  for (const lead of leads) {
    const fromLead = lead.email || (Array.isArray(lead.emails) ? lead.emails[0] : null);
    const fromScan = addresses?.[lead.place_id]?.emails?.[0] || null;
    const email = (fromLead || fromScan || '').trim().toLowerCase();
    if (!email) {
      skipped.push({ place_id: lead.place_id, name: lead.name, reason: 'no address found for this lead' });
      continue;
    }
    if (!isUsableAddress(email)) {
      skipped.push({ place_id: lead.place_id, name: lead.name, reason: `address does not look usable: ${email}` });
      continue;
    }
    recipients.push({ lead, email });
  }

  if (previewOnly) {
    log(`Preview only - nothing sent. ${recipients.length} request(s) prepared.`);
    return {
      ok: true,
      previewOnly: true,
      sent: 0,
      note: 'Nothing was sent. These are the request bodies pushToInstantly would POST to '
        + `${apiRoot}/leads. Shape is from the Instantly v2 docs and is unverified.`,
      endpoint: `${apiRoot}/leads`,
      wouldSend: recipients.map(({ lead, email }) => instantlyPayload(lead, email, campaignId || '[YOUR CAMPAIGN ID]')),
      skipped,
    };
  }

  const missing = [];
  if (!apiKey) missing.push('INSTANTLY_API_KEY');
  if (!campaignId) missing.push('INSTANTLY_CAMPAIGN_ID');
  if (missing.length) throw unconfiguredError(missing);

  if (!recipients.length) {
    throw new Error(
      `Nothing to push: none of the ${leads.length} lead(s) has an email address. `
      + 'Run the address scan first - and expect some leads to have no address at all, '
      + 'which makes them phone-only.',
    );
  }

  const results = [];
  const failed = [];
  let added = 0;

  for (const { lead, email } of recipients) {
    if (signal?.aborted) break;
    const payload = instantlyPayload(lead, email, campaignId);
    const ctrl = new AbortController();
    const unlink = linkAbort(signal, ctrl);
    const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetch(`${apiRoot}/leads`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* keep the raw text */ }
      if (!res.ok) {
        const message = instantlyErrorMessage(res.status, json, text);
        failed.push({ place_id: lead.place_id, name: lead.name, email, status: res.status, error: message });
        log(`${lead.name}: not added (${message})`);
        // A rejected key or a missing campaign will reject every remaining lead
        // too. Stop rather than hammer the API.
        if ([401, 403, 404].includes(res.status)) {
          log('Stopping - that error applies to every remaining lead.');
          break;
        }
        continue;
      }
      added++;
      results.push({ place_id: lead.place_id, name: lead.name, email, status: res.status, response: json });
      log(`${lead.name}: added as ${email}`);
    } catch (err) {
      const message = describeError(err);
      failed.push({ place_id: lead.place_id, name: lead.name, email, status: null, error: message });
      log(`${lead.name}: not added (${message})`);
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  return {
    ok: failed.length === 0,
    previewOnly: false,
    campaignId,
    endpoint: `${apiRoot}/leads`,
    attempted: recipients.length,
    added,
    sent: 0,   // Instantly sends on its own schedule; adding a lead is not a send.
    results,
    failed,
    skipped,
    note: 'Leads were added to the campaign. Instantly sends them on the campaign schedule - '
      + 'nothing has gone out at this moment. Request shape is from the v2 docs and unverified.',
  };
}

function instantlyErrorMessage(status, json, text) {
  const detail = json?.message || json?.error || (text ? text.slice(0, 300) : '');
  if (status === 401) return `Instantly rejected the API key (401). ${detail}`.trim();
  if (status === 403) return `The API key is not allowed to do this (403). ${detail}`.trim();
  if (status === 404) return `Campaign not found at ${status} - check INSTANTLY_CAMPAIGN_ID. ${detail}`.trim();
  if (status === 422) return `Instantly rejected the payload (422) - the documented field names may be wrong. ${detail}`.trim();
  if (status === 429) return `Rate limited by Instantly (429). ${detail}`.trim();
  return `HTTP ${status}. ${detail}`.trim();
}
