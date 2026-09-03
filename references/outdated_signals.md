# Judging whether a site is outdated

Read this before stage 2. "Outdated" is a judgment call, and without a fixed
definition the same site gets tiered differently on different days, which makes
the lead list untrustworthy. This file pins it down.

The bar to keep in mind: **would a reasonable owner, shown this site next to a
current one, feel embarrassed?** Not "could it be better" - almost any site
could. Embarrassment is what makes someone take the call.

## Signals

Check these per site. Each one that applies counts as one signal.

**Objective (check these first - they are fast and not a matter of opinion)**

- **No HTTPS.** The URL stays on `http://`, or the browser flags it as not
  secure. Easy to verify and easy to mention on a call, since customers see the
  warning too.
- **No viewport meta tag.** View source and look for
  `<meta name="viewport" ...>`. Its absence means the site predates mobile-first
  design entirely - a very strong signal, and worth checking because a site can
  look fine on desktop while being unusable on a phone.
- **Stale copyright.** A footer year more than about three years old. Also
  counts: a "latest news" or "specials" section whose newest item is years old.
- **Broken elements.** Missing images, dead internal links, a contact form that
  visibly errors.

**Visual (needs the screenshot)**

- **Not mobile-friendly.** At a phone-width viewport, the desktop layout just
  shrinks, text needs pinch-zoom to read, or the page scrolls sideways.
- **Dated design era.** Table-based layouts, beveled or gradient buttons,
  tiled background images, tiny body text, low-resolution or stretched photos,
  clip-art, visitor counters, "best viewed in" badges, Flash placeholders,
  autoplaying audio.
- **Obvious untouched template.** Default theme fonts and colors, placeholder
  copy still in place ("Lorem ipsum", "Your text here", "Home | About | Contact"
  with empty pages behind them), stock photos that do not match the business.

## Scoring

- **Loads but 0 signals** - not a lead. Leave it off the list entirely; padding
  the list with healthy sites is what makes people stop trusting it.
- **1-2 signals** - `somewhat_dated`.
- **3 or more signals** - `very_dated`.
- **Does not load at all** - `dead_site`. Parked domain, expired certificate,
  server error, or a domain-for-sale page. Rank this near the top: they already
  bought into having a site, so the pitch is renewal rather than persuasion.

When a site sits right on a boundary, mark it borderline and say why rather than
forcing a tier. A short maybe-pile is more useful than a confident wrong call.

## Writing the reason line

The reason is the opening line of a cold call, so it has to be specific,
verifiable, and neutral. The owner may well have built the site themselves -
leading with an insult ends the call.

Good:
- "No mobile version - the footer still says 2013."
- "Site doesn't load at all, domain looks expired."
- "Everything runs through their Facebook page, no site of their own."

Too vague to use:
- "Outdated design."
- "Needs work."

Avoid: "ugly", "terrible", "embarrassing", "amateur". Describe what is
factually there and let the owner draw the conclusion.
