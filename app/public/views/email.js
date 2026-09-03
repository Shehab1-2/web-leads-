// Cold email — the follow-up channel, and the honest limit on it.
// Layout follows design/Email.dc.html.
//
// Google Maps never returns an email address, so an address can only come off
// the business's own site. That means the strongest leads in the ranking — the
// ones with no site at all — are exactly the ones email cannot reach, and this
// screen leads with that rather than quietly showing a shorter list.
//
// Every value that is not on disk stays a bracketed placeholder. The draft is
// built by app/lib/email.mjs from the lead's own verified reason line; nothing
// here writes a sentence about a site nobody looked at.

import { h, clear, icon, prettyHost } from '../dom.js';

export const meta = { title: 'Cold email' };

// Mirrors TIER_ORDER / TIER_LABEL in app/lib/rank.mjs — the lib/ modules are
// node-side and are not served to the browser.
const TIER_ORDER = ['no_website', 'dead_site', 'social_only', 'free_host', 'very_dated', 'somewhat_dated'];
const TIER_LABEL = {
  no_website: 'No website',
  dead_site: 'Dead site',
  social_only: 'Social only',
  free_host: 'Free host',
  very_dated: 'Very dated',
  somewhat_dated: 'Somewhat dated',
  needs_check: 'Needs checking',
  not_a_lead: 'Healthy site',
};

// Mirrors BUCKETS in app/lib/email.mjs, with the wording from the artboard.
// The server's own labels win when it sends them.
const BUCKET_FALLBACK = [
  { id: 'emailable', label: 'Emailable', channel: 'email', note: 'Working site of their own — an address may be on the page' },
  { id: 'deadDomain', label: 'Phone only', channel: 'phone', note: 'Domain is parked or will not load — no mail behind it' },
  { id: 'socialOnly', label: 'Phone only', channel: 'phone', note: 'Profile or booking page on someone else’s domain' },
  { id: 'noWebsite', label: 'Phone only', channel: 'phone', note: 'No website at all — nothing to read an address off' },
];

// Mirrors EMAIL_REACH_NOTE in app/lib/email.mjs. Only used if the server does
// not send its own copy, so the two can never drift apart on screen.
const REACH_NOTE =
  'Google Maps does not hand back email addresses — they come off the site itself. Which means the strongest leads on '
  + 'the list, the ones with no site at all, are exactly the ones email cannot reach. Email is the follow-up channel '
  + 'here, not the main one.';

const STEPS = [
  { n: 2, title: 'Day 3 — one-line bump' },
  { n: 3, title: 'Day 8 — last one, then stop' },
];

let session = null;

export function destroy() {
  if (session) session.dead = true;
  session = null;
}

// ----------------------------------------------------------------- utils

const effectiveTier = (lead) => lead.checked_tier || lead.tier || '';
const tierRank = (t) => {
  const i = TIER_ORDER.indexOf(t);
  return i === -1 ? TIER_ORDER.length + 1 : i;
};

function rank(leads) {
  return [...leads].sort((a, b) => {
    const d = tierRank(effectiveTier(a)) - tierRank(effectiveTier(b));
    if (d !== 0) return d;
    return (Number(b.reviews) || 0) - (Number(a.reviews) || 0);
  });
}

function msgOf(err) { return String(err && err.message ? err.message : err); }

function sentence(s) {
  const t = String(s || '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

function hostOf(url) {
  if (!url) return '';
  try {
    return new URL(String(url).includes('//') ? url : `http://${url}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch { return ''; }
}

/** The step-1 draft for one lead, however the server keys them. */
function draftFor(drafts, lead) {
  if (!drafts || !lead) return null;
  let d = null;
  if (Array.isArray(drafts)) {
    d = drafts.find((x) => x && (x.place_id === lead.place_id || x.placeId === lead.place_id)) || null;
  } else if (typeof drafts === 'object') {
    d = drafts[lead.place_id] || null;
  }
  if (!d) return null;
  const draft = d.draft && typeof d.draft === 'object' ? d.draft : d;
  if (typeof draft.subject !== 'string' && typeof draft.body !== 'string') return null;
  return { subject: draft.subject || '', body: draft.body || '' };
}

/** Split a drafted body into the message and the legal footer under `--`. */
function splitBody(body) {
  const lines = String(body || '').split('\n');
  const cut = lines.findIndex((l) => l.trim() === '--');
  if (cut === -1) return { message: lines, footer: [] };
  return { message: lines.slice(0, cut), footer: lines.slice(cut + 1) };
}

/** Consecutive non-blank lines become one paragraph, blank lines separate. */
function paragraphs(lines) {
  const out = [];
  let block = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (block.length) { out.push(block); block = []; }
    } else block.push(line);
  }
  if (block.length) out.push(block);
  return out;
}

// ---------------------------------------------------------------- render

export async function render(root, ctx) {
  const s = { dead: false, scanning: false };
  session = s;
  clear(root);

  root.appendChild(h('div', { class: 'eyebrow', text: 'web-leads  /  cold email' }));
  const headSlot = h('div', {});
  const bodySlot = h('div', { style: { marginTop: '44px' } });
  root.appendChild(headSlot);
  root.appendChild(bodySlot);

  headSlot.appendChild(h('div', { class: 'head-row' },
    h('div', {},
      h('h1', { class: 'title', text: 'Cold email' }),
      h('p', {
        class: 'subtitle',
        style: { maxWidth: '640px' },
        text: 'For the leads a phone call will not reach. The reason line becomes the first sentence of the email, so '
          + 'the pitch stays specific.',
      })),
    instantlyChip(ctx)));
  bodySlot.appendChild(loadingBlock());

  let data;
  try {
    data = await ctx.api.email(ctx.slug);
  } catch (err) {
    if (s.dead) return;
    clear(bodySlot);
    bodySlot.appendChild(errorBlock(err, () => render(root, ctx)));
    return;
  }
  if (s.dead) return;

  clear(bodySlot);
  bodySlot.appendChild(screen(data, ctx, s));
}

// ---------------------------------------------------------------- screen

function screen(data, ctx, s) {
  const slug = ctx.slug;
  const reach = data.emailability || {};
  const drafts = data.drafts || null;

  // Anything a previous scan already found, if the server keeps it. Empty is
  // the normal state — nothing is filled in on its own.
  const addresses = (data.addresses && typeof data.addresses === 'object') ? { ...data.addresses } : {};

  const bucketList = (Array.isArray(reach.buckets) && reach.buckets.length)
    ? reach.buckets
    : BUCKET_FALLBACK.map((b) => ({ ...b, count: Array.isArray(reach[b.id]) ? reach[b.id].length : 0 }));

  const emailable = rank(Array.isArray(reach.emailable) ? reach.emailable : []);
  const total = bucketList.reduce((n, b) => n + (Number(b.count) || 0), 0);

  const wrap = h('div', { style: { display: 'flex', gap: '72px', flexWrap: 'wrap', alignItems: 'flex-start' } });
  const left = h('div', { style: { flex: '1', minWidth: '380px' } });
  const right = h('div', { style: { width: '340px', flexShrink: '0' } });
  wrap.appendChild(left);
  wrap.appendChild(right);

  // ------------------------------------------------- who email can reach
  left.appendChild(h('div', { class: 'eyebrow', text: 'Who email can even reach' }));

  if (!total) {
    left.appendChild(h('div', { class: 'empty', style: { marginTop: '16px' } },
      icon('list', { size: 22, stroke: '#bcb2a0', width: 1.7 }),
      h('div', { class: 'empty__title', text: 'This run has no leads in it' }),
      h('p', {
        class: 'empty__body',
        style: { maxWidth: '440px', margin: '7px auto 0' },
        text: 'Nothing has reached a lead tier yet, so there is nobody to write to. Check the sites first — the call '
          + 'list fills in at the same time.',
      })));
  } else {
    const rowsEl = h('div', { style: { marginTop: '16px' } });
    bucketList.forEach((b, i) => rowsEl.appendChild(bucketRow(b, i === bucketList.length - 1)));
    left.appendChild(rowsEl);
  }

  left.appendChild(h('p', {
    style: { marginTop: '16px', fontSize: '13px', lineHeight: '1.65', color: 'var(--ink-3)', maxWidth: '620px' },
    text: typeof reach.note === 'string' && reach.note.trim() ? reach.note : REACH_NOTE,
  }));

  if (Array.isArray(reach.excluded) && reach.excluded.length) {
    left.appendChild(h('p', {
      style: { marginTop: '10px', fontSize: '12.5px', lineHeight: '1.6', color: 'var(--ink-4)', maxWidth: '620px' },
      text: `${reach.excluded.length} healthy ${reach.excluded.length === 1 ? 'site is' : 'sites are'} not counted above `
        + '— they were dropped from the call list, so they are dropped from here too.',
    }));
  }

  // -------------------------------------------------------- the scan list
  const scanCaption = h('span', { style: { fontSize: '12.5px', color: 'var(--ink-3)' } });
  left.appendChild(h('div', {
    style: {
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      gap: '24px', marginTop: '40px', flexWrap: 'wrap',
    },
  },
    h('div', {
      class: 'eyebrow',
      text: emailable.length
        ? `The ${emailable.length === 1 ? 'one' : emailable.length} with a site`
        : 'Nobody here has a site of their own',
    }),
    scanCaption));

  const listEl = h('div', { style: { marginTop: '16px' } });
  left.appendChild(listEl);

  const actionRow = h('div', {
    style: { display: 'flex', alignItems: 'center', gap: '16px', marginTop: '20px', flexWrap: 'wrap' },
  });
  left.appendChild(actionRow);

  const barFill = h('div', { class: 'bar__fill', style: { width: '0%' } });
  const progress = h('div', {
    class: 'bar',
    style: { width: '320px', maxWidth: '100%', marginTop: '14px', display: 'none' },
  }, barFill);
  left.appendChild(progress);

  const logBox = h('div', { class: 'log', style: { marginTop: '12px', maxHeight: '200px' } });
  const logWrap = h('div', { style: { marginTop: '20px', display: 'none' } },
    h('div', { class: 'eyebrow', text: 'Scan log' }), logBox);
  left.appendChild(logWrap);

  // ------------------------------------------------------------ sequence
  left.appendChild(h('div', { class: 'eyebrow', style: { marginTop: '44px' }, text: 'Sequence' }));
  const stepSlot = h('div', { style: { marginTop: '16px' } });
  left.appendChild(stepSlot);
  for (const step of STEPS) left.appendChild(laterStep(step));

  // ---------------------------------------------------------- right rail
  const pushHint = h('p', { class: 'hint', style: { marginTop: '10px', lineHeight: '1.6' } });
  const pushBtn = h('button', {
    type: 'button',
    class: 'btn btn--dark',
    style: { marginTop: '16px', width: '100%' },
    disabled: true,
  }, icon('mail', { size: 15, stroke: '#faf7f1', width: 1.9 }), h('span', { text: 'Add leads to the campaign' }));

  right.appendChild(h('div', { class: 'eyebrow', text: 'Campaign' }));
  right.appendChild(campaignCard(ctx, pushBtn, pushHint));

  right.appendChild(h('div', { class: 'eyebrow', style: { marginTop: '30px' }, text: 'Results' }));
  right.appendChild(h('div', { class: 'empty', style: { marginTop: '14px' } },
    icon('mail', { size: 26, stroke: '#bcb2a0', width: 1.5 }),
    h('div', { class: 'empty__title', text: 'Nothing sent yet' }),
    h('p', { class: 'empty__body', text: 'Sent, opened and replied counts appear here once the campaign starts.' })));

  right.appendChild(h('div', { class: 'panel', style: { marginTop: '24px' } },
    h('p', { style: { fontSize: '12.5px', lineHeight: '1.65', color: '#6b6558' } },
      'Replies land in Instantly’s inbox, not here. When one comes in, mark the lead ',
      h('span', { style: { fontWeight: '600' }, text: 'Interested' }),
      ' on the call list so both halves stay in step.')));

  right.appendChild(h('div', { class: 'note', style: { marginTop: '24px' } },
    h('div', { class: 'note__title' },
      icon('alert', { size: 14, stroke: '#8a4a24', width: 2 }),
      h('span', { text: 'Before the first send' })),
    h('p', {
      class: 'note__body',
      text: 'A real postal address and a working unsubscribe link are on every step. Fill both in — they are what keeps '
        + 'the sending domain alive.',
    })));

  // ------------------------------------------------------------- state
  let selected = emailable[0] || null;
  const rowRefs = new Map();

  function scannedCount() {
    return emailable.filter((l) => addresses[l.place_id]).length;
  }
  function foundCount() {
    return emailable.filter((l) => (addresses[l.place_id]?.emails || []).length).length;
  }

  function paintCaption() {
    const scanned = scannedCount();
    if (!emailable.length) { scanCaption.textContent = ''; return; }
    if (s.scanning) { scanCaption.textContent = 'Reading the sites now…'; return; }
    scanCaption.textContent = scanned
      ? `${foundCount()} of ${scanned} scanned published an address`
      : 'Addresses have not been looked for yet';
  }

  function paintList() {
    clear(listEl);
    rowRefs.clear();
    if (!emailable.length) {
      listEl.appendChild(h('div', { class: 'empty' },
        icon('eyeOff', { size: 22, stroke: '#bcb2a0', width: 1.7 }),
        h('div', { class: 'empty__title', text: 'No site to read an address off' }),
        h('p', {
          class: 'empty__body',
          style: { maxWidth: '440px', margin: '7px auto 0' },
          text: total
            ? 'Every lead in this run is phone-only — no site listed, a domain that will not load, or a page on '
              + 'someone else’s platform. The call list is the whole channel here.'
            : 'There is nothing in this run to scan.',
        })));
      return;
    }
    emailable.forEach((lead, i) => {
      const row = leadRow(lead, i === 0, lead === selected, () => { selected = lead; paintList(); paintStep(); });
      rowRefs.set(lead.place_id, row);
      listEl.appendChild(row.el);
      row.paint(addresses[lead.place_id] || null, s.scanning && row.scanning);
    });
  }

  function paintStep() {
    clear(stepSlot);
    stepSlot.appendChild(firstStep(selected, draftFor(drafts, selected), emailable.length));
  }

  function paintPush() {
    const found = foundCount();
    const configured = instantlyConfigured(ctx);
    const label = found
      ? `Add ${found} ${found === 1 ? 'lead' : 'leads'} to the campaign`
      : 'Add leads to the campaign';
    pushBtn.lastChild.textContent = label;
    pushBtn.disabled = true;
    // There is no route in the HTTP API that pushes to Instantly, so this
    // button never sends. It says which of the three things is missing rather
    // than pretending a send happened.
    if (!configured) {
      pushHint.textContent = 'Instantly is not configured, so nothing can be sent. Set INSTANTLY_API_KEY and '
        + 'INSTANTLY_CAMPAIGN_ID in the environment and restart the local server.';
    } else if (!found) {
      pushHint.textContent = 'No address has been found yet. Scan the sites first — some will publish nothing, and '
        + 'those leads stay phone-only.';
    } else {
      pushHint.textContent = 'Sending is not wired up in this build: app/lib/email.mjs can push to Instantly, but no '
        + 'route in the local API calls it yet. Nothing has been sent.';
    }
  }

  // ------------------------------------------------------------ the scan
  const scanBtn = h('button', { type: 'button', class: 'btn btn--primary' },
    icon('search', { size: 15, stroke: '#fdf4ef', width: 2 }),
    h('span', { text: '' }));

  function paintScanBtn() {
    const n = emailable.length;
    scanBtn.lastChild.textContent = s.scanning
      ? `Scanning ${n} ${n === 1 ? 'site' : 'sites'}…`
      : `Scan ${n} ${n === 1 ? 'site' : 'sites'} for an address`;
    scanBtn.disabled = s.scanning;
  }

  function logLine(text, cls) {
    if (!text) return;
    logWrap.style.display = 'block';
    logBox.appendChild(h('div', { class: cls || null, text }));
    logBox.scrollTop = logBox.scrollHeight;
  }

  function onLine(payload) {
    const text = messageOf(payload);
    if (!text) return;
    logLine(text);

    // findAddresses() streams "[2/4] Name - reading host". Use it for the bar
    // and to mark which row is being read; the addresses themselves only ever
    // come from the done payload.
    const m = text.match(/^\[(\d+)\/(\d+)\]/);
    if (m) {
      const done = Number(m[1]);
      const of = Number(m[2]);
      if (of > 0) barFill.style.width = `${Math.min(100, Math.round((done / of) * 100))}%`;
    }
    const lower = text.toLowerCase();
    for (const lead of emailable) {
      const host = hostOf(lead.website);
      const name = String(lead.name || '').toLowerCase();
      if ((host && lower.includes(host)) || (name && lower.includes(name))) {
        const row = rowRefs.get(lead.place_id);
        if (row) { row.scanning = true; row.paint(addresses[lead.place_id] || null, true); }
      }
    }
  }

  async function runScan() {
    if (s.scanning || !emailable.length) return;
    s.scanning = true;
    paintScanBtn();
    paintCaption();
    progress.style.display = 'block';
    barFill.style.width = '0%';
    logLine(`Scanning ${emailable.length} ${emailable.length === 1 ? 'site' : 'sites'} — homepage, then the contact page.`, 'log__dim');

    try {
      const done = await ctx.api.scanEmails(slug, { log: onLine, progress: onLine });
      if (s.dead) return;
      const got = (done && done.addresses) || {};
      for (const [id, value] of Object.entries(got)) addresses[id] = value;
      const found = foundCount();
      barFill.style.width = '100%';
      logLine(`Done — ${found} of ${emailable.length} published an address.`, 'log__ok');
      ctx.toast(found
        ? `Found an address on ${found} of ${emailable.length} ${emailable.length === 1 ? 'site' : 'sites'}.`
        : 'No site in this run published an address — these stay phone-only.');
    } catch (err) {
      if (s.dead) return;
      logLine(msgOf(err), 'log__err');
      ctx.toast(`The scan stopped — ${msgOf(err)}`, 'err');
    } finally {
      s.scanning = false;
      for (const row of rowRefs.values()) row.scanning = false;
      if (!s.dead) {
        paintScanBtn();
        paintList();
        paintCaption();
        paintPush();
      }
    }
  }

  scanBtn.addEventListener('click', runScan);

  if (emailable.length) {
    actionRow.appendChild(scanBtn);
    actionRow.appendChild(h('span', {
      style: { fontSize: '12.5px', color: 'var(--ink-3)', maxWidth: '260px', lineHeight: '1.55' },
      text: 'Reads the contact page and footer. Anything it cannot find stays phone-only.',
    }));
    paintScanBtn();
  }

  paintList();
  paintCaption();
  paintStep();
  paintPush();
  return wrap;
}

// ----------------------------------------------------------------- rows

function bucketRow(bucket, isLast) {
  const count = Number(bucket.count) || 0;
  const reachable = bucket.channel === 'email' || bucket.id === 'emailable';
  return h('div', {
    class: 'trow',
    style: {
      gap: '16px',
      padding: '11px 0',
      borderBottom: `1px solid ${isLast ? 'var(--rule)' : 'var(--rule-soft)'}`,
    },
  },
    h('span', {
      class: 'tnum',
      style: {
        width: '30px', flexShrink: '0', textAlign: 'right', fontSize: '16px',
        fontWeight: '600', color: reachable ? 'var(--ink)' : 'var(--ink-3)',
      },
      text: String(count),
    }),
    h('span', {
      style: { flex: '1', minWidth: '0', fontSize: '14px', color: reachable ? 'var(--ink)' : 'var(--ink-2)' },
      text: String(bucket.note || bucket.label || bucket.id),
    }),
    h('span', {
      style: {
        flexShrink: '0', fontSize: '12.5px',
        fontWeight: reachable ? '500' : '400',
        color: reachable ? 'var(--ink-2)' : 'var(--ink-4)',
      },
      text: reachable ? 'Emailable' : 'Phone only',
    }));
}

/**
 * One emailable lead. The square on the left is which lead's draft is shown
 * below — a preview picker, not a send checkbox: nothing on this screen sends.
 */
function leadRow(lead, isFirst, isSelected, onPick) {
  const stateCell = h('span', { style: { width: '150px', flexShrink: '0', fontSize: '13px' } });
  const mark = h('span', {
    style: {
      width: '15px', height: '15px', flexShrink: '0', borderRadius: '3px',
      border: `1px solid ${isSelected ? 'var(--ink)' : 'var(--ink-5)'}`,
      background: isSelected ? 'var(--ink)' : 'var(--surface)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    },
  }, isSelected ? icon('check', { size: 10, stroke: '#faf7f1', width: 3 }) : null);

  const tier = effectiveTier(lead);
  const el = h('button', {
    type: 'button',
    class: 'trow',
    role: 'radio',
    'aria-checked': isSelected ? 'true' : 'false',
    style: {
      gap: '18px', width: '100%', cursor: 'pointer', textAlign: 'left',
      borderTop: `1px solid ${isFirst ? 'var(--rule)' : 'var(--rule-soft)'}`,
      borderBottom: '1px solid var(--rule-soft)',
    },
    onClick: onPick,
  },
    mark,
    h('span', { style: { flex: '1', minWidth: '0', fontSize: '14px' } },
      h('span', { style: { fontWeight: '600' }, text: lead.name || 'Unnamed business' }),
      h('span', {
        style: { color: 'var(--ink-3)', fontSize: '13px' },
        text: prettyHost(lead.website) ? ` · ${prettyHost(lead.website)}` : '',
      })),
    h('span', { style: { width: '130px', flexShrink: '0' } },
      h('span', { class: `pill pill--sm pill--${tier || 'needs_check'}`, text: TIER_LABEL[tier] || 'Unknown' })),
    stateCell);

  function paint(found, scanning) {
    clear(stateCell);
    if (scanning) {
      stateCell.appendChild(h('span', { style: { display: 'flex', alignItems: 'center', gap: '7px', color: 'var(--ink-2)' } },
        icon('spinner', { size: 13, stroke: '#a83a1e', width: 2.2, cls: 'spin' }),
        h('span', { text: 'Reading…' })));
      return;
    }
    if (!found) {
      stateCell.appendChild(h('span', { style: { color: 'var(--ink-4)' }, text: 'Not scanned' }));
      return;
    }
    const emails = Array.isArray(found.emails) ? found.emails : [];
    if (emails.length) {
      stateCell.appendChild(h('span', {
        class: 'mono',
        style: { fontSize: '12px', color: 'var(--ink)', wordBreak: 'break-all' },
        text: emails[0],
      }));
      if (emails.length > 1) {
        stateCell.appendChild(h('span', {
          style: { display: 'block', fontSize: '11.5px', color: 'var(--ink-4)' },
          text: `+${emails.length - 1} more`,
        }));
      }
      return;
    }
    if (found.error) {
      stateCell.appendChild(h('span', {
        style: { color: 'var(--ink-3)' },
        title: String(found.error),
        text: 'Could not read it',
      }));
      return;
    }
    stateCell.appendChild(h('span', { style: { color: 'var(--ink-3)' }, text: 'No address published' }));
  }

  return { el, paint, scanning: false };
}

// ------------------------------------------------------------- sequence

function firstStep(lead, draft, emailableCount) {
  const card = h('div', { class: 'card card--flush' });

  card.appendChild(h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 20px',
      borderBottom: '1px solid var(--rule-soft)', background: 'var(--tint)', flexWrap: 'wrap',
    },
  },
    h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--ink-3)' }, text: 'STEP 1' }),
    h('span', { style: { fontSize: '13.5px', fontWeight: '600' }, text: 'Day 0 — the specific one' }),
    h('span', { style: { flex: '1' } }),
    h('span', {
      style: { fontSize: '12.5px', color: 'var(--ink-3)' },
      text: lead ? 'Built from the reason line' : 'Nothing to draft',
    })));

  if (!lead) {
    card.appendChild(h('div', { style: { padding: '22px 24px' } },
      h('p', {
        style: { fontSize: '13.5px', lineHeight: '1.65', color: 'var(--ink-3)' },
        text: emailableCount
          ? 'Pick one of the sites above to see the draft it produces.'
          : 'No lead in this run has a site of its own, so there is no draft to write. These are phone calls.',
      })));
    return card;
  }

  if (!draft) {
    card.appendChild(h('div', { style: { padding: '22px 24px' } },
      h('p', {
        style: { fontSize: '13.5px', lineHeight: '1.65', color: 'var(--ink-3)' },
        text: `No draft came back for ${lead.name || 'this lead'}. The opener is built from its verified reason line, so `
          + 'nothing is written until the site check has run.',
      })));
    return card;
  }

  const { message, footer } = splitBody(draft.body);
  const body = h('div', { style: { padding: '20px 24px 22px' } });

  body.appendChild(h('div', {
    style: { display: 'flex', gap: '12px', fontSize: '13.5px', paddingBottom: '14px', borderBottom: '1px solid var(--rule-soft)' },
  },
    h('span', { style: { color: 'var(--ink-4)', width: '58px', flexShrink: '0' }, text: 'Subject' }),
    h('span', { style: { color: 'var(--ink)', minWidth: '0' }, text: draft.subject || '[NO SUBJECT]' })));

  const prose = h('div', {
    style: { marginTop: '16px', fontSize: '14.5px', lineHeight: '1.75', color: 'var(--ink-prose)' },
  });
  paragraphs(message).forEach((block, i) => {
    const p = h('p', { style: i ? { marginTop: '13px' } : {} });
    block.forEach((line, j) => {
      if (j) p.appendChild(h('br'));
      p.appendChild(document.createTextNode(line));
    });
    prose.appendChild(p);
  });
  body.appendChild(prose);

  if (footer.length) {
    const foot = h('div', {
      style: {
        marginTop: '18px', paddingTop: '14px', borderTop: '1px solid var(--rule-soft)',
        fontSize: '12px', lineHeight: '1.6', color: 'var(--ink-4)',
      },
    });
    for (const line of footer) foot.appendChild(h('div', { text: line }));
    body.appendChild(foot);
  }

  card.appendChild(body);
  return card;
}

/** Steps 2 and 3 — collapsed, and honest about not being written yet. */
function laterStep(step) {
  const chev = icon('chevronDown', { size: 12, stroke: '#b3aa98', width: 2.6 });
  const panel = h('div', {
    style: {
      display: 'none', padding: '0 20px 16px', fontSize: '13px',
      lineHeight: '1.65', color: 'var(--ink-3)',
    },
  }, h('p', {
    text: 'Not written yet. app/lib/email.mjs drafts step 1 only — the one built from the lead’s own reason line. '
      + 'Steps 2 and 3 get written before the first send, and they carry the same postal address and unsubscribe link.',
  }));

  let open = false;
  const head = h('button', {
    type: 'button',
    'aria-expanded': 'false',
    style: {
      display: 'flex', alignItems: 'center', gap: '14px', width: '100%',
      padding: '14px 20px', textAlign: 'left', cursor: 'pointer',
    },
    onClick: () => {
      open = !open;
      panel.style.display = open ? 'block' : 'none';
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      chev.style.transform = open ? 'rotate(180deg)' : '';
    },
  },
    h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--ink-3)' }, text: `STEP ${step.n}` }),
    h('span', { style: { fontSize: '13.5px', fontWeight: '600' }, text: step.title }),
    h('span', { style: { flex: '1' } }),
    chev);

  return h('div', { class: 'card card--flush', style: { marginTop: '10px' } }, head, panel);
}

// ----------------------------------------------------------- right rail

function instantlyConfigured(ctx) {
  const config = (ctx.state && ctx.state.config) || {};
  const inst = config.instantly;
  if (inst === true) return true;
  if (inst && typeof inst === 'object') return inst.configured === true;
  return false;
}

function instantlyChip(ctx) {
  const on = instantlyConfigured(ctx);
  return h('span', {
    class: `status${on ? ' status--set' : ''}`,
    style: { height: '34px', padding: '0 14px', borderRadius: '17px', marginBottom: '4px' },
  },
    h('span', {
      style: { width: '7px', height: '7px', borderRadius: '4px', flexShrink: '0', background: on ? '#6f8a54' : 'var(--ink-6)' },
    }),
    h('span', { text: on ? 'Instantly connected' : 'Instantly not configured' }),
    h('span', { class: 'dot-sep', text: '·' }),
    h('span', {
      style: { color: 'var(--ink-4)' },
      text: on ? '[YOUR WORKSPACE]' : 'nothing can be sent',
    }));
}

function campaignCard(ctx, pushBtn, pushHint) {
  const on = instantlyConfigured(ctx);
  const card = h('div', { class: 'card', style: { marginTop: '14px' } });

  card.appendChild(h('div', {
    class: 'field field--sm',
    style: { height: '42px', marginTop: '0', justifyContent: 'space-between', fontSize: '14px' },
  }, h('span', { text: '[YOUR CAMPAIGN]' })));

  const line = (label, value) => h('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', paddingTop: '10px', fontSize: '13.5px' },
  },
    h('span', { style: { color: 'var(--ink-2)' }, text: label }),
    h('span', { style: { color: 'var(--ink-4)' }, text: value }));

  card.appendChild(line('Sending account', '[YOUR INBOX]'));
  card.appendChild(line('Daily cap', '[YOUR DAILY CAP]'));
  card.appendChild(line('Window', '[YOUR SENDING WINDOW]'));
  card.appendChild(h('p', {
    class: 'hint',
    style: { marginTop: '12px', lineHeight: '1.55' },
    text: on
      ? 'These live in the Instantly campaign, not in this repo, so they are shown as placeholders rather than guessed at.'
      : 'No campaign is configured, so there is nothing to fill these in from.',
  }));

  card.appendChild(pushBtn);
  card.appendChild(pushHint);
  return card;
}

// ------------------------------------------------------- loading / error

function loadingBlock() {
  return h('div', { style: { display: 'flex', gap: '72px', flexWrap: 'wrap' } },
    h('div', { style: { flex: '1', minWidth: '380px' } },
      h('div', { class: 'skeleton', style: { height: '13px', width: '180px' } }),
      [0, 1, 2, 3].map((i) => h('div', {
        class: 'skeleton',
        style: { height: '40px', marginTop: '10px', opacity: String(1 - i * 0.16) },
      })),
      h('div', { class: 'skeleton', style: { height: '220px', marginTop: '36px' } })),
    h('div', { class: 'skeleton', style: { height: '260px', width: '340px' } }));
}

function errorBlock(err, retry) {
  return h('div', {},
    h('div', { class: 'empty' },
      icon('alert', { size: 22, stroke: '#bcb2a0', width: 1.7 }),
      h('div', { class: 'empty__title', text: 'The email view did not load' }),
      h('p', { class: 'empty__body', style: { maxWidth: '440px', margin: '7px auto 0' }, text: msgOf(err) })),
    h('div', { style: { display: 'flex', gap: '12px', marginTop: '22px' } },
      h('button', { class: 'btn btn--outline', type: 'button', onClick: retry }, 'Try again'),
      h('a', { class: 'btn btn--quiet', href: '#/runs' }, 'All searches')));
}

/** SSE payloads arrive as objects; be forgiving about which field holds text. */
function messageOf(payload) {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') return payload;
  const v = payload.message ?? payload.line ?? payload.text ?? payload.msg ?? payload.status;
  return typeof v === 'string' ? v : '';
}
