#!/usr/bin/env node
/**
 * audit-imageless-scored-shows.js — card #1456 suggested-approach #3.
 *
 * Independent backstop for the show-goes-live -> image-fetch gap: finds any
 * show that has reviews (is live/scored) but no image on disk for more than
 * DEFAULT_THRESHOLD_HOURS, self-heals by dispatching fetch-all-image-formats
 * for it, and alarms via owner-alert-router when either the dispatch itself
 * fails or the self-heal isn't actually landing a poster after repeated
 * attempts (second-opinion review, 2026-08-14: an {ok:true} dispatch only
 * proves the POST was accepted, not that an image was found — a sparse-web
 * regional/OB show can loop "successfully" forever with zero owner signal
 * otherwise).
 *
 * State/ledger lives IN the output file itself (data/audit/imageless-scored-shows.json)
 * so a per-show dispatch cooldown survives across the 4h-cron runs without a
 * second file — self-pruning: an id drops out the run after its image lands.
 *
 * Usage: node scripts/audit-imageless-scored-shows.js [--dry-run]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { hasRealImage } = require('./lib/show-images.js');
const {
  findImagelessScoredShows,
  DEFAULT_THRESHOLD_HOURS,
  planSelfHealDispatch,
  executeSelfHealDispatch,
} = require('./lib/image-trigger-guard.js');
const { dispatchImageFetch } = require('./lib/dispatch-image-fetch.js');

const USAGE = `Usage: node scripts/audit-imageless-scored-shows.js [--dry-run]
  --dry-run    Compute + print findings, skip dispatch/alert/write.
`;

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'audit', 'imageless-scored-shows.json');
const COOLDOWN_HOURS = 12; // min gap between re-dispatch attempts for the same show
const ESCALATE_AFTER_ATTEMPTS = 3; // self-heal dispatched 3x and still imageless -> alert
// Caps how many shows ride in ONE batch, not how many dispatches fire — since
// BRO-2672's second-caller fix a cycle fires at most one workflow_dispatch no
// matter how many shows are due, so the old "flooding the fetch-images
// concurrency group" rationale for this number no longer applies. What it
// still buys: fetch-all-image-formats.yml processes the comma list serially
// inside a single job, so an unbounded batch would push that one run past its
// timeout and lose the whole batch instead of the tail. Prioritize
// newest-first — THIS card is about a new show going live, not draining the
// historical backlog, which still drains gradually across cycles (and via the
// twice-weekly full sweep).
const MAX_SHOWS_PER_BATCH = 5;

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Earliest of the 3 candidate fields, not first-available (adversarial
// review, 2026-08-14): a historical show backfilled today gets a fresh
// discoveredAt but a years-old openingDate — picking discoveredAt would
// reset its "since when has this been imageless" clock and suppress a
// genuinely overdue show behind a false 24h grace period.
function resolveSinceMs(show) {
  const candidates = [show.discoveredAt, show.openingDate, show.previewsStartDate]
    .map((raw) => (raw ? Date.parse(raw) : NaN))
    .filter((ms) => !Number.isNaN(ms));
  if (!candidates.length) return null;
  return Math.min(...candidates);
}


function buildReviewCountByShow(reviewsData) {
  const list = Array.isArray(reviewsData) ? reviewsData
    : Array.isArray(reviewsData?.reviews) ? reviewsData.reviews
    : Object.values(reviewsData?.reviews || {});
  const counts = {};
  for (const r of list) {
    if (!r || !r.showId) continue;
    counts[r.showId] = (counts[r.showId] || 0) + 1;
  }
  return counts;
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const dryRun = process.argv.includes('--dry-run');

  const showsData = loadJson(path.join(DATA_DIR, 'shows.json'), { shows: [] });
  const reviewsData = loadJson(path.join(DATA_DIR, 'reviews.json'), {});
  const reviewCountByShow = buildReviewCountByShow(reviewsData);
  const prevLedger = loadJson(OUTPUT_FILE, { flagged: [] });
  const prevById = new Map((prevLedger.flagged || []).map((f) => [f.id, f]));

  const nowMs = Date.now();
  const normalized = (showsData.shows || []).map((s) => ({
    id: s.id,
    title: s.title,
    hasImages: hasRealImage(s),
    reviewCount: reviewCountByShow[s.id] || 0,
    sinceMs: resolveSinceMs(s),
  }));

  const flagged = findImagelessScoredShows(normalized, { nowMs, thresholdHours: DEFAULT_THRESHOLD_HOURS });

  console.log(`${flagged.length} show(s) have reviews but no image on disk after ${DEFAULT_THRESHOLD_HOURS}h.`);
  if (dryRun) {
    for (const f of flagged) console.log(`  - ${f.id} (${f.title}), reviewCount=${f.reviewCount}`);
    return;
  }

  // Newest-first: a just-published show is the actual target of this card;
  // a years-old historical gap is lower urgency and can wait its turn.
  const orderedFlagged = [...flagged].sort((a, b) => b.sinceMs - a.sinceMs);

  // ONE dispatch for the whole batch, never one per show. Each
  // workflow_dispatch lands in fetch-all-image-formats.yml's single-slot
  // concurrency group, which keeps one run queued and silently CANCELS the
  // rest — so the old per-show loop fired five runs seconds apart of which at
  // most one survived, while recording lastDispatchedAt for all five and
  // letting the cooldown suppress the retry. planSelfHealDispatch() routes the
  // ids through buildImageDispatchInputs(), which collapses any number of them
  // into at most one entry, so the fan-out cannot come back by omission.
  const plan = planSelfHealDispatch({
    orderedFlagged,
    prevById,
    nowMs,
    cooldownHours: COOLDOWN_HOURS,
    maxDispatchesPerRun: MAX_SHOWS_PER_BATCH,
  });
  const nextLedger = plan.entries;
  const entryById = new Map(nextLedger.map(e => [e.id, e]));

  for (const f of plan.deferred) {
    console.log(`… ${f.id} due for dispatch but MAX_SHOWS_PER_BATCH=${MAX_SHOWS_PER_BATCH} reached this cycle — picked up next run`);
  }

  // Only shows a SUCCESSFUL dispatch actually carried get their attempt counter
  // and cooldown advanced — a failed dispatch must leave the ledger untouched so
  // the next cycle retries instead of waiting out a cooldown for work that never
  // happened. The alert stays keyed PER SHOW: one global key would let a later
  // batch of entirely different shows be silenced behind an earlier batch's 24h
  // cooldown, losing per-show ownership (pre-ship review finding).
  await executeSelfHealDispatch({
    plan,
    dispatch: dispatchImageFetch,
    nowMs,
    log: (line) => console.log(line),
    onAlert: async ({ show, error, batchIds }) => {
      try {
        const { routeAlert } = require('./lib/owner-alert-router.js');
        await routeAlert({
          conditionKey: `imageless-scored-show:dispatch-failed:${show.id}`,
          title: `Image-fetch self-heal dispatch failed for ${show.title || show.id}`,
          description: `${show.title || show.id} has reviews but no image on disk, and the automatic fetch-all-image-formats.yml dispatch itself failed: ${error}. It was dispatched in a batch of ${plan.due.length}: ${batchIds}`,
          hint: `Check GITHUB_TOKEN/GH_TOKEN scope for actions:write, then re-run: gh workflow run fetch-all-image-formats.yml -f show_id=${show.id}`,
          severity: 'error',
          disposition: 'auto',
          cooldownHours: 24,
        });
      } catch (err) {
        console.error(`routeAlert failed: ${err.message}`);
      }
    },
  });

  for (const f of orderedFlagged) {
    const entry = entryById.get(f.id);
    if ((entry.dispatchAttempts || 0) >= ESCALATE_AFTER_ATTEMPTS) {
      try {
        const { routeAlert } = require('./lib/owner-alert-router.js');
        await routeAlert({
          conditionKey: `imageless-scored-show:still-imageless:${f.id}`,
          title: `${f.title || f.id} still has no image after ${entry.dispatchAttempts} self-heal attempts`,
          description: `Self-heal has dispatched fetch-all-image-formats.yml ${entry.dispatchAttempts} times for ${f.title || f.id} but no image has landed on disk — likely no discoverable poster for this show, needs a manual source.`,
          hint: `node scripts/fetch-show-images-auto.js --show=${f.id} --dry-run   # inspect why no candidate image is found`,
          severity: 'warn',
          disposition: 'auto',
          cooldownHours: 48,
        });
      } catch (err) {
        console.error(`routeAlert (escalation) failed: ${err.message}`);
      }
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    generatedAt: new Date(nowMs).toISOString(),
    thresholdHours: DEFAULT_THRESHOLD_HOURS,
    cooldownHours: COOLDOWN_HOURS,
    escalateAfterAttempts: ESCALATE_AFTER_ATTEMPTS,
    maxDispatchesPerRun: MAX_SHOWS_PER_BATCH,
    flagged: nextLedger,
  }, null, 2) + '\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
