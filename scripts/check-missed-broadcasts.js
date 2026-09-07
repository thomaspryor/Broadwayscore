#!/usr/bin/env node
/**
 * check-missed-broadcasts.js — daily sweep for opening-night broadcasts that
 * silently never happened.
 *
 * The opening-night broadcast pipeline only looks at shows inside a 2-day
 * lookback window. A show that is gate-blocked for longer than that leaves the
 * window and is never considered again — no send, and (because the overdue
 * pager is itself gated on that same window) no alert. Electra / Persona
 * opened 2026-09-01, was checklist-blocked on every run, and left the pipeline
 * unannounced; the owner discovered it a week later.
 *
 * This runs from data-health-check.yml alongside the other lifetime sweeps,
 * which exist for the same structural reason: a check that only ever runs
 * inside the opening-night window cannot see anything that ages out of it.
 *
 * Predicate + rationale: scripts/lib/missed-broadcasts.js (pure, unit-tested).
 * This file is I/O and alert routing only (CLAUDE.md §15).
 *
 * Usage:
 *   node scripts/check-missed-broadcasts.js              # report + alert
 *   node scripts/check-missed-broadcasts.js --dry-run    # report only, never alerts
 *   node scripts/check-missed-broadcasts.js --json       # machine-readable to stdout
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { findMissedBroadcasts } = require('./lib/missed-broadcasts');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const AS_JSON = args.includes('--json');

const DATA_DIR = path.join(process.cwd(), 'data');
const SNAPSHOT_PATH = path.join(DATA_DIR, 'audit', 'missed-broadcasts.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const showsRaw = readJson('shows.json', null);
  // Fail loudly rather than reporting a cheerful zero off a missing/partial
  // core-data checkout — "no missed broadcasts" read off no shows at all is
  // exactly the confident-wrong-answer this sweep exists to prevent.
  if (!showsRaw || !Array.isArray(showsRaw.shows) || showsRaw.shows.length === 0) {
    console.error('::error::shows.json missing or empty — cannot check for missed broadcasts');
    process.exit(1);
  }

  const reviewsRaw = readJson('reviews.json', []);
  const reviews = Array.isArray(reviewsRaw) ? reviewsRaw : (reviewsRaw.reviews || []);
  if (!reviews.length) {
    console.error('::error::reviews.json missing or empty — cannot check the scored-review floor');
    process.exit(1);
  }

  const sentShows = readJson('opening-night-sent.json', {}).shows || {};

  const missed = findMissedBroadcasts({
    shows: showsRaw.shows,
    sentShows,
    reviews,
    now: Date.now(),
  });

  const snapshot = {
    generatedAt: new Date().toISOString(),
    missedCount: missed.length,
    missed,
  };
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  } catch (err) {
    console.error(`::warning::could not write ${SNAPSHOT_PATH}: ${err.message}`);
  }

  if (AS_JSON) console.log(JSON.stringify(snapshot, null, 2));

  if (!missed.length) {
    console.log('No missed opening-night broadcasts.');
    return;
  }

  const lines = missed.map(
    (m) => `${m.title} (${m.id}) — opened ${m.openingDate}, ${m.daysSinceOpening}d ago, ${m.scoredReviews} scored reviews, never broadcast`
  );
  console.log(`Missed opening-night broadcasts (${missed.length}):`);
  for (const line of lines) console.log(`  - ${line}`);

  if (DRY_RUN) {
    console.log('--dry-run: no alert routed.');
    return;
  }

  const { routeAlert } = require('./lib/owner-alert-router');
  const ids = missed.map((m) => m.id).sort().join(',');
  const result = await routeAlert({
    // Sorted id list, mirroring the checklist/overdue gates' BREACHED_LIST
    // pattern: a stable set collapses to one page, a NEW missed show changes
    // the key and pages again rather than hiding behind the old cooldown.
    conditionKey: 'broadcast:never-sent:' + ids,
    title: 'Opening Night Broadcast Never Sent',
    description:
      'These shows opened, gathered enough scored reviews to qualify, and then left the broadcast window without an email ever going out. ' +
      'The automated pipeline will NOT retry them — it only considers shows opened within the last 2 days.\n\n' +
      'To send one now:\n' +
      '  gh workflow run "Opening Night Broadcast" -f lookback_days=<days since opening> -f force_broadcast=true\n\n' +
      'force_broadcast=true is required when the show is still QA-blocked; check first with:\n' +
      '  node scripts/opening-night-checklist.js --show=<id>',
    severity: 'error',
    disposition: 'human',
    cooldownHours: 24,
    fields: [{ name: 'Shows', value: lines.join('\n') }],
  });
  console.log(`[alert-router] missed-broadcast alert routed: ${result.action}`);
}

main().catch((err) => {
  console.error(`::error::check-missed-broadcasts failed: ${err.message}`);
  process.exit(1);
});
