/**
 * aggregator-serp.js — shared cost-control layer for aggregator scrapers'
 * per-show SERP discovery (BRO-764, migrated from Notion 33f637c5).
 *
 * The 2026-04-11 SERP cost reduction plan cut per-review retry spend in
 * collect-review-texts.js and friends but explicitly left aggregator
 * scrapers (scrape-bww-reviews.js, scrape-playbill-verdict.js,
 * scrape-nyc-theatre-roundups.js, scrape-london-box-office-roundups.js) out
 * of scope — each SERPs per-show to discover an aggregator roundup/verdict
 * page URL when its own site search and category-page discovery miss. Three
 * of those four scripts already carry their own lifecycle gate
 * (isClosedShowEligibleForBatchDiscovery, see scripts/lib/discovery-
 * eligibility.js) and their own inline 14-day archive-freshness check —
 * this file does NOT replace that logic (rewriting four independently-tuned
 * discovery pipelines to share one code path risks the kind of regression
 * CLAUDE.md rule 18 exists to catch). What none of the four had before this
 * file: a genuinely PERMANENT skip for a show that has SERP'd and come up
 * empty three runs running — without one, a closed regional show (whose
 * 90-day post-close carve-out already re-tries weekly) or any show whose
 * aggregator simply never covered it burns one SERP call a week forever.
 *
 * Exports three independent, composable pieces — a caller adopts whichever
 * it's missing:
 *   - isEligibleForAggregatorSerp: general-purpose closed-show lifecycle
 *     gate (default 180-day window), for scrapers that don't yet have one
 *     (e.g. scrape-london-box-office-roundups.js's targeted SERP fallback).
 *   - checkArchiveCache: the same "reuse HTML younger than N days" check
 *     every aggregator scraper already duplicates inline, factored out so
 *     new scrapers don't re-copy it a fifth time.
 *   - recordAggregatorSerpAttempt / shouldSkipAggregatorSerp: the 3-strikes
 *     permanent skip. State is disk-persisted (survives across runs, same
 *     as the archive HTML it's tracking) and namespaced by `source` so BWW
 *     and Playbill misses on the same show don't share a counter. All 4
 *     scrapers run as separate workflows on independent schedules and can
 *     overlap in wall-clock time while writing the SAME state file, so
 *     record/reset take a cross-process file-lock (scripts/lib/file-lock.js)
 *     around their load→mutate→save — an unlocked version would let one
 *     workflow's save silently clobber a concurrent update from another.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { withFileLock } = require('./file-lock');

const REPO_ROOT = path.join(__dirname, '..', '..');
// Deliberately under data/aggregator-archive/, NOT data/audit/ — every
// aggregator-scraper workflow runs on an ephemeral ubuntu-latest runner and
// already has checkout-aggregator-archive/push-aggregator-archive wired to
// sync the whole data/aggregator-archive/ tree to/from the private
// broadway-review-texts repo every run. A state file living there rides that
// existing sync for free; one under data/audit/ (no checkout/push action)
// would silently reset to empty every run and the 3-strikes skip would never
// actually persist.
const DEFAULT_STATE_PATH = path.join(REPO_ROOT, 'data', 'aggregator-archive', '_serp-skip-state.json');

const DEFAULT_LIFECYCLE_WINDOW_DAYS = 180;
const DEFAULT_ARCHIVE_TTL_DAYS = 14;
const DEFAULT_MAX_MISSES = 3;

// ── Lifecycle gate ───────────────────────────────────────────────────────────

/**
 * Should this show still be eligible for a per-show aggregator SERP query?
 * Mirrors discovery-eligibility.js's convention: open shows and shows with
 * no recorded closing date are always eligible (unknown treated as recent).
 * A closed show past `windowDays` since closingDate is not — aggregator
 * roundup/verdict pages are frozen once a show closes; a page that hasn't
 * surfaced by then isn't going to.
 */
function isEligibleForAggregatorSerp(show, opts = {}) {
  const windowDays = Number.isFinite(opts.windowDays) ? opts.windowDays : DEFAULT_LIFECYCLE_WINDOW_DAYS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (!show || show.status !== 'closed') return true;
  if (!show.closingDate) return true;
  const closingMs = new Date(show.closingDate).getTime();
  if (Number.isNaN(closingMs)) return true;
  const daysSinceClose = (now - closingMs) / (1000 * 60 * 60 * 24);
  return daysSinceClose <= windowDays;
}

// ── Archive cache check ──────────────────────────────────────────────────────

/**
 * Read a cached aggregator HTML page if it exists and is younger than
 * ttlDays. Returns { fresh: false, html: null } on any miss (no file, stale,
 * or force-bypassed) — callers fall through to SERP/fetch unchanged.
 */
function checkArchiveCache(archivePath, opts = {}) {
  const ttlDays = Number.isFinite(opts.ttlDays) ? opts.ttlDays : DEFAULT_ARCHIVE_TTL_DAYS;
  if (opts.force || !archivePath) return { fresh: false, html: null };
  let stat;
  try {
    stat = fs.statSync(archivePath);
  } catch {
    return { fresh: false, html: null };
  }
  const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
  if (ageDays >= ttlDays) return { fresh: false, html: null };
  try {
    return { fresh: true, html: fs.readFileSync(archivePath, 'utf8') };
  } catch {
    return { fresh: false, html: null };
  }
}

// ── 3-strikes permanent skip state ──────────────────────────────────────────

function _loadState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function _saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, statePath);
}

function _keyFor(source, showId) {
  return `${source}::${showId}`;
}

/**
 * Has this show/source pair already missed `maxMisses` SERP attempts in a
 * row? If so, callers should skip the SERP call entirely (log-and-continue).
 */
function shouldSkipAggregatorSerp(source, showId, opts = {}) {
  const statePath = opts.statePath || DEFAULT_STATE_PATH;
  const state = _loadState(statePath);
  const entry = state[_keyFor(source, showId)];
  return !!(entry && entry.skip_aggregator_serp);
}

/**
 * Record the outcome of a SERP attempt for showId under `source`
 * (e.g. 'bww', 'playbill-verdict', 'nyc-theatre', 'lbo'). A success resets
 * the streak; a miss increments it and flips skip_aggregator_serp once
 * consecutiveMisses reaches maxMisses. Returns the updated entry.
 */
function recordAggregatorSerpAttempt(source, showId, opts = {}) {
  const statePath = opts.statePath || DEFAULT_STATE_PATH;
  const maxMisses = Number.isFinite(opts.maxMisses) ? opts.maxMisses : DEFAULT_MAX_MISSES;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const key = _keyFor(source, showId);

  // Locked: BWW, Playbill Verdict, NYC Theatre, and LBO run as separate
  // workflows (own cron schedules, own concurrency groups) that can overlap
  // in wall-clock time, and all four read-modify-write this SAME state file.
  // An unlocked load→mutate→save here would let one workflow's save clobber
  // another's concurrent update to a different key, silently under-counting
  // misses. withFileLock is the same primitive other cross-process JSON
  // read-modify-write sites in this repo use (fail-open on a stuck lock —
  // see its docstring — so a lock issue degrades to the pre-fix racy
  // behavior, never a hang).
  return withFileLock(`${statePath}.lock`, () => {
    const state = _loadState(statePath);
    const prevMisses = (state[key] && state[key].consecutiveMisses) || 0;

    const entry = opts.success
      ? { consecutiveMisses: 0, skip_aggregator_serp: false, lastAttempt: new Date(now).toISOString(), lastResult: 'hit' }
      : {
          consecutiveMisses: prevMisses + 1,
          skip_aggregator_serp: prevMisses + 1 >= maxMisses,
          lastAttempt: new Date(now).toISOString(),
          lastResult: 'miss',
        };

    state[key] = entry;
    _saveState(statePath, state);
    return entry;
  });
}

/**
 * Clear a show/source's skip state — e.g. a returning production
 * (priorRuns), or a manual re-check after fixing a discovery bug.
 *
 * NOT auto-wired into any scraper's priorRuns handling — a returning
 * production keeps the same showId, so a show that tripped the skip flag
 * under its first run stays flagged after a priorRuns re-open until this is
 * called. Intentionally a manual escape hatch for now (no CLI entry point
 * either): wiring it into the priorRuns declaration path touches multiple
 * scrapers' show-lifecycle logic, which is a separate card, not a SERP-cost
 * change. Call it directly (node -e or a REPL) if a specific show needs its
 * counter cleared.
 */
function resetAggregatorSerpState(source, showId, opts = {}) {
  const statePath = opts.statePath || DEFAULT_STATE_PATH;
  const key = _keyFor(source, showId);
  withFileLock(`${statePath}.lock`, () => {
    const state = _loadState(statePath);
    delete state[key];
    _saveState(statePath, state);
  });
}

module.exports = {
  DEFAULT_STATE_PATH,
  DEFAULT_LIFECYCLE_WINDOW_DAYS,
  DEFAULT_ARCHIVE_TTL_DAYS,
  DEFAULT_MAX_MISSES,
  isEligibleForAggregatorSerp,
  checkArchiveCache,
  shouldSkipAggregatorSerp,
  recordAggregatorSerpAttempt,
  resetAggregatorSerpState,
};
