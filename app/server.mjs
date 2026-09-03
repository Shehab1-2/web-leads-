// Local HTTP server for the web-leads app.
//
// Zero dependencies, node: builtins only. Binds to 127.0.0.1 — this is a tool
// for one person at a desk, not something to expose.
//
//   node app/server.mjs
//
// Long jobs (search, site checks, address scans) stream server-sent events so
// the UI can show progress as it happens rather than freezing on a request.

import http from 'node:http';
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
    const kept = rankLeads(withStatus.filter((l) => l.isLead));
    const dropped = withStatus.filter((l) => !l.isLead);
    return ok(res, {
      meta, leads: kept, dropped,
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
    const release = guard(`check:${slug}`);
    const s = openStream(res);
    try {
      const { leads } = await store.readRun(slug);
      const todo = leads.filter((l) => String(l.website || '').trim() && effectiveTier(l) === 'needs_check');
      if (!todo.length) {
        s.log('Every lead in this run is already classified from the Maps data.');
        return s.done({ checks: {}, checked: 0 });
      }
      s.log(`Checking ${todo.length} site(s) — HTTP only, no browser in this session.`);
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

// ------------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { /* keep default */ }
  try {
    if (pathname.startsWith('/api/')) await api(req, res, pathname);
    else await serveStatic(req, res, pathname);
  } catch (err) {
    // One bad request must never take the server down mid-call-session.
    if (!res.headersSent) fail(res, err.status || 500, err.message || 'something went wrong');
    else if (!res.writableEnded) res.end();
  }
});

function listen(port, attemptsLeft = 12) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    console.error(`Could not start the server: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const c = config();
    console.log(`web-leads running at http://127.0.0.1:${port}`);
    console.log(`  Apify token:  ${c.apifyToken ? 'found' : 'NOT set — searching is disabled until you set APIFY_API_TOKEN'}`);
    console.log(`  Instantly:    ${c.instantly ? 'configured' : 'not configured — the cold-email push is disabled'}`);
    console.log('  Ctrl-C to stop.');
  });
}

process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

listen(DEFAULT_PORT);
