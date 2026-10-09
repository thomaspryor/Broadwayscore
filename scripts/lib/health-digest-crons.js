'use strict';

/**
 * Workflows whose last-run freshness shows up in health-check.js's daily
 * digest ("Cron: <name>" rows). Extracted from health-check.js so the coverage
 * audit can require() the real list (BRO-2818) instead of regexing source.
 *
 * Contract with .github/workflows/check-cron-health.yml CRITICAL_CRONS (the
 * real-time paging list): every entry here either appears there with the SAME
 * maxHours, or is listed in DIGEST_ONLY below with a reason. The audit
 * (scripts/audit-cron-health-coverage.js) fails on drift in either direction,
 * and on any .cron-health-exempt.txt entry that claims `[digest]` coverage but
 * is not in this list.
 */

const DIGEST_CRONS = [
  { workflow: 'update-show-status.yml', maxHours: 36, name: 'Update Show Status' },
  { workflow: 'rebuild-reviews.yml', maxHours: 36, name: 'Rebuild Reviews' },
  { workflow: 'collect-review-texts.yml', maxHours: 36, name: 'Collect Review Texts' },
  { workflow: 'llm-ensemble-score.yml', maxHours: 48, name: 'LLM Ensemble Score' },
  { workflow: 'test.yml', maxHours: 48, name: 'Test Suite' },
  { workflow: 'opening-night-broadcast.yml', maxHours: 36, name: 'Opening Night Broadcast' },
  { workflow: 'update-lottery-rush.yml', maxHours: 110, name: 'Update Lottery/Rush' },
  { workflow: 'weekly-grosses.yml', maxHours: 192, name: 'Weekly Grosses' },
  { workflow: 'update-show-score.yml', maxHours: 192, name: 'Update Show Score' },
  { workflow: 'update-mezzanine.yml', maxHours: 192, name: 'Update Mezzanine' },
  { workflow: 'update-cast-changes.yml', maxHours: 120, name: 'Update Cast Changes' },
  { workflow: 'weekly-nyt-critics-picks.yml', maxHours: 72, name: 'NYT Critics Picks' },
  { workflow: 'weekly-video-reviews.yml', maxHours: 192, name: 'Weekly Video Reviews' },
  // 6-hourly; 24h = four missed runs. If this goes dark the evidence layer
  // (roundup-anchored selection + missing-show candidates) silently stops.
  { workflow: 'audit-reverse-discovery.yml', maxHours: 24, name: 'Reverse Discovery' },
  // BRO-2818: check-cron-health.yml is the workflow that notices other crons
  // dying, and it was in neither the paging list nor this digest (only the
  // exempt file), so nothing noticed it dying. Daily at 12:00 UTC; 36h is the
  // same band the other daily entries use. The digest runs from data-health-check.yml,
  // which check-cron-health.yml itself pages on, so the two watch each other.
  // livenessOnly: the watchdog exits 1 by design whenever it pages, and all of its last 30
  // scheduled runs concluded `failure`, so a success-based row would be a permanent
  // fix-now "Cron failed" digest entry. Any completed run inside the window is liveness.
  { workflow: 'check-cron-health.yml', maxHours: 36, name: 'Cron Health Watchdog', livenessOnly: true },
];

// Digest entries that are intentionally NOT in check-cron-health.yml
// CRITICAL_CRONS (digest-only). Anything else missing from the paging list is drift.
const DIGEST_ONLY = {
  'audit-reverse-discovery.yml': 'digest-only by design: candidates surface in the daily digest, a 1-day-late detection is acceptable (.cron-health-exempt.txt)',
  'check-cron-health.yml': 'a watchdog cannot page on itself; the digest (data-health-check.yml, which IS paged) is the independent watcher',
};

module.exports = { DIGEST_CRONS, DIGEST_ONLY };
