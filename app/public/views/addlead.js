// Add a lead by hand — a referral, a business card, a shopfront spotted on
// foot. Stage 1 normally does this from Maps data; this form is the manual
// path for businesses a search will never surface. Name and phone are the
// only requirements: the list exists to be called.

import { h, clear, icon } from '../dom.js';

export const meta = { title: 'Add a lead' };

const CSS = `
.add { max-width: 560px; }
.add__form { display: grid; gap: 16px; margin-top: 26px; }
.add__row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.add__field label { display: block; margin-bottom: 6px; }
.add__err { color: var(--warn-ink); font-size: 13px; margin-top: 4px; }
@media (max-width: 700px) { .add__row { grid-template-columns: 1fr; } }
`;

const TIERS = [
  ['', 'Judge from the website field'],
  ['no_website', 'No website'],
  ['social_only', 'Social page only'],
  ['free_host', 'Free-host site'],
  ['needs_check', 'Has a site — check it later'],
];

function field(label, input, hint) {
  return h('div', { class: 'add__field' },
    h('label', { class: 'label' }, label),
    input,
    hint ? h('p', { class: 'hint', style: { marginTop: '5px' }, text: hint }) : null);
}

export async function render(root, ctx) {
  const { api, state, toast, navigate } = ctx;
  const runs = state.runs || [];
  const wrap = h('div', { class: 'add' });
  wrap.appendChild(h('style', { text: CSS }));

  wrap.appendChild(h('div', { class: 'eyebrow', text: 'web-leads / add a lead' }));
  wrap.appendChild(h('h1', { class: 'title', style: { marginTop: '14px' }, text: 'Add a lead by hand' }));
  wrap.appendChild(h('p', { class: 'subtitle', text: 'For businesses a search will never surface — a referral, a business card, a shopfront. It joins the chosen list, ranked with the rest.' }));

  if (!runs.length) {
    wrap.appendChild(h('div', { class: 'empty', style: { marginTop: '30px' } },
      h('div', { class: 'empty__title', text: 'No search to add to yet' }),
      h('div', { class: 'empty__body', text: 'A hand-added lead lives inside a search’s call list. Run a search first, then come back.' }),
      h('a', { class: 'btn btn--primary', style: { marginTop: '18px' }, href: '#/search' }, 'Start a search')));
    clear(root); root.appendChild(wrap);
    return;
  }

  const runSel = h('select', { class: 'field' },
    runs.map((r) => h('option', { value: r.slug, text: `${r.niche || r.slug} — ${r.location || ''}` })));
  const name = h('input', { class: 'field', placeholder: 'Rossi Tile & Stone' });
  const phone = h('input', { class: 'field', placeholder: '(732) 555-0123', type: 'tel' });
  const address = h('input', { class: 'field', placeholder: '18 Main St, Milltown, NJ' });
  const category = h('input', { class: 'field', placeholder: 'Tile contractor' });
  const website = h('input', { class: 'field', placeholder: 'https://… (leave blank if none)', type: 'url' });
  const tierSel = h('select', { class: 'field' }, TIERS.map(([v, l]) => h('option', { value: v, text: l })));
  const reason = h('textarea', { class: 'textarea', rows: 2, placeholder: 'Why they’re a lead — specific and neutral. e.g. "Referred by the roofer on Amboy Ave; card has no website on it."' });
  const errLine = h('div', { class: 'add__err' });
  const submit = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Add to the list');

  const form = h('form', { class: 'add__form' },
    field('Add to which search?', runSel),
    h('div', { class: 'add__row' },
      field('Business name', name),
      field('Phone', phone, 'Required — the list exists to be called.')),
    h('div', { class: 'add__row' },
      field('Address', address),
      field('Trade / category', category)),
    field('Website, if any', website, 'Blank means the lead is tiered "no website".'),
    field('Tier', tierSel),
    field('Opener / reason line', reason),
    errLine,
    h('div', {}, submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errLine.textContent = '';
    if (!name.value.trim()) { errLine.textContent = 'A business name is required.'; return; }
    if (!phone.value.trim()) { errLine.textContent = 'A phone number is required.'; return; }
    submit.disabled = true;
    submit.textContent = 'Adding…';
    try {
      const slug = runSel.value;
      await api.addLead(slug, {
        name: name.value, phone: phone.value, address: address.value,
        category: category.value, website: website.value,
        tier: tierSel.value || undefined, reason: reason.value,
      });
      toast(`${name.value.trim()} added to the call list`);
      navigate(`#/leads/${encodeURIComponent(slug)}`);
    } catch (err) {
      errLine.textContent = String(err.message || err);
      submit.disabled = false;
      submit.textContent = 'Add to the list';
    }
  });

  wrap.appendChild(form);
  clear(root);
  root.appendChild(wrap);
}
