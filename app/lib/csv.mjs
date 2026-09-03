// RFC 4180 CSV, with the quirks the pipeline actually produces:
// quoted fields containing commas (addresses), doubled quotes, CRLF or LF.
// Written by hand rather than pulled from npm so the app stays dependency-free
// and can be run with nothing but `node`.

export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  // Strip a UTF-8 BOM; Excel adds one and it would otherwise land in the
  // first header name and break every lookup by column name.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  // A trailing newline leaves an empty pending field; only keep a final row
  // if there is actually something in it.
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Parse into objects keyed by the header row. Missing cells become ''. */
export function parseCsvObjects(text) {
  const rows = parseCsv(text).filter((r) => r.length > 1 || (r[0] ?? '') !== '');
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0];
  const out = rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i] ?? ''; });
    return o;
  });
  return { header, rows: out };
}

export function escapeCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header, objects) {
  const lines = [header.map(escapeCell).join(',')];
  for (const o of objects) lines.push(header.map((h) => escapeCell(o[h])).join(','));
  return lines.join('\n') + '\n';
}
