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
import { rankLeads, countByTier, effectiveTier, isLead } from './lib/rank.mjs';
import * as apify from './lib/apify.mjs';
import { checkAll } from './lib/sitecheck.mjs';
import * as mail from './lib/email.mjs';

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
      const { leads } = await apify.search({ niche, location, max, token, onProgress: s.log });
      let kept = leads;
      let skipped = 0;
      if (!body.includeSeen) {
        const seen = await store.readSeen();
        const before = kept.length;
        kept = apify.filterSeen(kept, seen);
        skipped = before - kept.length;
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
      await store.appendSeen(ranked, niche, location, date);
      s.log(`wrote data/leads_${slug}.csv`);
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
