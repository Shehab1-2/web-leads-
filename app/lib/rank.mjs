// The ranking is the product. Strongest lead first, healthy sites cut entirely.
// Order comes straight from README.md stage 3.

export const TIER_ORDER = [
  'no_website',
  'dead_site',
  'social_only',
  'free_host',
  'very_dated',
  'somewhat_dated',
];

/** Tiers stage 1 can assign from Maps data alone. */
export const STAGE1_TIERS = ['no_website', 'social_only', 'free_host', 'needs_check'];

export const TIER_LABEL = {
  no_website: 'No website',
  dead_site: 'Dead site',
  social_only: 'Social only',
  free_host: 'Free host',
  very_dated: 'Very dated',
  somewhat_dated: 'Somewhat dated',
  needs_check: 'Needs checking',
  not_a_lead: 'Healthy site',
};

/**
 * Position in the call order. Anything not in TIER_ORDER — `not_a_lead`, or an
 * unchecked `needs_check` row — sorts to the bottom and is filtered out of the
 * call list rather than padding it.
 */
export function tierRank(tier) {
  const i = TIER_ORDER.indexOf(tier);
  return i === -1 ? TIER_ORDER.length + 1 : i;
}

export function isLead(tier) {
  return TIER_ORDER.includes(tier);
}

/** The verdict to rank on: stage 2's if it ran, otherwise stage 1's. */
export function effectiveTier(lead) {
  return lead.checked_tier || lead.tier || '';
}

/**
 * Strongest first; within a tier, busiest first — review count is the best
 * proxy available for "this shop already has demand".
 */
export function rankLeads(leads) {
  return [...leads].sort((a, b) => {
    const d = tierRank(effectiveTier(a)) - tierRank(effectiveTier(b));
    if (d !== 0) return d;
    return (Number(b.reviews) || 0) - (Number(a.reviews) || 0);
  });
}

export function countByTier(leads) {
  const counts = {};
  for (const l of leads) {
    const t = effectiveTier(l);
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}
