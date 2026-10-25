'use strict';
/**
 * Analytics measurement changes that move the numbers without any change in real
 * traffic (BRO-5984). The weekly traffic report notes them and does not flag
 * spikes in the weeks they distort, because source medians still reflect the
 * old, ad-blocker-undercounted baseline.
 *
 * Each entry is also annotated in PostHog by scripts/annotate-posthog-cutovers.js.
 * Add new entries here, never inline in the report.
 */
const CUTOVERS = [
  {
    date: '2026-10-23', // UTC day the /ingest proxy went live on production (02:11Z, deploy of dc652cd23)
    label: 'PostHog now loads through our own domain (/ingest), so ad blockers no longer hide visitors from it',
    // Weeks after the cutover week whose spike flags are suppressed.
    suppressWeeksAfter: 1,
  },
];

function weekStart(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Set of Monday week starts whose spike flags are suppressed. */
function cutoverWeeks(cutovers = CUTOVERS) {
  const out = new Set();
  for (const c of cutovers) {
    const start = new Date(`${weekStart(c.date)}T00:00:00Z`);
    for (let i = 0; i <= (c.suppressWeeksAfter || 0); i++) {
      out.add(new Date(start.getTime() + i * 7 * 86400000).toISOString().slice(0, 10));
    }
  }
  return out;
}

/** Cutovers whose suppressed window contains any of the given week starts. */
function cutoversAffecting(weeks, cutovers = CUTOVERS) {
  const wanted = new Set(weeks);
  return cutovers.filter((c) => [...cutoverWeeks([c])].some((w) => wanted.has(w)));
}

module.exports = { CUTOVERS, cutoverWeeks, cutoversAffecting, weekStart };
