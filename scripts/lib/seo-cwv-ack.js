/**
 * Expiring acknowledgment for known CWV field-metric regressions where the
 * underlying code fix has already shipped but CrUX field data (28-day
 * trailing) can't reflect it for weeks. Mirrors scripts/lib/scrapingbee-ack.js:
 * a known, already-fixed regression still errors check-seo-health.js daily
 * until the acknowledgment expires, forcing re-triage instead of silently
 * masking forever (card #368).
 *
 * Scoped per {url, metric} — only the exact known regression is downgraded.
 * A field regression on a different page or metric still errors normally.
 *
 * `url` may also be the bare origin (SITE_HOST, no path). check-seo-health.js
 * reports a PSI origin-fallback breach against the origin rather than against each
 * page that inherited it, and looks the acknowledgment up the same way — so an
 * origin-wide regression needs its own entry here. A page entry deliberately does
 * NOT silence an origin-wide number: it describes one page, and CrUX can stop
 * publishing page-level data for that URL at any time (as it did for /west-end on
 * 2026-08-02), at which point the entry simply stops matching. See
 * scripts/lib/seo-cwv-field-scope.js for how scope is decided.
 */

'use strict';

const ACKNOWLEDGED_CWV_FIELD_REGRESSIONS = [
  {
    url: 'https://broadwayscorecard.com/west-end',
    metric: 'lcp',
    reason: 'Fix shipped 20315509d (#317, 2026-07-21): SSR the LCP poster on /west-end. Field LCP is CrUX 28-day trailing data and cannot clear until the window rolls past the fix.',
    expires: '2026-08-18',
  },
];

function findCWVFieldAcknowledgment(url, metric, today) {
  const todayDate = today || new Date().toISOString().slice(0, 10);
  return (
    ACKNOWLEDGED_CWV_FIELD_REGRESSIONS.find(
      (a) => a.url === url && a.metric === metric && a.expires > todayDate
    ) || null
  );
}

module.exports = { ACKNOWLEDGED_CWV_FIELD_REGRESSIONS, findCWVFieldAcknowledgment };
