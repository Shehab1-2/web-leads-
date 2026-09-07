// Local HTTP server for the web-leads app.
//
// Zero dependencies, node: builtins only. Binds to 127.0.0.1 — this is a tool
// for one person at a desk, not something to expose. On a hosting platform it
// binds publicly instead, and APP_PASSWORD is the only thing between the call
// list and whoever finds the URL, so set it there.
//
//   node app/server.mjs
//
// Long jobs (search, site checks, address scans) stream server-sent events so
// the UI can show progress as it happens rather than freezing on a request.

import http from 'node:http';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from './lib/store.mjs';
import { rankLeads, countByTier, effectiveTier, isLead, TIER_LABEL, STAGE1_TIERS, TIER_ORDER } from './lib/rank.mjs';
import * as apify from './lib/apify.mjs';
import { checkAll } from './lib/sitecheck.mjs';
import * as mail from './lib/email.mjs';
import { toCsv } from './lib/csv.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const DEFAULT_PORT = Number(process.env.PORT) || 4173;
const PORT_FROM_ENV = Boolean(String(process.env.PORT || '').trim());

// Loopback unless we are demonstrably on a hosting platform, where the router
// only reaches a container that binds every interface. Setting HOST covers any
// platform not named here; nothing changes for `node app/server.mjs` at a desk.
const ON_PLATFORM = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID);
const HOST = (process.env.HOST || '').trim() || (ON_PLATFORM ? '0.0.0.0' : '127.0.0.1');

/** Shared password. Empty means no gate — fine on loopback, reckless in public. */
const PASSWORD = (process.env.APP_PASSWORD || '').trim();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** One job of a given kind per run at a time; a second gets a 409. */
const running = new Map();

// ------------------------------------------------------------------ replies

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

const ok = (res, data) => sendJson(res, 200, { ok: true, ...data });
const fail = (res, status, error) => sendJson(res, status, { ok: false, error });

function openStream(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event, payload) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  return {
    log: (message) => send('log', { message: String(message) }),
    progress: (payload) => send('progress', payload),
    done: (payload) => { send('done', payload || {}); res.end(); },
    error: (message) => { send('error', { error: String(message) }); res.end(); },
  };
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw new Error('body was not valid JSON'); }
}

// ------------------------------------------------------------------- static

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  // Confirm the resolved path is still inside public/ before touching disk.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return fail(res, 403, 'forbidden');
  }
  let data;
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return serveStatic(req, res, path.posix.join(pathname, 'index.html'));
    data = await fs.readFile(target);
  } catch {
    return fail(res, 404, `not found: ${pathname}`);
  }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  res.end(data);
}

// -------------------------------------------------------------- api helpers

function config() {
  const instantly = mail.instantlyStatus(process.env);
  return {
    // Booleans only — the token values never leave the process.
    apifyToken: Boolean((process.env.APIFY_API_TOKEN || '').trim()),
    instantly: Boolean(instantly.configured),
    instantlyDetail: instantly,
    passwordSet: Boolean(PASSWORD),
    onPlatform: ON_PLATFORM,
    // A path, not a secret — the Settings page shows where the data lives.
    dataDir: store.DATA_DIR,
    dataDirIsRepo: store.DATA_DIR === store.REPO_DATA_DIR,
    backend: store.BACKEND,
  };
}

async function runSummary(slug, statuses) {
  const { meta, leads } = await store.readRun(slug);
  const kept = leads.filter((l) => isLead(effectiveTier(l)));
  return {
    ...meta,
    slug,
    total: leads.length,
    leads: kept.length,
    dropped: leads.length - kept.length,
    needsCheck: leads.filter((l) => effectiveTier(l) === 'needs_check').length,
    toCall: kept.filter((l) => !statuses[l.place_id]).length,
  };
}

async function statePayload() {
  const statuses = await store.currentStatuses();
  const runs = await store.listRuns();
  const summaries = [];
  for (const r of runs) summaries.push(await runSummary(r.slug, statuses));
  const seen = await store.readSeen();
  return {
    runs: summaries,
    activeRun: summaries[0] || null,
    statuses,
    historyCount: seen.length,
    config: config(),
  };
}

async function requireRun(slug) {
  const runs = await store.listRuns();
  if (!runs.some((r) => r.slug === slug)) {
    const err = new Error(`no run called "${slug}"`);
    err.status = 404;
    throw err;
  }
}

function guard(key) {
  if (running.has(key)) {
    const err = new Error('that job is already running for this search');
    err.status = 409;
    throw err;
  }
  running.set(key, Date.now());
  return () => running.delete(key);
}

/** The finished call list, in the format call-lists/ has always used. */
function callListMarkdown(meta, leads, date) {
  const ranked = rankLeads(leads);
  const callable = ranked.filter((l) => isLead(effectiveTier(l)));
  const dropped = ranked.length - callable.length;
  const lines = [
    `# ${meta.niche || 'leads'} — ${meta.location || ''} — ${date}`,
    '',
    `Ranked strongest-first. ${callable.length} callable lead(s) from ${ranked.length} pulled; ${dropped} healthy site(s) dropped.`,
    '',
  ];
  callable.forEach((l, i) => {
    const tier = effectiveTier(l);
    lines.push(`## ${i + 1}. ${l.name} — ${l.phone || 'no phone listed'}`);
    const bits = [TIER_LABEL[tier] || tier];
    if (l.rating) bits.push(`${l.rating}★ (${l.reviews || 0} reviews)`);
    lines.push(`- ${bits.join(' · ')}`);
    if (l.address) lines.push(`- ${l.address}`);
    if (l.website) lines.push(`- ${l.website}`);
    if (l.reason) lines.push(`- Opener: ${l.reason}`);
    if (l.maps_url) lines.push(`- ${l.maps_url}`);
    lines.push('');
  });
  return lines.join('\n');
}

// ------------------------------------------------------------------- routes

async function api(req, res, pathname) {
  const method = req.method;

  if (method === 'GET' && pathname === '/api/state') return ok(res, await statePayload());
  if (method === 'GET' && pathname === '/api/config') return ok(res, config());

  if (method === 'GET' && pathname === '/api/runs') {
    const statuses = await store.currentStatuses();
    const runs = await store.listRuns();
    const out = [];
    for (const r of runs) out.push(await runSummary(r.slug, statuses));
    return ok(res, { runs: out });
  }

  let m;

  // Export a run as the finished call list. Markdown follows the repo's
  // call-lists/ convention; csv streams the run file as-is. ?save=1 also
  // writes the markdown into call-lists/ on the server. Matched before the
  // generic run route — its greedy (.+) would swallow this path.
  if (method === 'GET' && (m = pathname.match(/^\/api\/runs\/([^/]+)\/export\.(md|csv)$/))) {
    const slug = decodeURIComponent(m[1]);
    await requireRun(slug);
    const { meta, leads } = await store.readRun(slug);
    const date = meta.date || new Date().toISOString().slice(0, 10);
    const base = `${store.slugify(meta.niche || slug, meta.location || '')}-${date}`;
    if (m[2] === 'csv') {
      // Built from the rows, not read off disk — the Postgres backend has no
      // file to read, and this way both backends export byte-identical CSV.
      const csv = toCsv(store.LEAD_COLUMNS, rankLeads(leads));
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${base}.csv"`,
        'cache-control': 'no-store',
      });
      return res.end(csv);
    }
    const md = callListMarkdown(meta, leads, date);
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.searchParams.get('save') === '1') {
      const dir = path.join(store.ROOT, 'call-lists');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${base}.md`), md, 'utf8');
    }
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${base}.md"`,
      'cache-control': 'no-store',
    });
    return res.end(md);
  }

  // Add a hand-entered lead — a referral, a business spotted on foot.
  if (method === 'POST' && (m = pathname.match(/^\/api\/runs\/([^/]+)\/leads$/))) {
    const slug = decodeURIComponent(m[1]);
    await requireRun(slug);
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const phone = String(body.phone || '').trim();
    if (!name) return fail(res, 400, 'A business name is required.');
    if (!phone) return fail(res, 400, 'A phone number is required — the list exists to be called.');
    const website = String(body.website || '').trim();
    const tier = String(body.tier || '').trim() || (website ? 'needs_check' : 'no_website');
    if (![...STAGE1_TIERS, ...TIER_ORDER].includes(tier)) return fail(res, 400, `unknown tier: ${tier}`);
    if (tier !== 'no_website' && !website && tier !== 'needs_check') {
      return fail(res, 400, `tier "${tier}" describes a website, but no website was given`);
    }
    const lead = {
      tier, name, phone,
      address: String(body.address || '').trim(),
      city: String(body.city || '').trim(),
      category: String(body.category || '').trim(),
      website,
      rating: '', reviews: '',
      maps_url: '',
      place_id: `manual_${crypto.randomBytes(8).toString('hex')}`,
      checked_tier: '',
      reason: String(body.reason || '').trim()
        || (tier === 'no_website' ? 'Added by hand — no website.' : 'Added by hand.'),
    };
    const row = await store.addLead(slug, lead);
    const meta2 = await store.readRunMeta(slug);
    await store.appendSeen([row], meta2.niche || '', meta2.location || '', new Date().toISOString().slice(0, 10));
    return ok(res, { lead: row });
  }

  // Correct a lead by hand — a phone that changed, a verdict that was wrong.
  if (method === 'PATCH' && (m = pathname.match(/^\/api\/runs\/([^/]+)\/leads\/(.+)$/))) {
    const slug = decodeURIComponent(m[1]);
    await requireRun(slug);
    const body = await readBody(req);
    const fields = {};
    for (const k of store.EDITABLE_FIELDS) if (body[k] !== undefined) fields[k] = body[k];
    if (!Object.keys(fields).length) {
      return fail(res, 400, `nothing to update — editable fields: ${store.EDITABLE_FIELDS.join(', ')}`);
    }
    if (fields.checked_tier !== undefined && fields.checked_tier !== ''
      && !TIER_ORDER.includes(fields.checked_tier) && fields.checked_tier !== 'not_a_lead') {
      return fail(res, 400, `unknown tier: ${fields.checked_tier}`);
    }
    if (fields.name !== undefined && !String(fields.name).trim()) {
      return fail(res, 400, 'a lead needs a name');
    }
    const lead = await store.updateLead(slug, decodeURIComponent(m[2]), fields);
    return ok(res, { lead });
  }

  // Remove one lead from a run. Its seen_leads row stays — removing it from
  // today's list must not make it resurface in next month's search.
  if (method === 'DELETE' && (m = pathname.match(/^\/api\/runs\/([^/]+)\/leads\/(.+)$/))) {
    const slug = decodeURIComponent(m[1]);
    await requireRun(slug);
    await store.removeLead(slug, decodeURIComponent(m[2]));
    return ok(res, { removed: 1 });
  }

  // Delete a whole run. History and outcomes are untouched.
  if (method === 'DELETE' && (m = pathname.match(/^\/api\/runs\/([^/]+)$/))) {
    const slug = decodeURIComponent(m[1]);
    await requireRun(slug);
    await store.deleteRun(slug);
    return ok(res, { deleted: slug });
  }

  if (method === 'GET' && (m = pathname.match(/^\/api\/runs\/(.+)$/))) {
    const slug = decodeURIComponent(m[1]);
    await requireRun(slug);
    const { meta, leads } = await store.readRun(slug);
    const statuses = await store.currentStatuses();
    const withStatus = leads.map((l) => ({
      ...l,
      outcome: statuses[l.place_id] || null,
      isLead: isLead(effectiveTier(l)),
      effectiveTier: effectiveTier(l),
    }));
    // `leads` carries the whole run, ranked, with each row flagged `isLead` —
    // the views need the full set to report what was pulled and how many sites
    // were checked. rankLeads sorts healthy sites to the bottom, and `dropped`
    // is the same rows again for convenience.
    const ranked = rankLeads(withStatus);
    const dropped = withStatus.filter((l) => !l.isLead);
    return ok(res, {
      meta,
      leads: ranked,
      dropped,
      callable: ranked.filter((l) => l.isLead).length,
      counts: countByTier(leads),
      total: leads.length,
    });
  }

  // The full outcome trail for one business — every call ever logged against
  // it, oldest first. The outcomes log is append-only, so this is free.
  if (method === 'GET' && (m = pathname.match(/^\/api\/activity\/(.+)$/))) {
    const placeId = decodeURIComponent(m[1]);
    if (!placeId) return fail(res, 400, 'place_id is required');
    const rows = (await store.readOutcomes())
      .filter((r) => r.place_id === placeId)
      .map((r) => ({ at: r.at, status: r.status, note: r.note || '' }));
    return ok(res, { rows });
  }

  // Every business ever scraped, across every run, with its run and outcome
  // joined on. The table view works from this; it is deliberately one request
  // rather than one per run.
  if (method === 'GET' && pathname === '/api/leads') {
    const statuses = await store.currentStatuses();
    const runs = await store.listRuns();
    const rows = [];
    for (const r of runs) {
      const { meta, leads } = await store.readRun(r.slug);
      for (const l of leads) {
        rows.push({
          ...l,
          run: r.slug,
          niche: meta.niche || '',
          location: meta.location || '',
          date: meta.date || '',
          effectiveTier: effectiveTier(l),
          isLead: isLead(effectiveTier(l)),
          outcome: statuses[l.place_id] || null,
        });
      }
    }
    return ok(res, { rows, runs: runs.map((r) => r.slug), columns: store.LEAD_COLUMNS });
  }

  if (method === 'GET' && pathname === '/api/history') {
    const seen = await store.readSeen();
    const statuses = await store.currentStatuses();
    // Join the final verdict from every run so history shows what was decided,
    // not just the stage-1 guess seen_leads happens to store.
    const verdicts = new Map();
    for (const r of await store.listRuns()) {
      const { leads } = await store.readRun(r.slug);
      for (const l of leads) verdicts.set(l.place_id, { tier: effectiveTier(l), reason: l.reason || '' });
    }
    const rows = seen.map((s) => {
      const v = verdicts.get(s.place_id) || {};
      return {
        ...s,
        verdict: v.tier || s.tier,
        reason: v.reason || '',
        outcome: statuses[s.place_id] || null,
        isLead: isLead(v.tier || s.tier),
      };
    });
    return ok(res, { rows });
  }

  if (method === 'GET' && (m = pathname.match(/^\/api\/email\/(.+)$/))) {
    const slug = decodeURIComponent(m[1]);
    await requireRun(slug);
    const { leads } = await store.readRun(slug);
    const kept = rankLeads(leads.filter((l) => isLead(effectiveTier(l))));
    const buckets = mail.emailability(kept);
    const drafts = {};
    for (const l of kept) {
      if (l.reason) { try { drafts[l.place_id] = mail.draftOpener(l); } catch { /* skip undraftable */ } }
    }
    return ok(res, {
      emailability: buckets,
      drafts,
      instantly: mail.instantlyStatus(process.env),
      note: mail.EMAIL_REACH_NOTE,
    });
  }

  if (method === 'POST' && pathname === '/api/outcome') {
    const body = await readBody(req);
    const placeId = String(body.place_id || '').trim();
    if (!placeId) return fail(res, 400, 'place_id is required');
    if (!store.OUTCOMES.includes(body.status)) {
      return fail(res, 400, `status must be one of: ${store.OUTCOMES.join(', ')}`);
    }
    const result = await store.appendOutcome({
      place_id: placeId,
      status: body.status,
      note: typeof body.note === 'string' ? body.note : '',
    });
    return ok(res, { status: result });
  }

  if (method === 'POST' && pathname === '/api/search') {
    const body = await readBody(req);
    const niche = String(body.niche || '').trim();
    const location = String(body.location || '').trim();
    const max = Number(body.max) || 15;
    if (!niche) return fail(res, 400, 'A trade is required — "small businesses" returns an unworkable list.');
    if (!location) return fail(res, 400, 'A location is required, e.g. "Piscataway, NJ".');
    if (max < 1 || max > 200) return fail(res, 400, '--max must be between 1 and 200');
    const token = (process.env.APIFY_API_TOKEN || '').trim();
    if (!token) {
      return fail(res, 400, 'APIFY_API_TOKEN is not set for this process. Set it, then restart the server.');
    }
    const release = guard(`search:${niche}|${location}`);
    const s = openStream(res);
    try {
      const { leads, details } = await apify.search({
        niche, location, max, token, onProgress: s.log,
        // The UI asks before a big run; without this the guard in apify.mjs is
        // unreachable from a browser, which has no way to "re-run with yes".
        yes: Boolean(body.confirm),
      });
      let kept = leads;
      let skipped = 0;
      if (!body.includeSeen) {
        const seen = await store.readSeen();
        // filterSeen returns { kept, skipped }. Assigning that object straight
        // to `kept` left kept.length undefined, so every filtered search took
        // the "nothing new" branch and discarded results already paid for.
        ({ kept, skipped } = apify.filterSeen(kept, seen));
        if (skipped) s.log(`${skipped} already surfaced in an earlier run, filtered out`);
      }
      if (!kept.length) {
        // Never overwrite a previous run's list with an empty one.
        s.log('No new businesses — nothing was written, your existing lists are untouched.');
        return s.done({ slug: null, skipped, leads: 0 });
      }
      const slug = store.slugify(niche, location);
      const date = new Date().toISOString().slice(0, 10);
      const ranked = rankLeads(kept);
      await store.writeRun(slug, { niche, location, date, max, cost: max * apify.USD_PER_PLACE }, ranked);
      if (details && Object.keys(details).length) await store.writeDetails(slug, details);
      await store.appendSeen(ranked, niche, location, date);
      s.log(`saved ${ranked.length} lead(s) to ${store.BACKEND === 'postgres' ? 'the database' : `data/leads_${slug}.csv`}`);
      s.done({ slug, leads: ranked.length, skipped, counts: countByTier(ranked) });
    } catch (err) {
      s.error(err.message);
    } finally { release(); }
    return undefined;
  }

  if (method === 'POST' && (m = pathname.match(/^\/api\/check\/(.+)$/))) {
    const slug = decodeURIComponent(m[1]);
    await requireRun(slug);
    const body = await readBody(req);
    const release = guard(`check:${slug}`);
    const s = openStream(res);
    try {
      const { leads } = await store.readRun(slug);
      const hasSite = (l) => String(l.website || '').trim();
      // Verdicts go stale — a site that was http-only in March can be on HTTPS
      // by June, and the stored opener would then be wrong on the call. `force`
      // re-checks everything with a site, not just the never-checked ones.
      const todo = body.force
        ? leads.filter(hasSite)
        : leads.filter((l) => hasSite(l) && effectiveTier(l) === 'needs_check');
      if (!todo.length) {
        s.log(leads.some(hasSite)
          ? 'Every site in this run already has a verdict. Re-check them with force to refresh.'
          : 'No lead in this run has a site to check.');
        return s.done({ checks: {}, checked: 0 });
      }
      s.log(`Checking ${todo.length} site(s)${body.force ? ' (refreshing existing verdicts)' : ''} — HTTP only, no browser in this session.`);
      const checks = await checkAll(todo, {
        concurrency: 4,
        onProgress: (p) => { s.log(p.message); s.progress(p); },
      });
      const existing = await store.readChecks(slug);
      const merged = { ...existing, ...checks };
      await store.writeChecks(slug, merged);
      const verdicts = {};
      for (const [placeId, c] of Object.entries(checks)) verdicts[placeId] = { tier: c.tier, reason: c.reason };
      await store.writeRunVerdicts(slug, verdicts);
      s.log(`wrote checked_tier and reason back into data/leads_${slug}.csv`);
      s.done({ checks: merged, checked: Object.keys(checks).length });
    } catch (err) {
      s.error(err.message);
    } finally { release(); }
    return undefined;
  }

  if (method === 'POST' && (m = pathname.match(/^\/api\/email\/([^/]+)\/scan$/))) {
    const slug = decodeURIComponent(m[1]);
    await requireRun(slug);
    const release = guard(`scan:${slug}`);
    const s = openStream(res);
    try {
      const { leads } = await store.readRun(slug);
      const kept = leads.filter((l) => isLead(effectiveTier(l)));
      const buckets = mail.emailability(kept);
      const targets = (buckets.emailable || []).map((b) => b.lead || b);
      if (!targets.length) {
        s.log('No lead in this run has a working site of its own to scan.');
        return s.done({ addresses: {} });
      }
      s.log(`Scanning ${targets.length} site(s) for a contact address.`);
      const addresses = await mail.findAddresses(targets, {
        concurrency: 4,
        onProgress: (p) => { s.log(p.message || String(p)); s.progress(p); },
      });
      s.done({ addresses });
    } catch (err) {
      s.error(err.message);
    } finally { release(); }
    return undefined;
  }

  return fail(res, 404, `no such endpoint: ${method} ${pathname}`);
}

// --------------------------------------------------------------------- auth

/**
 * Basic auth against APP_PASSWORD. The username is ignored — there is one
 * operator, and asking them to remember a second field buys nothing. Returns
 * true unchallenged when no password is configured.
 */
function authorized(req) {
  if (!PASSWORD) return true;
  const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
  if (!/^basic$/i.test(scheme || '') || !encoded) return false;
  let supplied;
  try {
    supplied = Buffer.from(encoded, 'base64').toString('utf8').split(':').slice(1).join(':');
  } catch { return false; }
  // Compare over a fixed-width digest so length alone cannot be probed.
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function challenge(res) {
  const body = JSON.stringify({ ok: false, error: 'password required' });
  res.writeHead(401, {
    'www-authenticate': 'Basic realm="web-leads", charset="UTF-8"',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// ------------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { /* keep default */ }
  // Answered before the gate: a platform's health probe carries no credentials,
  // and a 401 there reads as a failed deploy. Says nothing a stranger can use.
  if (pathname === '/api/health') return ok(res, { status: 'up' });
  if (!authorized(req)) return challenge(res);
  try {
    if (pathname.startsWith('/api/')) await api(req, res, pathname);
    else await serveStatic(req, res, pathname);
  } catch (err) {
    // One bad request must never take the server down mid-call-session.
    if (!res.headersSent) fail(res, err.status || 500, err.message || 'something went wrong');
    else if (!res.writableEnded) res.end();
  }
});

// Locally this stays on the loopback and hops to a free port if 4173 is busy.
// On a host like Railway, PORT and HOST are assigned and the router only talks
// to that exact port, so hopping would make the app unreachable — bind what we
// were given, or fail loudly.
function listen(port, attemptsLeft = PORT_FROM_ENV ? 0 : 12) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    console.error(`Could not start the server: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, HOST);
}

// Registered once, not per attempt, and reading the port back off the socket:
// a listen callback passed per attempt survives that attempt failing, so after
// a port hop every earlier attempt would announce a URL nothing is bound to.
server.on('listening', () => {
  const { port } = server.address();
  const c = config();
  const shown = HOST === '0.0.0.0' ? `port ${port}` : `http://${HOST}:${port}`;
  console.log(`web-leads running on ${shown}`);
  console.log(`  Apify token:  ${c.apifyToken ? 'found' : 'NOT set — searching is disabled until you set APIFY_API_TOKEN'}`);
  console.log(`  Instantly:    ${c.instantly ? 'configured' : 'not configured — the cold-email push is disabled'}`);
  console.log(`  Password:     ${PASSWORD ? 'set — the app asks for one' : 'NOT set — anyone who reaches this port gets in'}`);
  if (HOST === '127.0.0.1') console.log('  Ctrl-C to stop.');
});

process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

const seed = await store.seedDataDir();
if (seed.seeded) console.log(`data directory: ${store.DATA_DIR} (${seed.reason})`);
else if (store.DATA_DIR !== store.REPO_DATA_DIR) console.log(`data directory: ${store.DATA_DIR}`);

listen(DEFAULT_PORT);
