// End-to-end check of stage 1: POST /api/search all the way to a saved run.
//
//   node app/tools/search-flow-check.mjs
//
// Self-contained. Stands up a fake Apify and points the real server at it with
// APIFY_API_ROOT, so the whole path — start run, poll, fetch dataset, classify,
// filter against history, rank, persist — is exercised without spending credit.
//
// This exists because a search could succeed at Apify, cost real money, and
// then be silently discarded by the server: filterSeen returns
// { kept, skipped } and the caller assigned that object straight to `kept`, so
// `kept.length` was undefined and every filtered search took the "nothing new"
// branch. Both harnesses passed throughout — neither ever ran a search.

import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SERVER = path.join(HERE, '..', 'server.mjs');

// ------------------------------------------------------------- fake apify

const PLACES = [
  { placeId: 'fake_salon_1', title: 'Capelli Salon', website: 'https://www.capellihairsalonllc.com/', phone: '(732) 555-0201', totalScore: 4.6, reviewsCount: 120 },
  { placeId: 'fake_salon_2', title: 'Elite Hair Styling', website: null, phone: '(732) 555-0202', totalScore: 4.4, reviewsCount: 186 },
  { placeId: 'fake_salon_3', title: 'Jenny Hair & Beauty', website: 'http://jennyshairandbeauty.us/', phone: '(732) 555-0203', totalScore: 4.1, reviewsCount: 44 },
  { placeId: 'fake_salon_4', title: 'Glow Salon', website: 'https://www.facebook.com/glowsalonnj', phone: '(732) 555-0204', totalScore: 4.8, reviewsCount: 77 },
  { placeId: 'fake_salon_5', title: 'Payal Beauty Salon', website: null, phone: '(732) 555-0205', totalScore: 4.2, reviewsCount: 31 },
].map((p) => ({
  ...p,
  city: 'Piscataway',
  address: `${p.title}, Piscataway, NJ 08854`,
  categoryName: 'Beauty salon',
  permanentlyClosed: false,
  temporarilyClosed: false,
}));

let lastPayload = null;

const apify = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fake');
  const json = (body) => {
    const t = JSON.stringify(body);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t) });
    res.end(t);
  };
  if (req.method === 'POST' && /\/acts\/.+\/runs$/.test(url.pathname)) {
    // Keep the input the server sent, so the add-on flags can be asserted.
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { lastPayload = JSON.parse(raw); } catch { lastPayload = null; }
      json({ data: { id: 'FAKERUN', defaultDatasetId: 'FAKEDATA', status: 'RUNNING' } });
    });
    return undefined;
  }
  if (/\/actor-runs\/FAKERUN$/.test(url.pathname)) {
    return json({ data: { id: 'FAKERUN', status: 'SUCCEEDED', defaultDatasetId: 'FAKEDATA' } });
  }
  if (/\/datasets\/FAKEDATA\/items$/.test(url.pathname)) {
    // Mirrors the real actor: contact fields appear only when asked for.
    if (lastPayload && lastPayload.scrapeContacts) {
      return json(PLACES.map((p, i) => (i === 0
        ? { ...p, emails: ['owner@capellisalon.test'], facebooks: ['https://facebook.com/capelli'] }
        : p)));
    }
    return json(PLACES);
  }
  res.writeHead(404); res.end('{}');
});

await new Promise((r) => apify.listen(0, '127.0.0.1', r));
const APIFY_ROOT = `http://127.0.0.1:${apify.address().port}`;

// ---------------------------------------------------------------- server

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-leads-flow-'));
const PORT = 4700 + Math.floor(process.hrtime()[1] % 200);
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: dataDir,
    APIFY_API_ROOT: APIFY_ROOT,
    APIFY_API_TOKEN: 'fake-token-for-the-flow-check',
    APP_PASSWORD: '',
    DATABASE_URL: '',          // always the CSV backend; this tests the route
    RAILWAY_ENVIRONMENT: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (b) => { serverLog += b; });
child.stderr.on('data', (b) => { serverLog += b; });

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server never came up. log:\n${serverLog}`);
}

/** Drive an SSE endpoint to completion and return its done payload. */
async function runSearch(body) {
  const res = await fetch(`${BASE}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let done = null;
  const logs = [];
  for (const block of text.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block);
    const data = /^data: (.+)$/m.exec(block);
    if (!ev || !data) continue;
    const payload = JSON.parse(data[1]);
    if (ev[1] === 'done') done = payload;
    else if (ev[1] === 'error') throw new Error(`stream error: ${payload.error}`);
    else if (payload.message) logs.push(payload.message);
  }
  return { done, logs };
}

const failures = [];
const check = (name, cond, detail) => {
  if (cond) console.log(`ok    ${name}`);
  else { console.log(`FAIL  ${name} — ${detail}`); failures.push(name); }
};

try {
  await waitForServer();

  // A fresh DATA_DIR is seeded from the repo's CSVs on first boot, so history
  // starts non-empty. Measure the delta, not the total.
  const before = await (await fetch(`${BASE}/api/state`)).json();
  const historyBefore = before.historyCount;

  // --- 1. a first search must persist every business it pulled ------------
  const first = await runSearch({ niche: 'hair salons', location: 'Piscataway, NJ', max: 20 });
  check('search returns a slug', Boolean(first.done && first.done.slug),
    `done payload was ${JSON.stringify(first.done)} — the run was discarded`);
  check('search reports all 5 leads', first.done && first.done.leads === PLACES.length,
    `expected ${PLACES.length}, got ${first.done && first.done.leads}`);

  const slug = first.done && first.done.slug;
  if (slug) {
    const run = await (await fetch(`${BASE}/api/runs/${encodeURIComponent(slug)}`)).json();
    check('run is readable back', run.ok && run.total === PLACES.length,
      `total was ${run.total}`);
    const tiers = run.leads.map((l) => l.tier);
    check('no_website classified', tiers.filter((t) => t === 'no_website').length === 2,
      `got ${JSON.stringify(tiers)}`);
    check('social_only classified', tiers.includes('social_only'), `got ${JSON.stringify(tiers)}`);
    const state = await (await fetch(`${BASE}/api/state`)).json();
    check('history grew by 5', state.historyCount === historyBefore + PLACES.length,
      `history went ${historyBefore} -> ${state.historyCount}`);
  }

  // --- 2. the same search again, with skip-seen on, finds nothing new -----
  // This is the branch the bug hid behind: it must be reached only when the
  // businesses really were seen before, not on every filtered search.
  const second = await runSearch({ niche: 'hair salons', location: 'Piscataway, NJ', max: 20 });
  check('repeat search skips all 5', second.done && second.done.skipped === PLACES.length,
    `skipped was ${second.done && second.done.skipped}`);
  check('repeat search writes nothing', second.done && second.done.slug === null,
    `slug was ${second.done && second.done.slug}`);

  // --- 3. includeSeen brings them back ------------------------------------
  const third = await runSearch({ niche: 'hair salons', location: 'Piscataway, NJ', max: 20, includeSeen: true });
  check('includeSeen re-writes the run', third.done && third.done.slug && third.done.leads === PLACES.length,
    `done payload was ${JSON.stringify(third.done)}`);

  // --- 3b. the contacts add-on is opt-in and actually lands ---------------
  check('contacts off by default', lastPayload && !lastPayload.scrapeContacts,
    `payload had scrapeContacts=${lastPayload && lastPayload.scrapeContacts}`);

  const enriched = await runSearch({
    niche: 'hair salons', location: 'Piscataway, NJ', max: 20, includeSeen: true, contacts: true,
  });
  check('contacts:true reaches the actor', Boolean(lastPayload && lastPayload.scrapeContacts === true),
    `payload had scrapeContacts=${lastPayload && lastPayload.scrapeContacts}`);
  if (enriched.done && enriched.done.slug) {
    const run = await (await fetch(`${BASE}/api/runs/${encodeURIComponent(enriched.done.slug)}`)).json();
    const withEmail = run.leads.filter((l) => l.email);
    check('email is stored on the lead', withEmail.length === 1 && withEmail[0].email === 'owner@capellisalon.test',
      `got ${JSON.stringify(run.leads.map((l) => l.email))}`);
    check('socials are stored', run.leads.some((l) => String(l.socials || '').includes('facebook.com/capelli')),
      `got ${JSON.stringify(run.leads.map((l) => l.socials))}`);
    check('full record kept per lead', run.leads.every((l) => l.details && l.details.placeId),
      'a lead came back without its details blob');
  }

  // --- 4. the cost guard is reachable and confirmable ---------------------
  let guarded = false;
  try { await runSearch({ niche: 'barbers', location: 'Edison, NJ', max: 90, includeSeen: true }); }
  catch (e) { guarded = /Re-run with yes/.test(e.message); }
  check('runs over 50 are guarded', guarded, 'a 90-place run was not challenged');

  const confirmed = await runSearch({ niche: 'barbers', location: 'Edison, NJ', max: 90, includeSeen: true, confirm: true });
  check('confirm:true clears the guard', Boolean(confirmed.done && confirmed.done.slug),
    `done payload was ${JSON.stringify(confirmed.done)}`);
} catch (err) {
  console.log(`FAIL  harness — ${err.message}`);
  failures.push('harness');
} finally {
  child.kill();
  apify.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}

console.log(`\n=== ${failures.length ? `${failures.length} FAILED` : 'all search-flow checks pass'} ===`);
process.exit(failures.length ? 1 : 0);
