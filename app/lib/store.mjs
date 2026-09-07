// Which store the app talks to.
//
// DATABASE_URL set  -> Postgres (store-pg.mjs). What a deployment uses: the
//                      container's disk is wiped on every redeploy, and call
//                      history cannot live somewhere that forgetful.
// DATABASE_URL unset -> CSV files under data/ (store-fs.mjs). What a desk uses:
//                      no database to install, and the run CSVs stay the thing
//                      you can open in a spreadsheet while calling.
//
// Both implement the same surface, so nothing above this line knows which is
// in play. The pg driver is imported dynamically so a local run never loads it.

const USE_PG = Boolean((process.env.DATABASE_URL || '').trim());

const backend = USE_PG
  ? await import('./store-pg.mjs')
  : await import('./store-fs.mjs');

export const BACKEND = USE_PG ? 'postgres' : 'csv';

export const {
  // shape
  ROOT, DATA_DIR, REPO_DATA_DIR,
  LEAD_COLUMNS, SEEN_COLUMNS, OUTCOME_COLUMNS, OUTCOMES, EDITABLE_FIELDS,
  slugify,
  // runs
  readRunMeta, listRuns, readRun, writeRun, writeRunVerdicts, deleteRun,
  // leads
  addLead, updateLead, removeLead,
  // checks
  readChecks, writeChecks,
  // the full Apify record per lead
  readDetails, writeDetails,
  // history
  readSeen, appendSeen, updateSeenStatus,
  readOutcomes, appendOutcome, currentStatuses,
  // lifecycle
  seedDataDir,
} = backend;

/** Only the CSV backend has files; the export route falls back to building one. */
export const runCsvPath = backend.runCsvPath || null;
