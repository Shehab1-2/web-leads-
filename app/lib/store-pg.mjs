// Postgres-backed store. Same surface as store-fs.mjs, so server.mjs cannot
// tell which one it is talking to — see store.mjs for how one gets chosen.
//
// The file-based rules carry over unchanged, because they are product rules
// rather than filesystem rules:
//
//   seen_leads is call history and must never lose a row. Nothing here deletes
//   from it; appendSeen upserts and deliberately leaves an existing row's
//   first_seen and status alone.
//
//   call_outcomes is an append-only log and the source of truth for outcomes.
//   seen_leads.status is a mirror of it, rebuilt from the log on every write.

import pg from 'pg';
import {
  LEAD_COLUMNS, SEEN_COLUMNS, OUTCOME_COLUMNS, OUTCOMES, EDITABLE_FIELDS,
  slugify, ROOT,
} from './store-fs.mjs';

export { LEAD_COLUMNS, SEEN_COLUMNS, OUTCOME_COLUMNS, OUTCOMES, EDITABLE_FIELDS, slugify, ROOT };

// Reported by /api/config so the Settings screen can say where data lives.
export const DATA_DIR = 'postgres';
export const REPO_DATA_DIR = 'postgres';

// Railway's certificate is not in Node's trust store, and the connection runs
// over its private network. Verifying it would fail without buying any real
// security, since the hostname is not publicly routable.
const NEEDS_RELAXED_TLS = /\.railway\.internal|proxy\.rlwy\.net/.test(process.env.DATABASE_URL || '');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: NEEDS_RELAXED_TLS ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => console.error('postgres pool error:', err.message));

const q = (text, params) => pool.query(text, params);

/** Every lead column except the two that identify the row. */
const LEAD_VALUE_COLUMNS = LEAD_COLUMNS.filter((c) => c !== 'place_id');

// ------------------------------------------------------------------- schema

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  slug        TEXT PRIMARY KEY,
  niche       TEXT NOT NULL DEFAULT '',
  location    TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL DEFAULT '',
  max_places  INTEGER,
  cost        DOUBLE PRECISION,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  slug         TEXT NOT NULL REFERENCES runs(slug) ON DELETE CASCADE,
  place_id     TEXT NOT NULL,
  tier         TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  address      TEXT NOT NULL DEFAULT '',
  city         TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT '',
  website      TEXT NOT NULL DEFAULT '',
  rating       TEXT NOT NULL DEFAULT '',
  reviews      TEXT NOT NULL DEFAULT '',
  maps_url     TEXT NOT NULL DEFAULT '',
  checked_tier TEXT NOT NULL DEFAULT '',
  reason       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (slug, place_id)
);

CREATE TABLE IF NOT EXISTS checks (
  slug     TEXT NOT NULL,
  place_id TEXT NOT NULL,
  detail   JSONB NOT NULL,
  PRIMARY KEY (slug, place_id)
);

-- Call history. Rows are added and updated, never deleted.
CREATE TABLE IF NOT EXISTS seen_leads (
  place_id   TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  address    TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  tier       TEXT NOT NULL DEFAULT '',
  niche      TEXT NOT NULL DEFAULT '',
  location   TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT ''
);

-- Append-only. The source of truth for what happened on a call.
CREATE TABLE IF NOT EXISTS call_outcomes (
  id       BIGSERIAL PRIMARY KEY,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  place_id TEXT NOT NULL,
  status   TEXT NOT NULL,
  note     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS details (
  slug     TEXT NOT NULL,
  place_id TEXT NOT NULL,
  detail   JSONB NOT NULL,
  PRIMARY KEY (slug, place_id)
);

CREATE INDEX IF NOT EXISTS call_outcomes_place_idx ON call_outcomes (place_id, at);
CREATE INDEX IF NOT EXISTS leads_slug_idx ON leads (slug);

-- Widening an existing leads table. CREATE TABLE IF NOT EXISTS above is a no-op
-- once the table exists, so every column added after the first deploy has to be
-- named here too.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS state               TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS postal_code         TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email               TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS socials             TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS claim_this_business TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS hours               TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS image_url           TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS description         TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lat                 TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lng                 TEXT NOT NULL DEFAULT '';
`;

let ready = null;

/** Create the schema once per process, and await it before any query. */
export function init() {
  if (!ready) ready = q(SCHEMA).then(() => undefined);
  return ready;
}

// -------------------------------------------------------------------- runs

function leadFromRow(r) {
  const out = {};
  for (const c of LEAD_COLUMNS) out[c] = r[c] ?? '';
  return out;
}

export async function readRunMeta(slug) {
  await init();
  const { rows } = await q('SELECT slug, niche, location, date, max_places, cost FROM runs WHERE slug = $1', [slug]);
  if (!rows.length) return { slug, niche: '', location: '', date: '', max: null };
  const r = rows[0];
  return { slug: r.slug, niche: r.niche, location: r.location, date: r.date, max: r.max_places, cost: r.cost };
}

export async function listRuns() {
  await init();
  const { rows } = await q(`
    SELECT r.slug, r.niche, r.location, r.date, r.max_places, r.cost,
           COUNT(l.place_id)::int AS total
      FROM runs r LEFT JOIN leads l ON l.slug = r.slug
     GROUP BY r.slug
     ORDER BY r.date DESC, r.created_at DESC`);
  return rows.map((r) => ({
    slug: r.slug, niche: r.niche, location: r.location, date: r.date,
    max: r.max_places, cost: r.cost, total: r.total,
  }));
}

export async function readRun(slug) {
  await init();
  const meta = await readRunMeta(slug);
  const { rows } = await q(`SELECT ${LEAD_COLUMNS.join(', ')} FROM leads WHERE slug = $1`, [slug]);
  const checks = await readChecks(slug);
  const detail = await readDetails(slug);
  const leads = rows.map((r) => {
    const l = leadFromRow(r);
    return {
      ...l,
      rating: l.rating === '' ? null : Number(l.rating),
      reviews: l.reviews === '' ? null : Number(l.reviews),
      check: checks[l.place_id] || null,
      details: detail[l.place_id] || null,
    };
  });
  return { meta, leads };
}

export async function writeRun(slug, meta, leads) {
  await init();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO runs (slug, niche, location, date, max_places, cost)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug) DO UPDATE SET
         niche = EXCLUDED.niche, location = EXCLUDED.location,
         date = EXCLUDED.date, max_places = EXCLUDED.max_places, cost = EXCLUDED.cost`,
      [slug, meta.niche || '', meta.location || '', meta.date || '',
        meta.max === undefined || meta.max === null ? null : Number(meta.max),
        meta.cost === undefined || meta.cost === null ? null : Number(meta.cost)],
    );
    // A rewritten run replaces its rows wholesale, exactly as the CSV did.
    await client.query('DELETE FROM leads WHERE slug = $1', [slug]);
    for (const l of leads) {
      const values = LEAD_COLUMNS.map((c) => (l[c] === undefined || l[c] === null ? '' : String(l[c])));
      await client.query(
        `INSERT INTO leads (slug, ${LEAD_COLUMNS.join(', ')})
         VALUES ($1, ${LEAD_COLUMNS.map((_, i) => `$${i + 2}`).join(', ')})`,
        [slug, ...values],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function writeRunVerdicts(slug, verdictsByPlaceId) {
  await init();
  let n = 0;
  for (const [placeId, v] of Object.entries(verdictsByPlaceId)) {
    const { rowCount } = await q(
      'UPDATE leads SET checked_tier = $1, reason = $2 WHERE slug = $3 AND place_id = $4',
      [v.tier || '', v.reason || '', slug, placeId],
    );
    n += rowCount;
  }
  return n;
}

export async function deleteRun(slug) {
  await init();
  // leads cascade; checks are keyed by slug and cleared explicitly. seen_leads
  // and call_outcomes are history and deliberately survive.
  await q('DELETE FROM checks WHERE slug = $1', [slug]);
  await q('DELETE FROM details WHERE slug = $1', [slug]);
  await q('DELETE FROM runs WHERE slug = $1', [slug]);
}

// ------------------------------------------------------------------- leads

export async function updateLead(slug, placeId, fields) {
  await init();
  const patch = EDITABLE_FIELDS.filter((k) => fields[k] !== undefined);
  if (!patch.length) return (await readLead(slug, placeId));
  const sets = patch.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const { rows } = await q(
    `UPDATE leads SET ${sets} WHERE slug = $${patch.length + 1} AND place_id = $${patch.length + 2}
     RETURNING ${LEAD_COLUMNS.join(', ')}`,
    [...patch.map((k) => String(fields[k])), slug, placeId],
  );
  if (!rows.length) throw Object.assign(new Error(`no lead ${placeId} in run ${slug}`), { status: 404 });
  return leadFromRow(rows[0]);
}

async function readLead(slug, placeId) {
  const { rows } = await q(`SELECT ${LEAD_COLUMNS.join(', ')} FROM leads WHERE slug = $1 AND place_id = $2`, [slug, placeId]);
  if (!rows.length) throw Object.assign(new Error(`no lead ${placeId} in run ${slug}`), { status: 404 });
  return leadFromRow(rows[0]);
}

export async function addLead(slug, lead) {
  await init();
  const values = LEAD_COLUMNS.map((c) => (lead[c] === undefined || lead[c] === null ? '' : String(lead[c])));
  try {
    const { rows } = await q(
      `INSERT INTO leads (slug, ${LEAD_COLUMNS.join(', ')})
       VALUES ($1, ${LEAD_COLUMNS.map((_, i) => `$${i + 2}`).join(', ')})
       RETURNING ${LEAD_COLUMNS.join(', ')}`,
      [slug, ...values],
    );
    return leadFromRow(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw Object.assign(new Error('that lead is already in this run'), { status: 409 });
    throw err;
  }
}

export async function removeLead(slug, placeId) {
  await init();
  const { rowCount } = await q('DELETE FROM leads WHERE slug = $1 AND place_id = $2', [slug, placeId]);
  if (!rowCount) throw Object.assign(new Error(`no lead ${placeId} in run ${slug}`), { status: 404 });
  await q('DELETE FROM checks WHERE slug = $1 AND place_id = $2', [slug, placeId]);
  return rowCount;
}

// ------------------------------------------------------------------ checks

export async function readDetails(slug) {
  await init();
  const { rows } = await q('SELECT place_id, detail FROM details WHERE slug = $1', [slug]);
  const out = {};
  for (const r of rows) out[r.place_id] = r.detail;
  return out;
}

export async function writeDetails(slug, detailsByPlaceId) {
  await init();
  for (const [placeId, detail] of Object.entries(detailsByPlaceId)) {
    await q(
      `INSERT INTO details (slug, place_id, detail) VALUES ($1, $2, $3)
       ON CONFLICT (slug, place_id) DO UPDATE SET detail = EXCLUDED.detail`,
      [slug, placeId, JSON.stringify(detail)],
    );
  }
}

export async function readChecks(slug) {
  await init();
  const { rows } = await q('SELECT place_id, detail FROM checks WHERE slug = $1', [slug]);
  const out = {};
  for (const r of rows) out[r.place_id] = r.detail;
  return out;
}

export async function writeChecks(slug, checksByPlaceId) {
  await init();
  for (const [placeId, detail] of Object.entries(checksByPlaceId)) {
    await q(
      `INSERT INTO checks (slug, place_id, detail) VALUES ($1, $2, $3)
       ON CONFLICT (slug, place_id) DO UPDATE SET detail = EXCLUDED.detail`,
      [slug, placeId, JSON.stringify(detail)],
    );
  }
}

// -------------------------------------------------------------- seen_leads

export async function readSeen() {
  await init();
  const { rows } = await q(`SELECT ${SEEN_COLUMNS.join(', ')} FROM seen_leads ORDER BY first_seen, place_id`);
  return rows;
}

/**
 * Record businesses as seen. A place_id already in history keeps its original
 * first_seen and status — being surfaced again is not a new sighting, and must
 * never wipe the outcome of a call that already happened.
 */
export async function appendSeen(leads, niche, location, date) {
  await init();
  const day = date || new Date().toISOString().slice(0, 10);
  for (const l of leads) {
    if (!l.place_id) continue;
    await q(
      `INSERT INTO seen_leads (place_id, name, address, phone, tier, niche, location, first_seen, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '')
       ON CONFLICT (place_id) DO UPDATE SET
         name = EXCLUDED.name, address = EXCLUDED.address, phone = EXCLUDED.phone`,
      [l.place_id, l.name || '', l.address || '', l.phone || '', l.tier || '', niche || '', location || '', day],
    );
  }
}

/** Mirror the outcomes log into seen_leads.status. Never adds or drops a row. */
export async function updateSeenStatus(statusByPlaceId) {
  await init();
  let n = 0;
  for (const [placeId, status] of Object.entries(statusByPlaceId)) {
    const { rowCount } = await q('UPDATE seen_leads SET status = $1 WHERE place_id = $2', [status ?? '', placeId]);
    n += rowCount;
  }
  return n;
}

// ---------------------------------------------------------------- outcomes

export async function readOutcomes() {
  await init();
  const { rows } = await q('SELECT at, place_id, status, note FROM call_outcomes ORDER BY at, id');
  return rows.map((r) => ({
    at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
    place_id: r.place_id,
    status: r.status,
    note: r.note || '',
  }));
}

export async function appendOutcome({ place_id, status, note = '', at }) {
  await init();
  if (!place_id) throw new Error('place_id is required');
  if (!OUTCOMES.includes(status)) throw new Error(`unknown outcome: ${status}`);
  await q(
    'INSERT INTO call_outcomes (at, place_id, status, note) VALUES ($1, $2, $3, $4)',
    [at || new Date().toISOString(), place_id, status, note || ''],
  );
  const map = await currentStatuses();
  await updateSeenStatus(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.status])));
  return map[place_id];
}

/** Latest outcome per business — the log is append-only, so the last row wins. */
export async function currentStatuses() {
  await init();
  const { rows } = await q(`
    SELECT DISTINCT ON (place_id) place_id, status, note, at
      FROM call_outcomes ORDER BY place_id, at DESC, id DESC`);
  const map = {};
  for (const r of rows) {
    map[r.place_id] = {
      status: r.status,
      note: r.note || '',
      at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
    };
  }
  return map;
}

// ------------------------------------------------------------------ seeding

/**
 * An empty database hides the call history the repo ships with, so a first
 * boot imports the CSVs through the filesystem store. Runs once: if any run
 * already exists, nothing is touched.
 */
export async function seedDataDir() {
  await init();
  const { rows } = await q('SELECT COUNT(*)::int AS n FROM runs');
  if (rows[0].n > 0) return { seeded: false, reason: 'database already has runs' };

  const fsStore = await import('./store-fs.mjs');
  const runs = await fsStore.listRuns();
  if (!runs.length) return { seeded: false, reason: 'no CSV data to import' };

  for (const r of runs) {
    const { meta, leads } = await fsStore.readRun(r.slug);
    await writeRun(r.slug, meta, leads);
    const checks = await fsStore.readChecks(r.slug);
    if (Object.keys(checks).length) await writeChecks(r.slug, checks);
    const detail = await fsStore.readDetails(r.slug);
    if (Object.keys(detail).length) await writeDetails(r.slug, detail);
  }
  for (const s of await fsStore.readSeen()) {
    await q(
      `INSERT INTO seen_leads (place_id, name, address, phone, tier, niche, location, first_seen, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (place_id) DO NOTHING`,
      [s.place_id, s.name || '', s.address || '', s.phone || '', s.tier || '',
        s.niche || '', s.location || '', s.first_seen || '', s.status || ''],
    );
  }
  for (const o of await fsStore.readOutcomes()) {
    await q('INSERT INTO call_outcomes (at, place_id, status, note) VALUES ($1, $2, $3, $4)',
      [o.at, o.place_id, o.status, o.note || '']);
  }
  const map = await currentStatuses();
  await updateSeenStatus(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.status])));
  return { seeded: true, reason: `imported ${runs.length} run(s) from the repo's CSVs` };
}

export async function close() { await pool.end(); }
