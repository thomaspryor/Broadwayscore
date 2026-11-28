'use strict';

const fs = require('fs');
const path = require('path');
const { isTestRun } = require('./test-run-guard');

/** @typedef {'review-first-seen'|'review-text-collected'|'scored'|'rebuilt'|'deployed-live'|'excluded'|'held'} Stage */

const DEFAULT_LOG = path.join(__dirname, '../../data/audit/stage-latency.jsonl');

// Rotation: the log is append-only and committed to git, so unbounded growth
// eventually hits GitHub's 100 MiB push limit (2026-07-05: 100.15MB broke
// every data-committing workflow for a day). When the file crosses
// MAX_LOG_BYTES, drop the oldest lines and keep the newest RETAIN_BYTES.
// SLA/latency consumers only need recent days; history is preserved in the
// daily data/audit/opening-night-latency-*.json snapshots.
const MAX_LOG_BYTES = 40 * 1024 * 1024;
const RETAIN_BYTES = 20 * 1024 * 1024;

/**
 * Trim logFile to its newest retainBytes, aligned to a line boundary.
 * Rewrites atomically (tmp + rename) so concurrent readers never see a
 * partial file. A concurrent append between read and rename can lose that
 * one line — acceptable for an audit log, and rotation is rare.
 *
 * @returns {boolean} true if the file was rotated
 */
function rotateIfNeeded(logFile, maxBytes = MAX_LOG_BYTES, retainBytes = RETAIN_BYTES) {
  let size;
  try {
    size = fs.statSync(logFile).size;
  } catch {
    return false; // no file yet
  }
  if (size <= maxBytes) return false;

  const fd = fs.openSync(logFile, 'r');
  let chunk;
  try {
    const start = Math.max(0, size - retainBytes);
    chunk = Buffer.alloc(Math.min(retainBytes, size));
    fs.readSync(fd, chunk, 0, chunk.length, start);
  } finally {
    fs.closeSync(fd);
  }
  // Start at the first complete line
  const nl = chunk.indexOf(0x0a);
  const trimmed = chunk.subarray(nl + 1);
  const tmp = `${logFile}.rotate-tmp-${process.pid}`;
  fs.writeFileSync(tmp, trimmed);
  fs.renameSync(tmp, logFile);
  process.stderr.write(
    `[stage-latency] rotated log: ${size} -> ${trimmed.length} bytes (kept newest lines)\n`
  );
  return true;
}

/**
 * Append one structured JSONL line to the stage-latency log.
 * Safe for concurrent writers — one atomic append per call.
 * Rotates the log first when it exceeds MAX_LOG_BYTES.
 *
 * @param {object} opts
 * @param {string}  opts.showId
 * @param {string}  [opts.reviewKey]   "{outletId}:{critic}:{url}" stable dedup key
 * @param {Stage}   opts.stage
 * @param {string}  [opts.at]          ISO-8601; defaults to now
 * @param {object}  [opts.metadata]    free-form extras (runId, sha, reviewCount, …)
 */
function emitStage({ showId, reviewKey, stage, at, metadata }) {
  // Prevention (2026-07-24): CI unit tests exercise review-file-writer, whose
  // saveReview emits review-first-seen unconditionally. Without STAGE_LATENCY_LOG
  // pointed at a temp file those fixture rows (guard-*, test-show-2026, fake URLs)
  // landed in the committed prod log and the opening-night SLA counted them as
  // "stuck ≥60 min". BSC_STAGE_LATENCY_MUTE=1 (set in test.yml's unit step) makes
  // the emit a no-op UNLESS a test explicitly points STAGE_LATENCY_LOG at its own
  // file — so stage-latency's own tests still work.
  // NODE_TEST_CONTEXT: a local `node --test` run has no test.yml env, and it
  // appended fake 'rebuilt' rows to the tracked log (2026-09-29, as BRO-4220 did
  // for the spend ledger). Node sets it in every test process and its children.
  if ((process.env.BSC_STAGE_LATENCY_MUTE === '1' || isTestRun()) && !process.env.STAGE_LATENCY_LOG) return;

  const logFile = process.env.STAGE_LATENCY_LOG || DEFAULT_LOG;

  const line = JSON.stringify({
    showId,
    reviewKey: reviewKey || null,
    stage,
    at: at || new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  });

  try {
    const dir = path.dirname(logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    rotateIfNeeded(logFile);
    fs.appendFileSync(logFile, line + '\n', { encoding: 'utf8', flag: 'a' });
  } catch (err) {
    // Never block the production pipeline — log to stderr and continue
    process.stderr.write(`[stage-latency] write failed: ${err.message}\n`);
  }
}

// How far back a review-level event keeps its show "tracked". Must comfortably
// exceed the SLA's evaluation horizon (two opening weekends ≈ 14 days) so a
// show whose review is still in flight never drops out of the set while the
// SLA is still watching it.
const TRACKED_WINDOW_DAYS = 21;

// Scan every byte rotation retains. An earlier draft scanned only the newest
// 8 MB, which is a silent starvation bug: rotation keeps 20 MB, so a
// review-level event sitting in retained bytes 8–20 MB is inside the 21-day
// window but invisible to the scan. Its show would drop out of the tracked
// set, stop receiving 'rebuilt' terminals, and its already-delivered review
// would start paging as stuck with nothing to re-add it. Reading what is
// retained costs at most one 20 MB read per rebuild, and after this change the
// log holds ~200 lines/day, so in steady state it is a few hundred KB.
const TRACKED_SCAN_BYTES = RETAIN_BYTES;

const REVIEW_LEVEL_STAGES = new Set(['review-first-seen', 'review-text-collected', 'scored']);

/**
 * Show IDs with a review-level stage event in the recent window — i.e. the
 * shows the opening-night SLA could currently be watching.
 *
 * rebuild-all-reviews uses this to decide which shows get a per-show 'rebuilt'
 * terminal. Emitting one for all ~1,210 shows with reviews was 99.87% of the
 * log and rotated the review history away every ~3.5 days (task #388); emitting
 * one for NO show would silently clear nothing and page everything. Scoping to
 * tracked shows keeps the terminal exactly as informative as before for every
 * show that can have an in-flight review, at ~5% of the volume.
 *
 * @param {object} [opts]
 * @param {string} [opts.logFile]
 * @param {Date}   [opts.now]
 * @param {number} [opts.days=21]
 * @returns {Set<string>}
 */
function readTrackedShowIds({ logFile, now = new Date(), days = TRACKED_WINDOW_DAYS, scanBytes = TRACKED_SCAN_BYTES } = {}) {
  const file = logFile || process.env.STAGE_LATENCY_LOG || DEFAULT_LOG;
  const out = new Set();

  let text;
  let truncated = false;
  try {
    // Open FIRST, then fstat the open descriptor. Sizing from a separate
    // statSync(path) races rotateIfNeeded(), which replaces the file via
    // tmp+rename: a 40 MB stat followed by a read of the renamed-in 20 MB file
    // would seek past EOF, return a zero-filled buffer, and yield an EMPTY
    // tracked set — i.e. every show silently loses its 'rebuilt' terminal for
    // that run. fstat binds the size to the same inode we go on to read.
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - scanBytes);
      const want = Math.min(scanBytes, size);
      const buf = Buffer.alloc(want);
      // Honour the ACTUAL byte count — a short read must not be padded with
      // NUL bytes and parsed as if it were log content.
      const bytesRead = fs.readSync(fd, buf, 0, want, start);
      text = buf.subarray(0, bytesRead).toString('utf8');
      // Drop a partial first line when we started mid-file.
      if (start > 0) {
        truncated = true;
        const nl = text.indexOf('\n');
        text = nl === -1 ? '' : text.slice(nl + 1);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    // ENOENT (no log yet) is normal on a fresh checkout — nothing is tracked.
    if (err && err.code !== 'ENOENT') {
      process.stderr.write(`[stage-latency] tracked-show scan failed: ${err.message}\n`);
    }
    return out;
  }

  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  let oldestSeen = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || !e.at) continue;
    if (!oldestSeen || e.at < oldestSeen) oldestSeen = e.at;
    if (!e.showId) continue;
    if (!REVIEW_LEVEL_STAGES.has(e.stage)) continue;
    if (e.at < cutoff) continue;
    out.add(e.showId);
  }

  // Say so when the scan could not actually see the whole window. If the
  // oldest line we read is NEWER than the cutoff, older events exist that we
  // never looked at, so a show could be silently missing from the set — which
  // costs it its 'rebuilt' terminal and makes its delivered review page as
  // stuck. Better a loud line in the rebuild log than a monitor that quietly
  // narrows and nobody notices (the vacuous-gate class).
  if (truncated && oldestSeen && oldestSeen > cutoff) {
    process.stderr.write(
      `[stage-latency] WARNING: tracked-show scan covered only back to ${oldestSeen}, `
      + `but the ${days}-day window starts at ${cutoff}. Shows whose only recent activity `
      + `predates the scanned region will not receive a 'rebuilt' terminal this run.\n`
    );
  }
  return out;
}

/**
 * Which shows get a per-show 'rebuilt' terminal this run.
 *
 * Extracted from rebuild-all-reviews.js so the decision is testable (CLAUDE.md
 * rule 15) — inline, an inverted condition or a deleted guard here would ship
 * with zero test failure while either flooding the log again or, worse,
 * emitting terminals for nobody and paging every in-flight review.
 *
 * @param {string[]|Iterable<string>} showIdsWithReviews shows present in reviews.json
 * @param {Set<string>} trackedShowIds from readTrackedShowIds()
 * @returns {string[]} intersection, in input order
 */
function selectTerminalShowIds(showIdsWithReviews, trackedShowIds) {
  const tracked = trackedShowIds instanceof Set ? trackedShowIds : new Set(trackedShowIds || []);
  const out = [];
  for (const showId of showIdsWithReviews || []) {
    if (tracked.has(showId)) out.push(showId);
  }
  return out;
}

// Exclusion reasons (rebuild-all-reviews.js logExclusion stat keys) that mean
// "the pipeline looked at this item and decided it is not a review of this
// show". rebuild emits a per-review 'excluded' stage for these, and the SLA
// treats that as a terminal. Without it a junk discovery (a Rolling Stone
// concert review filed under a show, a news story, a listing page) has no
// terminal stage and pages as "stuck" until the log rotates: on 2026-10-15
// all 3 paged reviews were exactly that (BRO-5427).
//
// This is an ALLOW-list on purpose. Reasons that mean "not yet" (skippedNoScore,
// pre-opening holds, processing errors, unvalidated domains, suspected
// misattribution, bodyless aggregator scores) are left out so a real review
// stalled behind them keeps paging, and a new reason added to rebuild later
// stays page-worthy until someone decides otherwise.
const TERMINAL_EXCLUSION_REASONS = new Set([
  'skippedBlockedUrl', 'skippedCancelledBeforeOpening', 'skippedCombinedReviewOfOtherMemberOnly',
  'skippedCrossMarket', 'skippedCrossOutletDupe', 'skippedCrossOutletDuplicateUrl',
  'skippedCrossOutletFingerprintDedup', 'skippedCrossShowDupe', 'skippedCrossShowUrl',
  'skippedDirectorMismatch', 'skippedFabricated', 'skippedFilmTvContamination',
  'skippedFullTextWrongAuthor', 'skippedGarbage', 'skippedInvalidUrl', 'skippedListingPage',
  'skippedLlmRejected', 'skippedNamedNonReviewUrl', 'skippedNonReview', 'skippedNotReview',
  'skippedPersonalRepost', 'skippedPreviewFirstLookPiece', 'skippedRejectedAt',
  'skippedRejectionReason', 'skippedRoundup', 'skippedSyndicated', 'skippedTourContamination',
  'skippedUrlPathCrossMarket', 'skippedUrlYearMismatch', 'skippedUrlYearStandalone',
  'skippedWrongAttribution', 'skippedWrongContent', 'skippedWrongProduction', 'skippedWrongShow',
]);
// Deliberately NOT terminal (ship-check, BRO-5427):
// - same-identity dedups (skippedDuplicateUrl/Of/Text, skippedWithinShowDupe,
//   skippedFingerprintDedup*, skipped*CriticDedup/OutletDedup, *Twin,
//   skippedCircularDuplicateTiebreak): the loser shares show+outlet+url with
//   the KEPT file, so its 'excluded' line would silence the kept review too.
// - skippedDateMismatch / skippedLateDateMismatch: fire on a mis-parsed
//   publishDate or a stale openingDate, i.e. a real review behind bad data.
// Text-quality reasons are terminal only once the pipeline has given up on
// the file (fetchDiscoveryAbandoned); before that they mean "re-collect".
const TERMINAL_WHEN_ABANDONED_REASONS = new Set([
  'skippedScraperGarbage', 'skippedShowNotMentioned', 'skippedCorrupted',
]);

// Only reviews first seen inside the tracked window get an 'excluded' line.
// createExcludedStageEmitter writes each review once, so volume is bounded by
// new excluded discoveries, not by rebuild frequency. The window matches
// TRACKED_WINDOW_DAYS: a junk item found in previews, weeks before its show
// enters the checklist window, still needs its terminal when the show does.
const EXCLUDED_STAGE_WINDOW_MS = TRACKED_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Should rebuild emit a per-review 'excluded' terminal for this exclusion?
 * @param {string} reason  logExclusion stat key
 * @param {object} data    review-text file contents
 * @param {Date}   [now]
 */
function shouldEmitExcludedStage(reason, data, now = new Date()) {
  if (!data || !data.url || !data.firstSeenAt || !data.outletId) return false;
  const terminal = TERMINAL_EXCLUSION_REASONS.has(reason)
    || (TERMINAL_WHEN_ABANDONED_REASONS.has(reason) && data.fetchDiscoveryAbandoned === true);
  if (!terminal) return false;
  const seen = Date.parse(data.firstSeenAt);
  if (!Number.isFinite(seen)) return false;
  return now.getTime() - seen <= EXCLUDED_STAGE_WINDOW_MS;
}

function normalizeReviewUrl(url) {
  return String(url || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '')
    .replace(/#.*$/, '')
    // Drop tracking params only: a query string can be the review's identity
    // (WordPress ?p=123), so it is not stripped wholesale.
    .replace(/([?&])(utm_[a-z]+|fbclid|gclid|ref|cmpid)=[^&]*/g, '$1')
    .replace(/[?&]+$/, '').replace(/\?&+/, '?')
    .replace(/\/+(\?|$)/, '$1');
}

/**
 * Identity of a review for matching stages across emitters. reviewKey is
 * "{outletId}:{critic}:{url}", but the critic part is not stable: the
 * first-seen line can say "unknown" or "neil-griffiths" while a later stage
 * says "Neil Griffiths" after byline enrichment. Match on show + outlet + url.
 */
function reviewIdentity(showId, reviewKey) {
  const s = String(reviewKey || '');
  const i = s.indexOf(':');
  if (i < 0) return null;
  const j = s.indexOf(':', i + 1);
  if (j < 0) return null;
  const rest = s.slice(j + 1);
  // "outlet:https://x" (no critic segment) splits inside the scheme; refuse it
  // rather than produce a url that silently never matches.
  if (rest.startsWith('//')) return null;
  const url = normalizeReviewUrl(rest);
  if (!url) return null;
  return `${showId}||${s.slice(0, i).toLowerCase()}||${url}`;
}

// Show-level "held, not open yet" (BRO-5480). rebuild skips an upcoming or
// in-previews show wholesale, before any per-file decision, so its reviews get
// neither a 'rebuilt' nor an 'excluded' terminal. On 2026-10-16 three
// wrongProduction finds for an upcoming West End show paged as "stuck" for
// 11+ hours. rebuild emits one 'held' line per tracked held show per run;
// the SLA treats a review as held while a FRESH line exists (the show is
// still not open), so the line stops counting soon after the show opens.
const SHOW_HELD_REASONS = new Set(['skippedUpcomingShows', 'skippedPreviewsShows']);
const HELD_FRESH_MS = 2 * 60 * 60 * 1000;

/**
 * Is `now` (UTC) strictly before the show's opening date? Only then is a
 * wholesale pre-opening skip a "held" show; on opening day itself reviews are
 * due, so a still-'previews' status must not mute them.
 * @param {string} openingDate 'YYYY-MM-DD' (or ISO)
 */
function isBeforeOpeningDate(openingDate, now = new Date()) {
  const d = String(openingDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  return now.toISOString().slice(0, 10) < d;
}

/**
 * Does a wholesale pre-opening skip count as "held"? Before the opening date,
 * yes. An 'upcoming' show with no usable opening date has not opened either.
 * A 'previews' show with no date, or any show on/after its opening date, is
 * not held: its reviews are due (or overdue) and must page if stuck.
 */
function isHeldBeforeOpening(statKey, openingDate, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(openingDate || ''))) return statKey === 'skippedUpcomingShows';
  return isBeforeOpeningDate(openingDate, now);
}

/** Latest show-level 'held' timestamp per show. */
function latestShowHeldAt(entries) {
  const out = new Map();
  for (const e of entries || []) {
    if (!e || e.stage !== 'held' || !e.showId || e.reviewKey) continue;
    const prev = out.get(e.showId);
    if (!prev || e.at > prev) out.set(e.showId, e.at);
  }
  return out;
}

/** Is the show still held (not open) as of `now`, per a held line at/after firstSeen? */
function isShowHeld(heldAt, firstSeen, now = new Date()) {
  if (!heldAt || !firstSeen || heldAt < firstSeen) return false;
  return now.getTime() - Date.parse(heldAt) <= HELD_FRESH_MS;
}

/**
 * Identities of reviews rebuild excluded as not-a-review-of-this-show (an
 * 'excluded' stage line). Consumers that count reviews (the opening-night SLA,
 * time-to-publish) skip these.
 * @param {object[]} entries parsed stage-latency lines
 * @returns {Set<string>}
 */
function excludedReviewIdentities(entries) {
  // An exclusion stops counting once the review is collected or re-seen after
  // it (a cleared flag, a re-fetch): the next rebuild re-decides, and until
  // then the review is back in flight (ship-check, BRO-5427).
  const lastExcluded = new Map();
  const lastActivity = new Map();
  for (const e of entries || []) {
    if (!e || !e.showId || !e.reviewKey || !e.at) continue;
    const isExcl = e.stage === 'excluded';
    if (!isExcl && e.stage !== 'review-text-collected' && e.stage !== 'review-first-seen') continue;
    const id = reviewIdentity(e.showId, e.reviewKey);
    if (!id) continue;
    const m = isExcl ? lastExcluded : lastActivity;
    if (!m.has(id) || e.at > m.get(id)) m.set(id, e.at);
  }
  const out = new Set();
  for (const [id, at] of lastExcluded) {
    const act = lastActivity.get(id);
    if (!act || at >= act) out.add(id);
  }
  return out;
}

/**
 * One 'excluded' line per review, ever. rebuild runs every ~30 min and calls
 * logExclusion for every excluded file each time, so emitting on every call
 * would write ~hundreds of lines per run (the task #388 flood). The first call
 * reads the existing 'excluded' identities from the log once; later calls only
 * consult the in-process set.
 *
 * @param {object} [opts]
 * @param {string} [opts.logFile]
 * @param {function} [opts.emit=emitStage]
 * @returns {(showId: string, reason: string, data: object, reviewKey: string) => boolean}
 *          emits when needed; returns true when a line was written
 */
function createExcludedStageEmitter({ logFile, emit = emitStage, now } = {}) {
  let seen = null;
  const load = () => {
    const file = logFile || process.env.STAGE_LATENCY_LOG || DEFAULT_LOG;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { seen = new Set(); return; }
    const wanted = [];
    for (const line of text.split('\n')) {
      if (!line.includes('"excluded"') && !line.includes('"review-text-collected"') && !line.includes('"review-first-seen"')) continue;
      try { wanted.push(JSON.parse(line)); } catch { /* skip */ }
    }
    // Same rule the SLA reads with: a superseded exclusion is re-emitted.
    seen = excludedReviewIdentities(wanted);
  };
  return function maybeEmitExcluded(showId, reason, data, reviewKey) {
    if (!shouldEmitExcludedStage(reason, data, now || new Date())) return false;
    const id = reviewIdentity(showId, reviewKey);
    if (!id) return false;
    if (!seen) load();
    if (seen.has(id)) return false;
    seen.add(id);
    emit({ showId, reviewKey, stage: 'excluded', metadata: { reason } });
    return true;
  };
}

module.exports = {
  emitStage,
  SHOW_HELD_REASONS,
  HELD_FRESH_MS,
  latestShowHeldAt,
  isShowHeld,
  isBeforeOpeningDate,
  isHeldBeforeOpening,
  createExcludedStageEmitter,
  excludedReviewIdentities,
  reviewIdentity,
  shouldEmitExcludedStage,
  TERMINAL_EXCLUSION_REASONS,
  TERMINAL_WHEN_ABANDONED_REASONS,
  EXCLUDED_STAGE_WINDOW_MS,
  rotateIfNeeded,
  readTrackedShowIds,
  selectTerminalShowIds,
  MAX_LOG_BYTES,
  RETAIN_BYTES,
  TRACKED_WINDOW_DAYS,
  REVIEW_LEVEL_STAGES,
};
