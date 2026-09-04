// Reset the data directory and load realistic demo data.
//
//   node app/tools/seed-demo.mjs --force
//
// Every phone number is in the reserved-for-fiction (XXX) 555-01xx range and
// every place_id carries a Demo marker — none of it can be dialed for real.
//
// DESTRUCTIVE: wipes data/ (runs, checks, seen_leads, outcomes) and rebuilds
// it with two believable searches, stage-2 verdicts, and a few logged calls,
// so every screen has something real-looking to show without an Apify token.
// It writes through app/lib/store.mjs, so the files come out byte-compatible
// with what a live search produces.

import { promises as fs } from 'node:fs';
import * as store from '../lib/store.mjs';
import { rankLeads } from '../lib/rank.mjs';

if (!process.argv.includes('--force')) {
  console.error('This wipes the data directory. Run with --force if you mean it.');
  process.exit(1);
}

const maps = (name, id) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${id}`;

const lead = (tier, name, phone, address, category, website, rating, reviews, place_id, checked_tier = '', reason = '') => ({
  tier, name, phone, address,
  city: address.split(',')[1]?.trim() || '',
  category, website, rating, reviews,
  maps_url: maps(name, place_id), place_id, checked_tier,
  reason: reason || (tier === 'no_website' ? 'No website listed on Google Maps at all.'
    : tier === 'social_only' ? 'The only web presence Google lists is a social page, not a site of their own.'
    : tier === 'free_host' ? "Site sits on a free subdomain, with the host's branding in their address."
    : ''),
});

// --------------------------------------------------- run 1: plumbers, today

const PLUMBERS = [
  lead('no_website', 'Rivera & Sons Plumbing', '(732) 555-0100', '311 Suydam St, New Brunswick, NJ 08901', 'Plumber', '', 4.8, 214, 'ChIJd8Zl1kTGw4kRDemoPlumb001'),
  lead('no_website', 'Drain Right Sewer Service', '(732) 555-0101', '78 Jersey Ave, New Brunswick, NJ 08901', 'Plumber', '', 4.6, 158, 'ChIJq2Xw3kTGw4kRDemoPlumb002'),
  lead('no_website', 'Kowalski Plumbing & Heating', '(732) 555-0102', '452 Livingston Ave, New Brunswick, NJ 08901', 'Plumber', '', 4.9, 97, 'ChIJk9Yp7mTGw4kRDemoPlumb003'),
  lead('needs_check', 'Garden State Drain Pros', '(732) 555-0103', '1120 Livingston Ave, North Brunswick, NJ 08902', 'Plumber', 'http://www.gardenstatedrainpros.com', 4.7, 132, 'ChIJt5Rn2pTGw4kRDemoPlumb004',
    'dead_site', 'Their domain no longer resolves - the site Google links to is unreachable in any browser.'),
  lead('social_only', "Marcelo's Plumbing LLC", '(848) 555-0104', '19 Remsen Ave, New Brunswick, NJ 08901', 'Plumber', 'https://www.facebook.com/marcelosplumbingnj', 4.5, 88, 'ChIJb3Fm8qTGw4kRDemoPlumb005'),
  lead('social_only', 'Hub City Rooter', '(732) 555-0105', '287 Handy St, New Brunswick, NJ 08901', 'Drainage service', 'https://www.instagram.com/hubcityrooter', 4.3, 61, 'ChIJn7Qs4rTGw4kRDemoPlumb006'),
  lead('free_host', 'AquaFlow Plumbing Services', '(732) 555-0106', '640 Somerset St, New Brunswick, NJ 08901', 'Plumber', 'https://aquaflownj.wixsite.com/home', 4.4, 53, 'ChIJv1Wt6sTGw4kRDemoPlumb007'),
  lead('needs_check', 'Bianchi Bros Plumbing', '(732) 555-0107', '95 Church St, New Brunswick, NJ 08901', 'Plumber', 'http://www.bianchibrosplumbing.com', 4.6, 176, 'ChIJx4Hu8tTGw4kRDemoPlumb008',
    'very_dated', 'No mobile version (no viewport tag in the page source), still on http so Chrome shows "Not secure" to every visitor, and the footer copyright still reads 2014.'),
  lead('needs_check', 'Raritan Valley Mechanical', '(908) 555-0108', '2101 Woodbridge Ave, Edison, NJ 08817', 'Plumber', 'https://www.raritanvalleymechanical.com', 4.2, 84, 'ChIJz6Jv0uTGw4kRDemoPlumb009',
    'somewhat_dated', "The footer copyright still reads 2019 and the news page's newest entry is from the same year."),
  lead('needs_check', 'ProFlow Plumbing & Drain', '(732) 555-0109', '1543 Route 27, Somerset, NJ 08873', 'Plumber', 'https://www.proflowplumbingnj.com', 4.7, 203, 'ChIJa8Kw2vTGw4kRDemoPlumb010',
    'not_a_lead', 'Modern responsive site on HTTPS, current copyright, online booking - nothing to pitch.'),
  lead('needs_check', 'Milltown Plumbing Supply & Service', '(732) 555-0110', '410 Ryders Ln, Milltown, NJ 08850', 'Plumber', 'https://www.milltownplumbing.com', 4.5, 149, 'ChIJc0Lx4wTGw4kRDemoPlumb011',
    'somewhat_dated', 'Mobile version exists but half the photos are broken links, and the specials page was last updated in 2021.'),
  lead('needs_check', 'Reyes Sewer & Water Main', '(848) 555-0111', '52 Throop Ave, New Brunswick, NJ 08901', 'Plumber', 'https://www.reyessewernj.com', 4.8, 118, 'ChIJe2My6xTGw4kRDemoPlumb012',
    'not_a_lead', 'Recent responsive build with live chat and this year in the footer - healthy.'),
];

// Per-signal detail behind the stage-2 verdicts above, for the sitecheck view.
const sig = (id, label, found, evidence) => ({ id, label, found, evidence });
const PLUMBER_CHECKS = {
  ChIJt5Rn2pTGw4kRDemoPlumb004: {
    url: 'http://www.gardenstatedrainpros.com', finalUrl: 'http://www.gardenstatedrainpros.com', ok: false,
    tier: 'dead_site', reason: 'Their domain no longer resolves - the site Google links to is unreachable in any browser.',
    signals: [sig('dead', 'Unreachable', true, 'DNS lookup fails: NXDOMAIN. No server answers for this domain.')],
  },
  ChIJx4Hu8tTGw4kRDemoPlumb008: {
    url: 'http://www.bianchibrosplumbing.com', finalUrl: 'http://www.bianchibrosplumbing.com/', ok: true,
    tier: 'very_dated', reason: 'No mobile version (no viewport tag in the page source), still on http so Chrome shows "Not secure" to every visitor, and the footer copyright still reads 2014.',
    signals: [
      sig('no_https', 'No HTTPS', true, 'Serves over http:// only, so Chrome flags every visit as Not secure.'),
      sig('no_viewport', 'No viewport meta tag', true, 'No viewport meta in the page source - the desktop layout is served to phones.'),
      sig('stale_year', 'Stale copyright year', true, 'Footer reads "(c) 2014 Bianchi Bros Plumbing".'),
    ],
  },
  ChIJz6Jv0uTGw4kRDemoPlumb009: {
    url: 'https://www.raritanvalleymechanical.com', finalUrl: 'https://www.raritanvalleymechanical.com/', ok: true,
    tier: 'somewhat_dated', reason: "The footer copyright still reads 2019 and the news page's newest entry is from the same year.",
    signals: [
      sig('no_https', 'No HTTPS', false, 'Valid certificate, redirects http to https.'),
      sig('no_viewport', 'No viewport meta tag', false, 'Viewport tag present.'),
      sig('stale_year', 'Stale copyright year', true, 'Footer reads "(c) 2019". Newest dated content is from 2019 too.'),
    ],
  },
  ChIJa8Kw2vTGw4kRDemoPlumb010: {
    url: 'https://www.proflowplumbingnj.com', finalUrl: 'https://www.proflowplumbingnj.com/', ok: true,
    tier: 'not_a_lead', reason: 'Modern responsive site on HTTPS, current copyright, online booking - nothing to pitch.',
    signals: [
      sig('no_https', 'No HTTPS', false, 'Valid certificate.'),
      sig('no_viewport', 'No viewport meta tag', false, 'Viewport tag present.'),
      sig('stale_year', 'Stale copyright year', false, 'Footer shows the current year.'),
    ],
  },
  ChIJc0Lx4wTGw4kRDemoPlumb011: {
    url: 'https://www.milltownplumbing.com', finalUrl: 'https://www.milltownplumbing.com/', ok: true,
    tier: 'somewhat_dated', reason: 'Mobile version exists but half the photos are broken links, and the specials page was last updated in 2021.',
    signals: [
      sig('no_https', 'No HTTPS', false, 'Valid certificate.'),
      sig('stale_year', 'Stale content', true, 'Specials page banner is dated 2021; footer year is current (likely scripted).'),
      sig('broken_assets', 'Broken images', true, '6 of 14 gallery images return 404.'),
    ],
  },
  ChIJe2My6xTGw4kRDemoPlumb012: {
    url: 'https://www.reyessewernj.com', finalUrl: 'https://www.reyessewernj.com/', ok: true,
    tier: 'not_a_lead', reason: 'Recent responsive build with live chat and this year in the footer - healthy.',
    signals: [
      sig('no_https', 'No HTTPS', false, 'Valid certificate.'),
      sig('no_viewport', 'No viewport meta tag', false, 'Viewport tag present.'),
      sig('stale_year', 'Stale copyright year', false, 'Footer shows the current year.'),
    ],
  },
};

// ------------------------------------------- run 2: roofers, a week earlier

const ROOFERS = [
  lead('no_website', 'Menlo Park Roofing Co', '(732) 555-0112', '244 Amboy Ave, Edison, NJ 08837', 'Roofing contractor', '', 4.7, 143, 'ChIJf4Nz8yTGw4kRDemoRoofr001'),
  lead('no_website', 'Oak Tree Gutter & Roof', '(732) 555-0113', '1656 Oak Tree Rd, Edison, NJ 08820', 'Roofing contractor', '', 4.4, 76, 'ChIJh6P08zTGw4kRDemoRoofr002'),
  lead('social_only', 'DiStefano Roofing', '(908) 555-0114', '907 Inman Ave, Edison, NJ 08820', 'Roofing contractor', 'https://www.facebook.com/distefanoroofingnj', 4.6, 92, 'ChIJj8Q19aTGw4kRDemoRoofr003'),
  lead('needs_check', 'Raritan Roofing & Siding', '(732) 555-0115', '55 National Rd, Edison, NJ 08817', 'Roofing contractor', 'http://www.raritanroofing.com', 4.3, 118, 'ChIJl0R21bTGw4kRDemoRoofr004',
    'very_dated', 'Still on http so Chrome shows "Not secure" to every visitor, and the site is a table-based layout with the footer reading 2011.'),
  lead('free_host', 'Skyline Exteriors NJ', '(732) 555-0116', '21 Parsonage Rd, Edison, NJ 08837', 'Roofing contractor', 'https://skylineexteriorsnj.weebly.com', 4.5, 39, 'ChIJn2S43cTGw4kRDemoRoofr005'),
  lead('needs_check', 'Middlesex Roof Masters', '(732) 555-0117', '3120 Woodbridge Ave, Edison, NJ 08837', 'Roofing contractor', 'https://www.middlesexroofmasters.com', 4.8, 167, 'ChIJp4T65dTGw4kRDemoRoofr006',
    'not_a_lead', 'Responsive site on HTTPS with current-year footer and a live estimate form - healthy.'),
];

const ROOFER_CHECKS = {
  ChIJl0R21bTGw4kRDemoRoofr004: {
    url: 'http://www.raritanroofing.com', finalUrl: 'http://www.raritanroofing.com/', ok: true,
    tier: 'very_dated', reason: 'Still on http so Chrome shows "Not secure" to every visitor, and the site is a table-based layout with the footer reading 2011.',
    signals: [
      sig('no_https', 'No HTTPS', true, 'Serves over http:// only.'),
      sig('no_viewport', 'No viewport meta tag', true, 'Table-based layout, no viewport tag.'),
      sig('stale_year', 'Stale copyright year', true, 'Footer reads "(c) 2011 Raritan Roofing".'),
    ],
  },
  ChIJp4T65dTGw4kRDemoRoofr006: {
    url: 'https://www.middlesexroofmasters.com', finalUrl: 'https://www.middlesexroofmasters.com/', ok: true,
    tier: 'not_a_lead', reason: 'Responsive site on HTTPS with current-year footer and a live estimate form - healthy.',
    signals: [sig('no_https', 'No HTTPS', false, 'Valid certificate.'), sig('stale_year', 'Stale copyright year', false, 'Current year.')],
  },
};

// ------------------------------------------------------------------- write

const today = new Date().toISOString().slice(0, 10);
const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

console.log(`wiping ${store.DATA_DIR}`);
await fs.rm(store.DATA_DIR, { recursive: true, force: true });
await fs.mkdir(store.DATA_DIR, { recursive: true });

async function writeDemoRun(niche, location, date, leads, checks) {
  const slug = store.slugify(niche, location);
  const ranked = rankLeads(leads);
  await store.writeRun(slug, { niche, location, date, max: leads.length, cost: leads.length * 0.0015 }, ranked);
  const full = {};
  for (const [id, c] of Object.entries(checks)) full[id] = { place_id: id, ...c };
  await store.writeChecks(slug, full);
  await store.appendSeen(ranked, niche, location, date);
  console.log(`  ${slug}: ${leads.length} businesses, ${Object.keys(checks).length} site checks`);
  return slug;
}

// Older run first so appendSeen order reads chronologically.
await writeDemoRun('roofing contractors', 'Edison, NJ', weekAgo, ROOFERS, ROOFER_CHECKS);
await writeDemoRun('plumbers', 'New Brunswick, NJ', today, PLUMBERS, PLUMBER_CHECKS);

// A few realistic call outcomes so history and the dashboard have shape.
const days = (n) => new Date(Date.now() - n * 864e5).toISOString();
const CALLS = [
  ['ChIJf4Nz8yTGw4kRDemoRoofr001', 'interested', 'Owner picked up - wants a quote for a 5-page site, call back Thursday.', days(6)],
  ['ChIJh6P08zTGw4kRDemoRoofr002', 'no_answer', 'Rang out twice, no voicemail set up.', days(6)],
  ['ChIJj8Q19aTGw4kRDemoRoofr003', 'call_back', 'Spoke to the office - owner in after 3pm.', days(5)],
  ['ChIJl0R21bTGw4kRDemoRoofr004', 'not_interested', 'Says his nephew handles the website.', days(5)],
  ['ChIJd8Zl1kTGw4kRDemoPlumb001', 'no_answer', '', days(0)],
];
for (const [place_id, status, note, at] of CALLS) {
  await store.appendOutcome({ place_id, status, note, at });
}
console.log(`  logged ${CALLS.length} call outcomes`);
console.log('done - start the server and the app is fully populated.');
