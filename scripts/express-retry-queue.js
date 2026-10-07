#!/usr/bin/env node
/**
 * express-retry-queue.js — CLI for the Opening Night Express same-night
 * retry (card #1889).
 *
 *   evaluate --show=ID --market=broadway [--is-retry=true] [--retry-delay-hours=16]
 *     Called by opening-night-express.yml right after its "Collect review
 *     texts" step. Reads data/review-texts/{show}/*.json off local disk and
 *     decides whether this run's coverage looks too thin to trust:
 *       - first run + thin  -> enqueue a retry into data/audit/express-retry-queue.json
 *       - retry run + still thin -> route an alert (weekly recollect-for-scores.yml
 *         is the ultimate backstop, but the operator should know sooner)
 *       - coverage already complete (isShowCoverageComplete) -> no-op either way
 *     No-ops otherwise. Never throws — prints its decision and exits 0.
 *
 *   dispatch-due
 *     Called by opening-night-express-retry-check.yml's hourly cron. Reads
 *     the queue, and for every entry due (dueAt <= now) and not yet
 *     attempted: skips if isShowCoverageComplete() already (some other path —
 *     the hourly poller, audit-aggregator-gap, or the local opening-night
 *     monitor — already closed the gap), else dispatches
 *     opening-night-express.yml with is_retry=true. Marks attempted ONLY
 *     after a successful dispatch or skip decision; a failed dispatch call
 *     leaves the entry un-attempted so the next hourly tick retries the
 *     DISPATCH itself (never silently swallowed — memory/
 *     feedback_silent_workflow_failures.md). Prunes entries older than 3
 *     days, alerting first for any that never successfully dispatched
 *     (persistent failure, not a transient blip). Writes the queue back to
 *     disk.
 *
 * The queue file is only committed AFTER a dispatch call succeeds (same
 * dispatch-then-mark tradeoff as scripts/dispatch-orphan-rescore-requeue.js):
 * if this job dies between a successful dispatch and the commit landing, the
 * next tick sees the entry as still due and dispatches again. A duplicate
 * Express run for the same show is wasted scraper spend, not data corruption
 * — Express's own per-show concurrency group queues it rather than racing.
 *
 * showId is whatever value opening-night-express.yml was originally invoked
 * with (inputs.show_id) — it flows unchanged from the auto-fire dispatch
 * through evaluate's enqueue into dispatch-due's re-dispatch, so it's never
 * independently re-resolved as an id vs. a slug mid-flight. loadShow()'s
 * id-or-slug lookup is only for the isShowCoverageComplete() guard's `show`
 * argument, not the queue key.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  shouldRetryExpress,
  enqueueRetry,
  selectDueRetries,
  markAttempted,
  pruneStale,
  DEFAULT_RETRY_DELAY_HOURS,
  isThinCoverageEntry,
  isTruncatedRefetchEntry,
  findTruncatedT1Shows,
  planTruncatedRefetches,
  markEntryAttempted,
} = require('./lib/express-retry-decision');
const { isShowCoverageComplete } = require('./lib/opening-night-readiness');
const { dispatchExpressRetry } = require('./lib/dispatch-express-retry');

const REPO_ROOT = path.resolve(__dirname, '..');
const QUEUE_PATH = path.join(REPO_ROOT, 'data', 'audit', 'express-retry-queue.json');
const REVIEW_TEXTS_DIR = path.join(REPO_ROOT, 'data', 'review-texts');
const SHOWS_PATH = path.join(REPO_ROOT, 'data', 'shows.json');
const REVIEWS_PATH = path.join(REPO_ROOT, 'data', 'reviews.json');

function readQueueEntries() {
  try {
    const parsed = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function writeQueueEntries(entries) {
  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  const tmp = `${QUEUE_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2) + '\n');
  fs.renameSync(tmp, QUEUE_PATH);
}

function loadShow(showId) {
  try {
    const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const list = Array.isArray(shows.shows) ? shows.shows : shows;
    return list.find((s) => s.id === showId || s.slug === showId) || null;
  } catch {
    return null;
  }
}

function loadReviewFiles(showId) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadShowsList() {
  try {
    const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    return Array.isArray(shows.shows) ? shows.shows : shows;
  } catch {
    return [];
  }
}

function loadReviewsList() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
    return Array.isArray(parsed.reviews) ? parsed.reviews : Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** BRO-4334: shows in their opening window with truncated Tier-1 reviews. */
function currentTruncatedT1Shows(nowIso) {
  const { getTier } = require('./lib/outlet-tiers');
  return findTruncatedT1Shows({ reviews: loadReviewsList(), shows: loadShowsList(), nowIso, getTier });
}

function arg(name, def) {
  const pfx = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pfx));
  return hit ? hit.slice(pfx.length) : def;
}

async function routeStillThinAlert(showId, market, reason) {
  try {
    const { routeAlert } = require('./lib/owner-alert-router');
    await routeAlert({
      conditionKey: `express-retry-still-thin:${showId}`,
      title: `Opening Night Express retry still found thin review coverage for ${showId}`,
      description: `The early auto-fire found next to nothing, and the same-night retry (${reason}) still hasn't closed the gap. Full-text upgrade will otherwise wait on the weekly recollect-for-scores.yml cron.`,
      hint: `node scripts/verify-review-recovery.js --show=${showId} --production   # check what's still missing, then collect/ingest manually`,
      severity: 'warn',
      disposition: 'digest',
      cooldownHours: 24 * 7,
    });
  } catch (err) {
    console.error(`[express-retry-queue] routeAlert failed: ${err.message}`);
  }
}

async function routeRefetchNeverFiredAlert(showId, lostEntries) {
  try {
    const { routeAlert } = require('./lib/owner-alert-router');
    const outlets = [...new Set(lostEntries.flatMap((e) => e.outletIds || []))].join(', ') || 'Tier-1 outlets';
    await routeAlert({
      conditionKey: `truncated-t1-refetch-never-fired:${showId}`,
      title: `Truncated Tier-1 review refetch never dispatched for ${showId}`,
      description: `The +${lostEntries.map((e) => e.offsetHours).join('h/+')}h refetch(es) of truncated ${outlets} text failed to dispatch on every hourly attempt for 3 days — those reviews may still be scored off partial text.`,
      hint: `node scripts/verify-review-recovery.js --show=${showId} --production   # then re-collect the truncated reviews manually`,
      severity: 'warn',
      disposition: 'digest',
      cooldownHours: 24 * 7,
    });
  } catch (err) {
    console.error(`[express-retry-queue] routeAlert failed: ${err.message}`);
  }
}

async function cmdEvaluate() {
  const showId = arg('show');
  const market = arg('market', 'broadway');
  const isRetry = arg('is-retry', 'false') === 'true';
  const delayHours = Number(arg('retry-delay-hours', String(DEFAULT_RETRY_DELAY_HOURS))) || DEFAULT_RETRY_DELAY_HOURS;
  if (!showId) {
    console.error('[express-retry-queue] --show is required');
    process.exit(1);
  }

  const show = loadShow(showId);
  if (isShowCoverageComplete(showId, market, show)) {
    console.log(`[express-retry-queue] ${showId}: coverage already complete — nothing to do`);
    return;
  }

  const reviewFiles = loadReviewFiles(showId);
  const decision = shouldRetryExpress({ reviewFiles, show, isRetry });
  console.log(`[express-retry-queue] ${showId}: retry=${decision.retry} thin=${decision.thin} — ${decision.reason}`);

  if (isRetry) {
    if (decision.thin) await routeStillThinAlert(showId, market, decision.reason);
    return;
  }
  if (!decision.retry) return;

  const nowIso = new Date().toISOString();
  const current = readQueueEntries();
  const { entries, changed } = enqueueRetry(current, { showId, market, nowIso, delayHours });
  if (changed) {
    writeQueueEntries(entries);
    console.log(`[express-retry-queue] queued retry for ${showId}, due ${entries[entries.length - 1].dueAt}`);
  } else {
    console.log(`[express-retry-queue] ${showId} already has an outstanding retry queued — not duplicating`);
  }
}

async function cmdDispatchDue() {
  const nowIso = new Date().toISOString();
  let entries = readQueueEntries();

  // BRO-4334: schedule +1h/+3h/+12h refetches for truncated T1 reviews of
  // shows in their opening window (idempotent per show).
  const truncatedShows = currentTruncatedT1Shows(nowIso);
  const plan = planTruncatedRefetches(entries, truncatedShows, nowIso);
  let dirty = plan.changed;
  entries = plan.entries;
  for (const showId of plan.planned) {
    const c = truncatedShows.find((x) => x.showId === showId);
    console.log(`[express-retry-queue] ${showId}: truncated T1 text (${c.outletIds.join(', ')}) — scheduled refetches at +1h/+3h/+12h`);
  }

  const due = selectDueRetries(entries, nowIso);
  if (!due.length) {
    console.log('[express-retry-queue] nothing due');
    if (dirty) writeQueueEntries(pruneStale(entries, nowIso));
    return;
  }

  const dispatchedShows = new Set();
  for (const entry of due.filter(isThinCoverageEntry)) {
    const show = loadShow(entry.showId);
    if (isShowCoverageComplete(entry.showId, entry.market, show)) {
      console.log(`[express-retry-queue] ${entry.showId}: coverage already complete — skipping retry dispatch`);
      entries = markAttempted(entries, entry.showId, entry.queuedAt, nowIso, {
        skipped: true,
        skipReason: 'coverage-already-complete',
      });
      continue;
    }
    console.log(`[express-retry-queue] dispatching retry for ${entry.showId} (queued ${entry.queuedAt}, due ${entry.dueAt})`);
    const result = await dispatchExpressRetry(entry.showId, entry.market);
    if (!result.ok) {
      console.error(`[express-retry-queue] dispatch failed for ${entry.showId}: ${result.error} — leaving un-attempted for next tick`);
      continue;
    }
    dispatchedShows.add(entry.showId);
    entries = markAttempted(entries, entry.showId, entry.queuedAt, nowIso);
  }

  // Truncated-T1 refetches: one Express retry run per show per tick,
  // however many of its offsets are due; skipped once nothing is truncated.
  const stillTruncated = new Set(truncatedShows.map((c) => c.showId));
  const refetchDue = due.filter(isTruncatedRefetchEntry);
  for (const showId of [...new Set(refetchDue.map((e) => e.showId))]) {
    const showEntries = refetchDue.filter((e) => e.showId === showId);
    let extra = {};
    if (!stillTruncated.has(showId)) {
      console.log(`[express-retry-queue] ${showId}: no truncated T1 reviews left — skipping refetch`);
      extra = { skipped: true, skipReason: 'no-truncated-t1' };
    } else if (dispatchedShows.has(showId)) {
      console.log(`[express-retry-queue] ${showId}: Express retry already dispatched this tick — refetch rides along`);
      extra = { skipped: true, skipReason: 'express-retry-same-tick' };
    } else {
      console.log(`[express-retry-queue] dispatching truncated-T1 refetch for ${showId} (+${showEntries.map((e) => e.offsetHours).join('h/+')}h)`);
      // Plain is_retry Express run (gather + collect + score). The collector
      // re-fetches truncated reviews (and, in the opening window, hard-paywall
      // texts that fail the completeness check) while skipping complete ones.
      const result = await dispatchExpressRetry(showId, showEntries[0].market);
      if (!result.ok) {
        console.error(`[express-retry-queue] refetch dispatch failed for ${showId}: ${result.error} — leaving un-attempted for next tick`);
        continue;
      }
      dispatchedShows.add(showId);
    }
    for (const e of showEntries) entries = markEntryAttempted(entries, e, nowIso, extra);
  }

  const pruned = pruneStale(entries, nowIso);
  // An entry can only reach here un-attempted if EVERY hourly dispatch
  // attempt failed for 3 straight days (a persistently broken token/API, not
  // a transient blip) — pruneStale would otherwise have silently dropped it
  // with zero operator visibility right as this tick was about to try again.
  const droppedWithoutDispatch = entries.filter(
    (e) => isThinCoverageEntry(e) && !e.attempted && !pruned.some((p) => p.showId === e.showId && p.queuedAt === e.queuedAt)
  );
  for (const entry of droppedWithoutDispatch) {
    console.error(`[express-retry-queue] ${entry.showId}: queued ${entry.queuedAt} never dispatched after 3 days — dropping and alerting`);
    await routeStillThinAlert(entry.showId, entry.market, 'retry dispatch failed on every attempt for 3 days — never fired');
  }
  // BRO-4334: same visibility for truncated-T1 refetches that never fired.
  const droppedRefetches = entries.filter((e) => isTruncatedRefetchEntry(e) && !e.attempted && !pruned.includes(e));
  for (const showId of [...new Set(droppedRefetches.map((e) => e.showId))]) {
    const lost = droppedRefetches.filter((e) => e.showId === showId);
    console.error(`[express-retry-queue] ${showId}: ${lost.length} truncated-T1 refetch(es) never dispatched after 3 days — dropping and alerting`);
    await routeRefetchNeverFiredAlert(showId, lost);
  }

  writeQueueEntries(pruned);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'evaluate') return cmdEvaluate();
  if (cmd === 'dispatch-due') return cmdDispatchDue();
  console.error('Usage: express-retry-queue.js <evaluate|dispatch-due> [...args]');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[express-retry-queue] fatal: ${err.message}`);
  process.exit(1);
});
