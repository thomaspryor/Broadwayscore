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
const { isTourShow } = require('./lib/tour-family.js');
const {
  findImagelessScoredShows,
  DEFAULT_THRESHOLD_HOURS,
  planSelfHealDispatch,
  executeSelfHealDispatch,
  idsClearedSinceLastRun,
  IMAGELESS_DISPATCH_FAILED_KEY,
  IMAGELESS_STILL_IMAGELESS_KEY,
  buildDispatchFailedAlert,
  buildStillImagelessAlert,
} = require('./lib/image-trigger-guard.js');
const { syncRollup, snapshotRollupMembers } = require('./lib/rollup-alert.js');
const { dispatchImageFetch } = require('./lib/dispatch-image-fetch.js');
const { hasActiveNoArtMarker } = require('./lib/no-reliable-art.js');

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
    // BRO-5022: the fetcher found only wrong art and marked the row. Not a
    // gap to self-heal: re-dispatching re-runs the search that already failed.
    noReliableArt: hasActiveNoArtMarker(s),
    reviewCount: reviewCountByShow[s.id] || 0,
    sinceMs: resolveSinceMs(s),
    // BRO-5506: fetch-all-image-formats skips tours, so dispatch the parent.
    dispatchId: isTourShow(s) && s.tourOf ? s.tourOf : undefined,
  }));

  const marked = normalized.filter((s) => s.noReliableArt && !s.hasImages);
  if (marked.length) console.log(`${marked.length} imageless show(s) are marked noReliableArt and are not re-dispatched.`);
  const flagged = findImagelessScoredShows(normalized.filter((s) => !s.noReliableArt), { nowMs, thresholdHours: DEFAULT_THRESHOLD_HOURS });

  console.log(`${flagged.length} show(s) have reviews but no image on disk after ${DEFAULT_THRESHOLD_HOURS}h.`);
  if (dryRun) {
    for (const f of flagged) console.log(`  - ${f.id} (${f.title}), reviewCount=${f.reviewCount}`);
    return;
  }

  // Self-heal landed: resolveCondition() any escalation alert for a
  // previously-tracked id that now has a CONFIRMED real image (BRO-2765/
  // BRO-2651: the image landed via the twice-weekly archive cron, independent
  // of this script's own dispatch loop, and without this call the
  // alert-ledger entry — and the Linear card it filed — stayed open forever
  // with nothing left to clear it). Keyed off hasImageById (positive
  // hasRealImage() evidence), not "dropped out of `flagged`" — the latter
  // would also fire on a malformed data read or a review-count drop to 0.
  const hasImageById = new Map(normalized.map((s) => [s.id, s.hasImages]));
  for (const clearedId of idsClearedSinceLastRun(prevById, hasImageById)) {
    try {
      const { resolveCondition } = require('./lib/owner-alert-router.js');
      resolveCondition(`imageless-scored-show:still-imageless:${clearedId}`, { reason: 'image landed on disk' });
      resolveCondition(`imageless-scored-show:dispatch-failed:${clearedId}`, { reason: 'image landed on disk' });
    } catch (err) {
      console.error(`resolveCondition (self-heal cleared) failed for ${clearedId}: ${err.message}`);
    }
  }

  // BRO-5022: a previously tracked row the fetcher has since marked
  // noReliableArt is settled (its search only finds wrong art), so its
  // escalation closes rather than staying open with nothing left to clear it.
  for (const m of marked) {
    if (!prevById.has(m.id)) continue;
    try {
      const { resolveCondition } = require('./lib/owner-alert-router.js');
      resolveCondition(`imageless-scored-show:still-imageless:${m.id}`, { reason: 'marked noReliableArt' });
      resolveCondition(`imageless-scored-show:dispatch-failed:${m.id}`, { reason: 'marked noReliableArt' });
    } catch (err) {
      console.error(`resolveCondition (noReliableArt) failed for ${m.id}: ${err.message}`);
    }
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
  // happened. Failures are collected and alerted ONCE per run under a stable
  // rollup key (BRO-5496); per-show keys filed one near-identical card per show.
  const failedShows = [];
  const failedErrors = new Set();
  await executeSelfHealDispatch({
    plan,
    dispatch: dispatchImageFetch,
    nowMs,
    log: (line) => console.log(line),
    onAlert: async ({ show, error }) => {
      failedShows.push({ id: show.id, title: show.title });
      failedErrors.add(String(error));
    },
  });

  const stillImageless = orderedFlagged
    .filter((f) => (entryById.get(f.id).dispatchAttempts || 0) >= ESCALATE_AFTER_ATTEMPTS)
    .map((f) => ({ id: f.id, title: f.title, attempts: entryById.get(f.id).dispatchAttempts }));

  const rollups = [
    { key: IMAGELESS_DISPATCH_FAILED_KEY, items: failedShows, opts: buildDispatchFailedAlert(failedShows, [...failedErrors].join(' | ') || 'unknown'), header: (added) => `More shows hit the failed self-heal dispatch (${added.length} new):` },
    { key: IMAGELESS_STILL_IMAGELESS_KEY, items: stillImageless, opts: buildStillImagelessAlert(stillImageless), header: (added) => `More shows still imageless after repeated self-heal (${added.length} new):` },
  ];
  const { routeAlert, resolveQuietConditions } = require('./lib/owner-alert-router.js');
  // Legacy per-show cards (pre-rollup keys) close through the quiet-gap debounce
  // once their show stops re-firing; the rollup key carries the signal now.
  try {
    const { loadLedger } = require('./lib/owner-alert-router.js');
    const legacy = Object.keys(loadLedger().conditions).filter((k) => k.startsWith('imageless-scored-show:') && !k.endsWith(':all'));
    resolveQuietConditions(legacy, { quietHours: 48, reason: 'folded into rollup alert (BRO-5496)' });
  } catch (err) {
    console.error(`resolveQuietConditions (legacy keys) failed: ${err.message}`);
  }
  for (const r of rollups) {
    try {
      if (!r.opts) {
        resolveQuietConditions([r.key], { quietHours: 48, reason: 'no imageless show in this state' });
        continue;
      }
      const priorMembers = snapshotRollupMembers(r.key);
      const routed = await routeAlert(r.opts);
      await syncRollup({ priorMembers, key: r.key, items: r.items, itemId: (s) => s.id, itemBlock: (s) => `- ${s.title || s.id} (${s.id})`, header: r.header }, routed);
    } catch (err) {
      console.error(`routeAlert (${r.key}) failed: ${err.message}`);
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
