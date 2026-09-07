// Everything that touches disk. One module so the file-safety rules that
// matter here live in exactly one place:
//
//   data/seen_leads.csv is call history and must never lose a row. It is only
//   ever appended to, or rewritten cell-by-cell through updateSeenStatus(),
//   which refuses to write unless every original place_id survives.
//
//   data/call_outcomes.csv is an append-only log and is the source of truth
//   for call outcomes. seen_leads.status is a mirror of it, so a bug in the
//   mirror can always be repaired from the log.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvObjects, toCsv } from './csv.mjs';

// fileURLToPath, not url.pathname — on Windows the latter yields "/C:/..." and
// leaves %20 in any path with a space in it.
export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
// Every path below hangs off DATA_DIR, so pointing it at a mounted volume is
// all it takes to outlive a redeploy on a host with an ephemeral disk. Unset,
// it is the repo's own data/ — which is what running this at a desk wants.
export const REPO_DATA_DIR = path.join(ROOT, 'data');
export const DATA_DIR = path.resolve((process.env.DATA_DIR || '').trim() || REPO_DATA_DIR);
export const RUNS_DIR = path.join(DATA_DIR, 'runs');
export const CHECKS_DIR = path.join(DATA_DIR, 'checks');
export const SEEN_PATH = path.join(DATA_DIR, 'seen_leads.csv');
export const OUTCOMES_PATH = path.join(DATA_DIR, 'call_outcomes.csv');

export const LEAD_COLUMNS = [
  'tier', 'name', 'phone', 'address', 'city', 'category',
  'website', 'rating', 'reviews', 'maps_url', 'place_id',
  'checked_tier', 'reason',
];

export const SEEN_COLUMNS = [
  'place_id', 'name', 'address', 'phone', 'tier',
  'niche', 'location', 'first_seen', 'status',
];

export const OUTCOME_COLUMNS = ['at', 'place_id', 'status', 'note'];

/** Valid call outcomes. `not_called` is the absence of a row, not a value. */
export const OUTCOMES = ['no_answer', 'call_back', 'not_interested', 'interested'];

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/** Write via a temp file in the same directory, then rename. */
async function writeAtomic(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, contents, 'utf8');
  await fs.rename(tmp, filePath);
}

async function readCsvObjects(filePath) {
  if (!(await exists(filePath))) return { header: [], rows: [] };
  return parseCsvObjects(await fs.readFile(filePath, 'utf8'));
}

/**
 * A freshly mounted volume is empty, and an empty DATA_DIR would hide the call
 * history the repo already carries — repeat searches would then re-surface
 * businesses already called. Copy the repo's data across once, on first boot
 * only. Anything already in DATA_DIR is left untouched, so this can never
 * overwrite history that has moved on.
 */
export async function seedDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (DATA_DIR === REPO_DATA_DIR) return { seeded: false, reason: 'using the repo directory' };
  if (await exists(SEEN_PATH)) return { seeded: false, reason: 'already has call history' };
  if (!(await exists(REPO_DATA_DIR))) return { seeded: false, reason: 'nothing to seed from' };
  await fs.cp(REPO_DATA_DIR, DATA_DIR, { recursive: true, force: false, errorOnExist: false });
  return { seeded: true, reason: `seeded from ${REPO_DATA_DIR}` };
}

// ---------------------------------------------------------------- runs

export function slugify(niche, location) {
  return `${niche}-${location}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export function runCsvPath(slug) { return path.join(DATA_DIR, `leads_${slug}.csv`); }
export function runJsonPath(slug) { return path.join(DATA_DIR, `leads_${slug}.json`); }
export function runMetaPath(slug) { return path.join(RUNS_DIR, `${slug}.json`); }
export function checksPath(slug) { return path.join(CHECKS_DIR, `${slug}.json`); }

/**
 * Run metadata. Runs made before this app existed have no metadata file, so
 * derive what we can from seen_leads (which stores niche/location/first_seen
 * per place_id) rather than inventing it.
 */
export async function readRunMeta(slug) {
  if (await exists(runMetaPath(slug))) {
    try { return JSON.parse(await fs.readFile(runMetaPath(slug), 'utf8')); } catch { /* fall through */ }
  }
  const { rows: leads } = await readCsvObjects(runCsvPath(slug));
  const seen = await readSeen();
  const byId = new Map(seen.map((s) => [s.place_id, s]));
  let niche = '', location = '', date = '';
  for (const l of leads) {
    const s = byId.get(l.place_id);
    if (s) { niche = niche || s.niche; location = location || s.location; date = date || s.first_seen; }
  }
  if (!date) {
    try { date = (await fs.stat(runCsvPath(slug))).mtime.toISOString().slice(0, 10); } catch { /* leave blank */ }
  }
  return { slug, niche, location, date, max: null, derived: true };
}

export async function listRuns() {
  if (!(await exists(DATA_DIR))) return [];
  const files = await fs.readdir(DATA_DIR);
  const slugs = files
    .filter((f) => f.startsWith('leads_') && f.endsWith('.csv'))
    .map((f) => f.slice('leads_'.length, -'.csv'.length));
  const runs = [];
  for (const slug of slugs) {
    const meta = await readRunMeta(slug);
    const { rows: leads } = await readCsvObjects(runCsvPath(slug));
    runs.push({ ...meta, slug, total: leads.length });
  }
  runs.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return runs;
}

export async function readRun(slug) {
  const { rows } = await readCsvObjects(runCsvPath(slug));
  const meta = await readRunMeta(slug);
  const checks = await readChecks(slug);
  const leads = rows.map((r) => ({
    ...r,
    rating: r.rating === '' ? null : Number(r.rating),
    reviews: r.reviews === '' ? null : Number(r.reviews),
    check: checks[r.place_id] || null,
  }));
  return { meta, leads };
}

/** Persist stage-1 results as the run's CSV + JSON, matching the existing layout. */
export async function writeRun(slug, meta, leads) {
  await writeAtomic(runCsvPath(slug), toCsv(LEAD_COLUMNS, leads));
  await writeAtomic(runJsonPath(slug), JSON.stringify(leads, null, 2) + '\n');
  await writeAtomic(runMetaPath(slug), JSON.stringify({ ...meta, slug }, null, 2) + '\n');
}

/**
 * Write stage-2 verdicts back into the run CSV as checked_tier + reason,
 * sorted strongest-first — the convention the call lists are worked from.
 */
export async function writeRunVerdicts(slug, verdictsByPlaceId) {
  const { rows } = await readCsvObjects(runCsvPath(slug));
  const updated = rows.map((r) => {
    const v = verdictsByPlaceId[r.place_id];
    return v ? { ...r, checked_tier: v.tier, reason: v.reason } : r;
  });
  const { rankLeads } = await import('./rank.mjs');
  await writeAtomic(runCsvPath(slug), toCsv(LEAD_COLUMNS, rankLeads(updated)));
  return updated.length;
}

/** Rewrite one run's CSV + JSON from a full row set, ranked. */
async function writeRunRows(slug, rows) {
  const { rankLeads } = await import('./rank.mjs');
  const ranked = rankLeads(rows);
  await writeAtomic(runCsvPath(slug), toCsv(LEAD_COLUMNS, ranked));
  await writeAtomic(runJsonPath(slug), JSON.stringify(ranked, null, 2) + '\n');
  return ranked;
}

/** Fields a manual edit may touch. Everything else is Maps data or a verdict. */
export const EDITABLE_FIELDS = ['name', 'phone', 'address', 'city', 'category', 'website', 'checked_tier', 'reason'];

export async function updateLead(slug, placeId, fields) {
  const { rows } = await readCsvObjects(runCsvPath(slug));
  const i = rows.findIndex((r) => r.place_id === placeId);
  if (i === -1) throw Object.assign(new Error(`no lead ${placeId} in run ${slug}`), { status: 404 });
  const patch = {};
  for (const k of EDITABLE_FIELDS) if (fields[k] !== undefined) patch[k] = String(fields[k]);
  rows[i] = { ...rows[i], ...patch };
  await writeRunRows(slug, rows);
  return rows[i];
}

/** Add a hand-entered lead to a run — a referral, a business spotted on foot. */
export async function addLead(slug, lead) {
  const { rows } = await readCsvObjects(runCsvPath(slug));
  if (rows.some((r) => r.place_id === lead.place_id)) {
    throw Object.assign(new Error('that lead is already in this run'), { status: 409 });
  }
  const row = {};
  for (const c of LEAD_COLUMNS) row[c] = lead[c] === undefined || lead[c] === null ? '' : String(lead[c]);
  rows.push(row);
  await writeRunRows(slug, rows);
  return row;
}

/**
 * Remove a lead from a run. The run is a working list, so this is allowed;
 * seen_leads is history and deliberately keeps its row — removing a business
 * from today's list must not make it resurface in next month's search.
 */
export async function removeLead(slug, placeId) {
  const { rows } = await readCsvObjects(runCsvPath(slug));
  const kept = rows.filter((r) => r.place_id !== placeId);
  if (kept.length === rows.length) {
    throw Object.assign(new Error(`no lead ${placeId} in run ${slug}`), { status: 404 });
  }
  await writeRunRows(slug, kept);
  return rows.length - kept.length;
}

/**
 * Delete a whole run — its list, metadata and check details. seen_leads and
 * the outcomes log are untouched: the businesses were still seen, the calls
 * were still made.
 */
export async function deleteRun(slug) {
  for (const p of [runCsvPath(slug), runJsonPath(slug), runMetaPath(slug), checksPath(slug)]) {
    try { await fs.rm(p); } catch { /* absent is fine */ }
  }
}

export async function readChecks(slug) {
  if (!(await exists(checksPath(slug)))) return {};
  try { return JSON.parse(await fs.readFile(checksPath(slug), 'utf8')); } catch { return {}; }
}

export async function writeChecks(slug, checksByPlaceId) {
  await writeAtomic(checksPath(slug), JSON.stringify(checksByPlaceId, null, 2) + '\n');
}

// ------------------------------------------------------------ seen_leads

export async function readSeen() {
  const { rows } = await readCsvObjects(SEEN_PATH);
  return rows;
}

export async function appendSeen(leads, niche, location, date) {
  const isNew = !(await exists(SEEN_PATH));
  const day = date || new Date().toISOString().slice(0, 10);
  const lines = [];
  if (isNew) lines.push(SEEN_COLUMNS.join(','));
  const { escapeCell } = await import('./csv.mjs');
  for (const l of leads) {
    lines.push(SEEN_COLUMNS.map((c) => escapeCell(
      c === 'niche' ? niche
        : c === 'location' ? location
        : c === 'first_seen' ? day
        : c === 'status' ? ''
        : l[c],
    )).join(','));
  }
  await fs.mkdir(path.dirname(SEEN_PATH), { recursive: true });
  await fs.appendFile(SEEN_PATH, lines.join('\n') + '\n', 'utf8');
}

/**
 * Mirror the outcomes log into seen_leads' status column.
 *
 * seen_leads is call history: this refuses to write unless every place_id in
 * the file on disk is still present in what is about to replace it. A status
 * update must never be able to drop a row.
 */
export async function updateSeenStatus(statusByPlaceId) {
  const { header, rows } = await readCsvObjects(SEEN_PATH);
  if (!rows.length) return 0;
  const before = rows.map((r) => r.place_id);
  const updated = rows.map((r) => {
    const s = statusByPlaceId[r.place_id];
    return s === undefined ? r : { ...r, status: s };
  });
  const after = new Set(updated.map((r) => r.place_id));
  const lost = before.filter((id) => !after.has(id));
  if (lost.length || updated.length !== rows.length) {
    throw new Error(`refusing to rewrite seen_leads.csv: ${lost.length} row(s) would be lost`);
  }
  const columns = header.length ? header : SEEN_COLUMNS;
  await writeAtomic(SEEN_PATH, toCsv(columns, updated));
  return updated.length;
}

// -------------------------------------------------------------- outcomes

export async function readOutcomes() {
  const { rows } = await readCsvObjects(OUTCOMES_PATH);
  return rows;
}

export async function appendOutcome({ place_id, status, note = '', at }) {
  if (!place_id) throw new Error('place_id is required');
  if (!OUTCOMES.includes(status)) throw new Error(`unknown outcome: ${status}`);
  const isNew = !(await exists(OUTCOMES_PATH));
  const { escapeCell } = await import('./csv.mjs');
  const row = [at || new Date().toISOString(), place_id, status, note];
  const line = row.map(escapeCell).join(',');
  await fs.mkdir(path.dirname(OUTCOMES_PATH), { recursive: true });
  await fs.appendFile(OUTCOMES_PATH, (isNew ? OUTCOME_COLUMNS.join(',') + '\n' : '') + line + '\n', 'utf8');
  const map = await currentStatuses();
  await updateSeenStatus(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.status])));
  return map[place_id];
}

/** Latest outcome per business. The log is append-only, so last row wins. */
export async function currentStatuses() {
  const rows = await readOutcomes();
  const map = {};
  for (const r of rows) {
    if (!r.place_id) continue;
    map[r.place_id] = { status: r.status, note: r.note || '', at: r.at };
  }
  return map;
}
