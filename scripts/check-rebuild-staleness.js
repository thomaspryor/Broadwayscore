#!/usr/bin/env node
/**
 * check-rebuild-staleness.js — post-rebuild guard for the stale-checkout race
 * (a review-texts push landing between rebuild-reviews.yml's checkout step
 * and its "Rebuild reviews.json" step exits 0 with an incomplete
 * reviews.json — see scripts/lib/rebuild-staleness-guard.js).
 *
 * Scope: ONLY the show ids the workflow determined drifted during this job
 * (git diff between the checkout-time SHA and the pre-rebuild SHA), not the
 * full ~2,800-show corpus — see rebuild-reviews.yml for how that list is
 * produced. For each drifted show, walks its review-texts files and asks the
 * SAME functions rebuild-all-reviews.js actually calls whether the file
 * would be included: isIncludableForRebuild (review-guards.js) AND
 * getBestScore() (rebuild-helpers.js) — never a reimplementation, per
 * memory/feedback_includability_predicates_must_be_canonical.md. If a show
 * has a file that passes both but reviews.json has zero entries for that
 * show, the rebuild silently dropped it — fail the job loudly.
 *
 * Also mirrors two more of rebuild-all-reviews.js's pre-scoring steps so a
 * drifted-but-legitimately-excluded file isn't misread as a dropped show:
 * applyScoreRelevantMigrations() (normalizes aggregator-source scores /
 * recovers garbage-text before getBestScore() decides) and the unflagged
 * syndication-SECONDARY dedup (KNOWN_SYNDICATION_PAIRS,
 * scripts/lib/syndication-pairs.js — a secondary copy is excluded only when
 * an unflagged PRIMARY sibling, by filename prefix, exists for the same
 * critic).
 *
 * Usage: node scripts/check-rebuild-staleness.js --shows-file=<path>
 *   <path> is a newline-delimited list of candidate show ids. Missing/empty
 *   file = no drift this run = fast no-op exit 0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { isIncludableForRebuild } = require('./lib/review-guards');
const { getBestScore, applyScoreRelevantMigrations } = require('./lib/rebuild-helpers');
const { normalizeOutlet } = require('./lib/review-normalization');
const { getSyndicationConfig } = require('./lib/syndication-pairs');
const { findMissingScoreableShows } = require('./lib/rebuild-staleness-guard');
// BRO-545 (pipeline self-healing): this guard is right to fail loud on its
// first occurrence, but must not be allowed to wedge reviews.json indefinitely
// if the same drift keeps recurring — see guard-escalation.js header.
const {
  nextGuardState,
  shouldAutoRecover,
  shouldEscalate,
  buildOverrideCommand,
  buildGuardBlockedAlert,
} = require('./lib/guard-escalation');

const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
// Committed alongside the other per-run audit files (rebuild-reviews.yml's
// commit step does `git add data/audit/*.json`) so the streak survives across
// CI checkouts — a fresh checkout every run means this guard has no memory
// unless its state is git-tracked.
const GUARD_STATE_FILE = path.join(DATA_DIR, 'audit', 'guard-escalation-state.json');
const GUARD_ID = 'stale-checkout-staleness';
const WORKFLOW_DISPLAY_NAME = 'Rebuild Reviews Data';
const ALERT_CONDITION_KEY = `guard-escalation:${GUARD_ID}`;

function loadGuardState() {
  const doc = loadJSON(GUARD_STATE_FILE, {});
  return (doc && doc[GUARD_ID]) || null;
}

function saveGuardState(state) {
  const doc = loadJSON(GUARD_STATE_FILE, {});
  doc[GUARD_ID] = state;
  try {
    fs.mkdirSync(path.dirname(GUARD_STATE_FILE), { recursive: true });
    fs.writeFileSync(GUARD_STATE_FILE, JSON.stringify(doc, null, 2) + '\n');
  } catch (e) {
    console.error(`::warning::[check-rebuild-staleness] could not persist guard-escalation state: ${e.message}`);
  }
}

function loadJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readCandidateShowIds(showsFileArg) {
  if (!showsFileArg || !fs.existsSync(showsFileArg)) return [];
  return fs.readFileSync(showsFileArg, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Would rebuild-all-reviews.js include this specific file? Composes the two
 * real functions it calls — never a bespoke reimplementation. Mirrors
 * rebuild-all-reviews.js's own pre-scoring step: applyScoreRelevantMigrations
 * mutates a working copy in-memory before getBestScore() is asked whether a
 * score exists, so a file whose score is only exposed by that migration
 * (aggregator-source normalization, garbage-text recovery) isn't
 * misclassified as unscoreable here. Mutates a fresh copy, never the file on
 * disk.
 */
function isScoreableFile(data, show, filePath) {
  if (!isIncludableForRebuild(data, show || {}, filePath)) return false;
  const migrated = { ...data };
  applyScoreRelevantMigrations(migrated);
  return getBestScore(migrated) !== null;
}

/**
 * Mirrors the unflagged-secondary dedup in rebuild-all-reviews.js (the
 * KNOWN_SYNDICATION_PAIRS check ~line 3193): a syndicated secondary copy is
 * excluded when an UNFLAGGED PRIMARY SIBLING for the same critic already
 * exists in the same show directory. Must require the sibling filename to
 * start with the primary outlet's prefix — checking only "some file whose
 * name contains the critic slug" without that prefix requirement matches the
 * file being tested against ITSELF (every candidate file's own name contains
 * its own critic slug), which always short-circuits true and silently
 * excludes every syndicated-secondary file from the scoreable set regardless
 * of whether a real primary exists.
 */
function isUnflaggedSyndicationSecondary(data, currentFile, allFiles, showDir) {
  const criticName = (data.criticName || '').toLowerCase().trim();
  const outletId = normalizeOutlet(data.outletId || data.outlet || '');
  const syndConfig = getSyndicationConfig(criticName);
  if (!syndConfig || !syndConfig.secondary.includes(outletId)) return false;
  const primaryPrefix = `${syndConfig.primary}--`;
  const criticSlug = criticName.replace(/\s+/g, '-');
  return allFiles.some((f) => {
    if (f === currentFile) return false;
    if (!f.startsWith(primaryPrefix) || !f.includes(criticSlug)) return false;
    const pData = loadJSON(path.join(showDir, f));
    if (!pData) return false;
    return !pData.wrongProduction && !pData.wrongShow;
  });
}

async function main() {
  const showsFileArg = (process.argv.find((a) => a.startsWith('--shows-file=')) || '')
    .replace('--shows-file=', '') || null;
  // BRO-545: the real, immediate bypass — same --force flag rebuild-reviews.yml
  // already threads to rebuild-all-reviews.js as --force-write when a human
  // runs `gh workflow run "Rebuild Reviews Data" -f force_write=true`. Without
  // this, "override command" in the alert below would only be a plain re-run
  // (still subject to the same first-block-fails-loud rule), not an actual
  // way to unblock before the 2-consecutive auto-recovery threshold.
  const forced = process.argv.includes('--force');
  const candidateShowIds = readCandidateShowIds(showsFileArg);
  if (candidateShowIds.length === 0) {
    console.log('[check-rebuild-staleness] no drifted shows this run — nothing to verify.');
    // A clean no-op run is still "not blocked" — clear any open streak so a
    // quiet stretch doesn't leave a stale escalation state behind.
    const cleared = nextGuardState(loadGuardState(), false, Date.now());
    saveGuardState(cleared);
    return;
  }

  const showsDoc = loadJSON(SHOWS_FILE);
  const shows = (showsDoc && (showsDoc.shows || showsDoc)) || [];
  const showsById = new Map(shows.map((s) => [s.id, s]));

  const reviewsDoc = loadJSON(REVIEWS_FILE);
  if (!reviewsDoc || !Array.isArray(reviewsDoc.reviews)) {
    console.error('::error::[check-rebuild-staleness] could not read data/reviews.json — aborting');
    process.exit(1);
  }
  const reviewsShowIds = reviewsDoc.reviews.map((r) => r.showId);

  const knownShowDirs = new Set(listShowDirs(REVIEW_TEXTS_DIR, { silent: true }));
  const scoreableShowIds = [];

  for (const showId of candidateShowIds) {
    if (!knownShowDirs.has(showId)) continue;
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try {
      files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    const show = showsById.get(showId);
    const isScoreable = files.some((file) => {
      const data = loadJSON(path.join(showDir, file));
      if (!data) return false;
      if (!isScoreableFile(data, show, path.join(showDir, file))) return false;
      if (isUnflaggedSyndicationSecondary(data, file, files, showDir)) return false;
      return true;
    });
    if (isScoreable) scoreableShowIds.push(showId);
  }

  const missing = findMissingScoreableShows(scoreableShowIds, reviewsShowIds);
  const overrideCommand = buildOverrideCommand({
    workflowDisplayName: WORKFLOW_DISPLAY_NAME,
    reason: 'BRO-545 stale-checkout guard manual override',
    extraFlags: ['-f force_write=true'],
  });

  if (missing.length > 0) {
    const priorState = loadGuardState();
    const state = nextGuardState(priorState, true, Date.now());
    saveGuardState(state);

    const baseMsg =
      `[check-rebuild-staleness] ${missing.length} show(s) had scoreable review-text ` +
      `files (drifted in during this job) but ZERO reviews.json entries after rebuild — ` +
      `stale-checkout race, not a legitimate exclusion. Shows: ${missing.join(', ')}. ` +
      `Override: ${overrideCommand}`;

    if (forced) {
      console.error(`::warning::${baseMsg}`);
      console.error('::warning::[guard-escalation] --force passed — proceeding despite the block (manual override, not auto-recovery).');
      return;
    }

    if (!shouldAutoRecover(GUARD_ID, state.consecutiveBlocks)) {
      // First (or still-below-threshold) block: fail loud, unchanged from
      // before BRO-545 — a one-off stale-checkout race is worth flagging
      // immediately.
      console.error(`::error::${baseMsg}`);
      process.exit(1);
    }

    // BRO-545 auto-recovery: this guard has now blocked
    // state.consecutiveBlocks runs in a row. Reviews.json already reflects
    // this run's rebuild (the "Rebuild reviews.json" step succeeded before
    // this check ran) — proceeding here just stops marking the whole job red
    // for a condition that keeps reproducing, so the pipeline degrades to a
    // loud, escalating alert instead of stalling indefinitely.
    const alert = buildGuardBlockedAlert({
      guardId: GUARD_ID,
      guardLabel: 'Stale-checkout race guard (check-rebuild-staleness.js)',
      consecutiveBlocks: state.consecutiveBlocks,
      workflowDisplayName: WORKFLOW_DISPLAY_NAME,
      overrideCommand,
      runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined,
    });
    console.error(`::warning::${baseMsg}`);
    console.error(`::warning::[guard-escalation] AUTO-RECOVERING — ${alert.description.replace(/\n/g, ' | ')}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        fs.appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `\n## ⚠️ Guard auto-recovery — ${alert.title}\n\n${alert.description.replace(/\n/g, '\n\n')}\n`,
        );
      } catch (e) { /* summary write is best-effort */ }
    }

    if (shouldEscalate(state.consecutiveBlocks)) {
      try {
        const { routeAlert } = require('./lib/owner-alert-router');
        await routeAlert({
          conditionKey: ALERT_CONDITION_KEY,
          title: alert.title,
          description: alert.description,
          disposition: 'human',
          cooldownHours: 1,
        });
      } catch (e) {
        console.error(`::warning::[guard-escalation] routeAlert failed (${e.message}) — escalation was logged above regardless.`);
      }
    }
    // Auto-recovered: exit 0 so this step (and the job) stays green — the
    // condition is already visible via the warnings/summary/alert above.
    return;
  }

  // Healthy run: clear any open streak so a real recurring block doesn't get
  // silently forgotten, but a single good run also doesn't leave a stale
  // "still blocked" incident open.
  const priorState = loadGuardState();
  if (priorState && priorState.consecutiveBlocks > 0) {
    try {
      const { resolveCondition } = require('./lib/owner-alert-router');
      resolveCondition(ALERT_CONDITION_KEY);
    } catch (e) { /* best-effort — a missing router/ledger never blocks a healthy run */ }
  }
  saveGuardState(nextGuardState(priorState, false, Date.now()));

  console.log(
    `[check-rebuild-staleness] verified ${candidateShowIds.length} drifted show(s), ` +
    `${scoreableShowIds.length} scoreable — all present in reviews.json.`,
  );
}

main().catch((e) => {
  console.error(`::error::[check-rebuild-staleness] unexpected failure: ${e.stack || e.message}`);
  process.exit(1);
});
