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
const { findImagelessScoredShows, DEFAULT_THRESHOLD_HOURS } = require('./lib/image-trigger-guard.js');
const { dispatchImageFetch } = require('./lib/dispatch-image-fetch.js');

const USAGE = `Usage: node scripts/audit-imageless-scored-shows.js [--dry-run]
  --dry-run    Compute + print findings, skip dispatch/alert/write.
`;

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'audit', 'imageless-scored-shows.json');
const COOLDOWN_HOURS = 12; // min gap between re-dispatch attempts for the same show
const ESCALATE_AFTER_ATTEMPTS = 3; // self-heal dispatched 3x and still imageless -> alert
// Real-corpus dry-run (2026-08-14) found 71 pre-existing imageless shows —
// dispatching all of them in one run would flood the fetch-images
// concurrency group (cancel-in-progress:false) exactly like the dispatch
// storm the plan review warned about, just fanned out across shows instead
// of across time. Cap + prioritize newest-first: THIS card is about a new
// show going live, not draining the historical backlog — that backlog still
// drains gradually across cycles (and via the twice-weekly full sweep).
const MAX_DISPATCHES_PER_RUN = 5;

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function resolveSinceMs(show) {
  const raw = show.discoveredAt || show.openingDate || show.previewsStartDate;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
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

  const nextLedger = [];
  let dispatchesThisRun = 0;
  for (const f of orderedFlagged) {
    const prev = prevById.get(f.id) || { firstFlaggedAt: new Date(nowMs).toISOString(), dispatchAttempts: 0, lastDispatchedAt: null };
    const cooldownOk = !prev.lastDispatchedAt || (nowMs - Date.parse(prev.lastDispatchedAt)) >= COOLDOWN_HOURS * 3600 * 1000;
    const underCap = dispatchesThisRun < MAX_DISPATCHES_PER_RUN;

    let entry = { ...prev, id: f.id, title: f.title };

    if (cooldownOk && !underCap) {
      console.log(`… ${f.id} due for dispatch but MAX_DISPATCHES_PER_RUN=${MAX_DISPATCHES_PER_RUN} reached this cycle — picked up next run`);
    } else if (cooldownOk) {
      dispatchesThisRun++;
      const result = await dispatchImageFetch(f.id);
      if (result.ok) {
        entry.dispatchAttempts = (prev.dispatchAttempts || 0) + 1;
        entry.lastDispatchedAt = new Date(nowMs).toISOString();
        console.log(`✓ self-heal dispatched for ${f.id} (attempt ${entry.dispatchAttempts})`);
      } else {
        console.error(`✗ self-heal dispatch failed for ${f.id}: ${result.error}`);
        try {
          const { routeAlert } = require('./lib/owner-alert-router.js');
          await routeAlert({
            conditionKey: `imageless-scored-show:dispatch-failed:${f.id}`,
            title: `Image-fetch self-heal dispatch failed for ${f.title || f.id}`,
            description: `${f.title || f.id} has reviews but no image on disk, and the automatic fetch-all-image-formats.yml dispatch itself failed: ${result.error}`,
            hint: `Check GITHUB_TOKEN/GH_TOKEN scope for actions:write, then re-run: gh workflow run fetch-all-image-formats.yml -f show_id=${f.id}`,
            severity: 'error',
            disposition: 'auto',
            cooldownHours: 24,
          });
        } catch (err) {
          console.error(`routeAlert failed: ${err.message}`);
        }
      }
    }

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

    nextLedger.push(entry);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    generatedAt: new Date(nowMs).toISOString(),
    thresholdHours: DEFAULT_THRESHOLD_HOURS,
    cooldownHours: COOLDOWN_HOURS,
    escalateAfterAttempts: ESCALATE_AFTER_ATTEMPTS,
    maxDispatchesPerRun: MAX_DISPATCHES_PER_RUN,
    flagged: nextLedger,
  }, null, 2) + '\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
