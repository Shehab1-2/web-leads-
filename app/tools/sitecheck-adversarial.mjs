// Adversarial fixtures for app/lib/sitecheck.mjs.
//
// Real sites cannot be relied on to cover the edge cases, and they change under
// you. This stands up a local server that serves each nasty case deterministically
// and asserts what the checker makes of it.

import http from 'node:http';
const { checkSite, buildReason, scoreSignals } = await import(
  new URL('../lib/sitecheck.mjs', import.meta.url).href);

const YEAR = new Date().getFullYear();
const page = (body, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const REAL = '<nav><a href="/">Home</a> <a href="/services">Services</a> <a href="/contact">Contact</a></nav>' + '<h1>The Salon</h1><p>Walk-ins welcome. Open Tuesday to Saturday, 9am to 6pm. Find us at 12 High Street, and call ahead on 555-0100 if you want a specific stylist.</p>';
const MOBILE = '<meta name="viewport" content="width=device-width, initial-scale=1">';

// A page with no signals at all, used as the control.
const CLEAN = page(REAL + `<footer>Copyright &copy; ${YEAR} Salon</footer>`, MOBILE);

const ROUTES = {
  // --- copyright year parsing -------------------------------------------
  '/year-2013': page(REAL + `<footer>&copy; 2013 The Barber Shop</footer>`, MOBILE),
  '/year-range': page(REAL + `<footer>Copyright 2011-2019 Salon LLC</footer>`, MOBILE),
  '/year-current': page(REAL + `<footer>&copy; ${YEAR} Salon</footer>`, MOBILE),
  '/year-newest-wins': page(REAL + `<footer>Established 1998. Rebuilt 2009. Copyright &copy; ${YEAR}.</footer>`, MOBILE),
  // The trap: street numbers, phone numbers and zips must never read as years.
  '/address-digits': page(REAL + `<footer>1665 Stelton Rd # L, Piscataway, NJ 08854 · (732) 777-9212 · 1390 Centennial Ave</footer>`,
    MOBILE),
  // A copyright only written by JS is absent from the HTML — must not be a signal.
  '/year-js': page(REAL + `<footer id="c"></footer><script>document.getElementById("c").textContent="(c) 2012"</script>`,
    MOBILE),

  // --- reachability ------------------------------------------------------
  '/redirect-loop': null,   // handled below
  '/ua-gate': null,         // 403 to default UA, 200 to a browser UA
  '/ua-gate-always-403': null,
  '/parked': null,
  '/slow': null,

  // --- encoding ----------------------------------------------------------
  '/win1252': null,         // windows-1252 bytes, declared

  // --- control -----------------------------------------------------------
  '/clean': CLEAN,
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const ua = req.headers['user-agent'] || '';
  const browserish = /Mozilla\/5\.0 \(Windows|Macintosh|X11/.test(ua) && !/sitecheck/.test(ua);

  if (url === '/redirect-loop') {
    res.writeHead(302, { location: '/redirect-loop' }); return res.end();
  }
  if (url === '/ua-gate') {
    if (!browserish) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<h1>Forbidden</h1>'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page(REAL + `<footer>&copy; 2014 Gated</footer>`, ''));  // no viewport either
  }
  if (url === '/ua-gate-always-403') {
    res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<h1>Forbidden</h1>');
  }
  if (url === '/parked') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html><head><script>window.location="/lander"</script></head><body></body></html>');
  }
  if (url === '/slow') { return; } // never responds — must time out, not hang forever
  if (url === '/win1252') {
    res.writeHead(200, { 'content-type': 'text/html; charset=windows-1252' });
    // 0x92 is a curly apostrophe in cp1252 and invalid UTF-8.
    return res.end(Buffer.concat([
      Buffer.from(`<!doctype html><html><head><meta charset="windows-1252">${MOBILE}</head><body>${REAL}<p>Dina`, 'latin1'),
      Buffer.from([0x92]),
      Buffer.from(`s Salon</p><footer>&copy; ${YEAR}</footer></body></html>`, 'latin1'),
    ]));
  }
  const body = ROUTES[url];
  if (typeof body === 'string') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(body);
  }
  res.writeHead(404); res.end('nope');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const CASES = [
  ['/year-2013',        (c) => sig(c, 'stale_copyright') === true && c.footerYear === 2013, 'flags a 2013 footer'],
  ['/year-range',       (c) => sig(c, 'stale_copyright') === true && c.footerYear === 2019, 'takes the newest year in a range'],
  ['/year-current',     (c) => sig(c, 'stale_copyright') === false, 'current year is not stale'],
  ['/year-newest-wins', (c) => sig(c, 'stale_copyright') === false, 'newest year wins over old prose years'],
  ['/address-digits',   (c) => sig(c, 'stale_copyright') !== true && c.footerYear === null, 'street/phone/zip digits are not years'],
  ['/year-js',          (c) => sig(c, 'stale_copyright') !== true, 'JS-only copyright is not asserted'],
  ['/redirect-loop',    (c) => c.tier === 'dead_site' && !c.ok, 'redirect loop is dead, not a hang'],
  ['/ua-gate',          (c) => c.ok && c.retriedWithBrowserUa && c.tier !== 'dead_site', 'retries with a browser UA and succeeds'],
  ['/ua-gate-always-403', (c) => c.tier === 'dead_site', 'a real 403 after retry is dead'],
  ['/parked',           (c) => c.parked === true && c.tier === 'dead_site', 'parked page detected by body, not status'],
  ['/slow',             (c) => c.tier === 'dead_site' && /d+s|timed? ?out|no response/i.test(c.error || ''), 'times out cleanly'],
  ['/win1252',          (c) => c.ok && !/\uFFFD/.test(JSON.stringify(c.signals || [])), 'cp1252 does not produce replacement chars'],
    // Served over plain http from a local server, so no_https legitimately fires.
  // What matters is that NO content-derived signal does.
  ['/clean',            (c) => sig(c, 'no_https') === true
     && ['no_viewport', 'stale_copyright', 'broken_elements', 'untouched_template'].every((id) => sig(c, id) === false)
     && scoreSignals(c.signals).count === 1, 'a healthy page raises no content signals'],
];

const sig = (c, id) => (c.signals || []).find((s) => s.id === id)?.found;

let pass = 0; const fails = [];
for (const [route, assert, label] of CASES) {
  let c;
  try { c = await checkSite(BASE + route, { timeoutMs: 4000 }); }
  catch (e) { fails.push([route, label, 'threw: ' + e.message]); continue; }
  let good = false;
  try { good = assert(c); } catch (e) { good = false; }
  if (good) { pass++; console.log(`  ok    ${route.padEnd(22)} ${label}`); }
  else {
    fails.push([route, label,
      `tier=${c.tier} ok=${c.ok} year=${c.footerYear} parked=${c.parked} retried=${c.retriedWithBrowserUa} err=${c.error} stale=${sig(c, 'stale_copyright')}`]);
    console.log(`  FAIL  ${route.padEnd(22)} ${label}`);
  }
}

console.log(`\n=== ${pass}/${CASES.length} adversarial cases pass ===`);
for (const [r, l, why] of fails) console.log(`  FAIL ${r} (${l})\n       ${why}`);

// --- reason-line audit -------------------------------------------------
console.log('\n=== reason lines ===');
const BANNED = /\b(ugly|terrible|embarrass\w*|amateur|awful|horrible|bad|shoddy|cheap|hideous)\b/i;
const VISUAL = /\b(looks?|ugly|design era|dated design|cluttered|colou?rs?)\b/i;
const reasons = [];
for (const [route] of CASES) {
  try {
    const c = await checkSite(BASE + route, { timeoutMs: 4000 });
    const r = c.reason || '';
    reasons.push([route, r]);
    const problems = [];
    if (BANNED.test(r)) problems.push('INSULTING');
    // A visual claim is only legitimate if a visual signal was actually found,
    // and none ever are without a browser.
    if (VISUAL.test(r) && !(c.signals || []).some((s) => s.found === true && ['not_mobile_friendly', 'dated_design_era'].includes(s.id))) {
      problems.push('ASSERTS A VISUAL JUDGEMENT');
    }
    if (r && !/[.!]$/.test(r.trim())) problems.push('no terminal punctuation');
    if (r.length > 240) problems.push('too long for an opener');
    console.log(`  ${problems.length ? 'FAIL ' : 'ok   '} ${route.padEnd(22)} ${problems.join(', ') || ''}`);
    if (problems.length) console.log(`         "${r}"`);
  } catch { /* covered above */ }
}
console.log('\nsample reasons:');
reasons.slice(0, 6).forEach(([r, t]) => console.log(`  ${r}: ${t}`));

server.close();
process.exit(fails.length ? 1 : 0);
