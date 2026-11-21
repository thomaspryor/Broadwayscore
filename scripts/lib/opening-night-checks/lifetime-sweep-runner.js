'use strict';

/**
 * Shared engine for "lifetime corpus sweep" audits (task #1746, extending
 * #1731's scripts/audit-cv-wrongproduction-lifetime.js pattern to 4 more
 * opening-night-checks plugins: fulltext-mentions-show, slug-mismatch,
 * roundup-url-mismatch, revival-unverified).
 *
 * Each of those checks only ever runs via opening-night-checklist.js, gated
 * to shows within ±2 days of openingDate — a show past that window is never
 * re-checked again for the rest of its life, even though the bypass class
 * each check exists to catch (wrong/mismatched content shipped into
 * reviews.json) has no expiry. #1712's corpus audit found 3 live instances
 * of exactly this reintroduced weeks post-opening via an unrelated bug.
 *
 * This module runs a SAME-LOGIC sweep (no fork — reuses the check's own
 * run()) against every show in shows.json, independent of opening date, so a
 * future re-verification event that reintroduces the bypass is caught no
 * matter how long ago the show opened. Four near-identical audit-X-lifetime
 * scripts would have been mostly copy-paste of #1731's file; this generic
 * runner is the alternative the card asked to weigh once a 5th instance of
 * the pattern showed up. Each check gets a thin CLI wrapper
 * (scripts/audit-{check}-lifetime.js) that just supplies config.
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('../cli-help.js');
const { listShowDirs } = require('../list-show-dirs.js');
const { assertCorpusScanned, CorpusNotScannedError } = require('../corpus-scan-guard.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const AUDIT_DIR = path.join(ROOT, 'data', 'audit');
// > digest settle (48h) + autofix persistence (72h) + one missed daily run.
const EVIDENCE_HOLD_HOURS = 96;

function loadReviewsDoc(reviewsPath) {
  const doc = {};
  const raw = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  for (const r of raw.reviews || []) {
    if (!doc[r.showId]) doc[r.showId] = [];
    doc[r.showId].push(r);
  }
  return doc;
}

// Per-hit violations, or a single show-level violation when a check has no
// filename granularity (e.g. revival-unverified — one verdict per show).
function defaultExtractViolations(result) {
  if (result.details && Array.isArray(result.details.violations)) {
    return result.details.violations;
  }
  return [{}];
}

function defaultViolationKey(showId, violation) {
  return violation.filename ? `${showId}::${violation.filename}` : showId;
}

/**
 * @param {Object} config
 * @param {{name: string, run: Function}} config.checkModule - the check plugin (see types.js)
 * @param {string} config.scriptName        - e.g. 'audit-slug-mismatch-lifetime.js' (for --help banner)
 * @param {string} config.taskRef           - e.g. '#1746' (for messaging)
 * @param {string} config.snapshotBasename  - e.g. 'slug-mismatch-lifetime.json' under data/audit/
 * @param {string[]} [config.countSeverities] - which result.severity values count as a hit (default ['error'])
 * @param {function(Object): Array} [config.extractViolations] - (result) => violation[]
 * @param {function(string, Object): string} [config.violationKey] - (showId, violation) => dedup key
 * @param {boolean} [config.needsShows]     - pass context.shows (full shows.json array) — required by revival-unverified
 * @param {string[]} config.argv            - process.argv.slice(2)
 * @param {string} [config.extraUsage]      - extra usage text specific to this check
 * @param {function(Array): Object} [config.summarizeHits] - additional report fields (no change to verdicts)
 * @param {function(Object): boolean} [config.isActionable] - (violation) => true when the hit carries
 *        positive evidence of the bypass class. When set, the snapshot also records
 *        newActionableSinceLastRun / actionableViolations, and the digest row warns on
 *        those instead of on every new key (BRO-7204: a hit with no evidence either way
 *        is backlog, not news).
 * @returns {number} exit code
 */
function runLifetimeSweep(config) {
  const {
    checkModule,
    scriptName,
    taskRef,
    snapshotBasename,
    countSeverities = ['error'],
    extractViolations = defaultExtractViolations,
    violationKey = defaultViolationKey,
    needsShows = false,
    argv,
    extraUsage = '',
    summarizeHits = () => ({}),
    isActionable = null,
    nowMs = Date.now(),
  } = config;

  const SNAPSHOT_PATH = path.join(AUDIT_DIR, snapshotBasename);

  const USAGE = `${scriptName} — lifetime corpus sweep for the ${checkModule.name} bypass class (task ${taskRef})

Runs ${checkModule.name}.check.js (the same check opening-night-checklist.js
uses, ±2-day window only) against EVERY show in shows.json, not just shows
near their opening date.
${extraUsage}
Usage:
  node scripts/${scriptName} [--json] [--show=ID]
                              [--review-texts-dir=PATH]
                              [--shows-path=PATH]
                              [--reviews-path=PATH]

  --json                machine-readable output
  --show=ID             scan a single show only
  --review-texts-dir=   override the corpus path (default data/review-texts)
  --shows-path=         override shows.json path (default data/shows.json)
  --reviews-path=       override reviews.json path (default data/reviews.json)
  --no-snapshot         skip writing data/audit/${snapshotBasename}

Exit code: 1 if any unhandled violation is found, 0 otherwise. A full-corpus
run (no --show) also writes data/audit/${snapshotBasename} — the dead-man
snapshot health-check.js's digest reads.

The digest's own warn/pass verdict keys off newSinceLastRun in the snapshot,
not totalViolations — with a nonzero baseline, a raw-total-driven digest would
warn every run forever and train the owner to ignore it. Delta-vs-previous-
snapshot is what keeps the signal actionable: silence when nothing changed, a
warn only when a violation key (showId[+filename]) that wasn't in the last
run's snapshot shows up.
`;

  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const json = argv.includes('--json');
  const showArg = (argv.find((a) => a.startsWith('--show=')) || '').split('=')[1] || null;
  const dirArg = argv.find((a) => a.startsWith('--review-texts-dir='));
  const REVIEW_TEXTS_DIR = dirArg ? dirArg.split('=')[1] : path.join(ROOT, 'data', 'review-texts');
  const showsArg = argv.find((a) => a.startsWith('--shows-path='));
  const SHOWS_PATH = showsArg ? showsArg.split('=')[1] : path.join(ROOT, 'data', 'shows.json');
  const reviewsArg = argv.find((a) => a.startsWith('--reviews-path='));
  const REVIEWS_PATH = reviewsArg ? reviewsArg.split('=')[1] : path.join(ROOT, 'data', 'reviews.json');

  let allShows;
  try {
    allShows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows || [];
  } catch (e) {
    console.error(`FAIL: could not read ${SHOWS_PATH}: ${e.message}`);
    return 1;
  }
  const shows = showArg ? allShows.filter((s) => s.id === showArg) : allShows;

  let reviewsDoc;
  try {
    reviewsDoc = loadReviewsDoc(REVIEWS_PATH);
  } catch (e) {
    // Fail loud, not vacuously pass: a missing/malformed reviews.json would
    // otherwise make every show read as "No shipped reviews — skipping" in
    // the underlying check, silently reporting a clean corpus-wide scan.
    console.error(`FAIL: could not read ${REVIEWS_PATH}: ${e.message}`);
    return 1;
  }
  const context = { reviewTextsRoot: REVIEW_TEXTS_DIR, reviewsDoc, showScorePath: path.join(path.dirname(REVIEWS_PATH), 'show-score.json') };
  if (needsShows) context.shows = allShows;

  // "scanned" reflects directories actually present on disk (mirrors
  // audit-cv-wrongproduction-lifetime.js), not how many shows.json entries
  // happen to match one — a near-empty review-texts checkout with a single
  // matching dir would otherwise satisfy the zero-only corpus-scan guard.
  const scanned = showArg
    ? (fs.existsSync(path.join(REVIEW_TEXTS_DIR, showArg)) ? 1 : 0)
    : listShowDirs(REVIEW_TEXTS_DIR, { silent: true }).length;

  const countSet = new Set(countSeverities);
  const hits = [];
  for (const show of shows) {
    const result = checkModule.run(show, context);
    if (!result.ok && countSet.has(result.severity)) {
      hits.push({
        showId: show.id,
        title: show.title || show.id,
        openingDate: show.openingDate || null,
        message: result.message,
        violations: extractViolations(result),
      });
    }
  }

  try {
    assertCorpusScanned(scanned, { gate: !showArg, label: REVIEW_TEXTS_DIR });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    return 1;
  }

  const totalViolations = hits.reduce((n, h) => n + h.violations.length, 0);
  const summary = summarizeHits(hits);
  const currentKeys = new Set();
  const actionableKeys = new Set();
  for (const h of hits) {
    for (const v of h.violations) {
      const key = violationKey(h.showId, v);
      currentKeys.add(key);
      if (isActionable && isActionable(v)) actionableKeys.add(key);
    }
  }
  // Evidence hits stay OPEN for EVIDENCE_HOLD_HOURS after they first carry
  // evidence, or until they leave the sweep (flagged/fixed). A one-run delta
  // would warn for a single day and the morning digest holds a new warning
  // 48h (health-first-seen.js SETTLE_HOURS) and files only after 72h of
  // persistence (digest-autofix.js), so a real case would vanish uncarded.
  // Membership is compared on evidence, not on violation keys, so a backlog
  // key that later gains evidence (its rival show added to shows.json) opens.
  const nowIso = new Date(nowMs).toISOString();
  let actionableOpen = {};
  let newActionable = [];
  const computeActionable = (prev, previousKeys) => {
    if (!isActionable) return;
    const prevOpen = (prev && prev.actionableOpen && typeof prev.actionableOpen === 'object') ? prev.actionableOpen : {};
    // Snapshot written before evidence tracking: its keys are baseline, not news.
    const prevActionable = prev && Array.isArray(prev.actionableKeys) ? new Set(prev.actionableKeys) : previousKeys;
    for (const key of actionableKeys) {
      if (prevOpen[key]) {
        const age = (nowMs - Date.parse(prevOpen[key])) / 3600000;
        if (age < EVIDENCE_HOLD_HOURS) actionableOpen[key] = prevOpen[key];
      } else if (!prevActionable.has(key)) {
        actionableOpen[key] = nowIso;
        newActionable.push(key);
      }
    }
  };
  const actionableFields = () => {
    if (!isActionable) return {};
    return {
      actionableViolations: actionableKeys.size,
      newActionableSinceLastRun: newActionable.length,
      newActionableKeys: newActionable.slice(0, 50),
      openActionableCount: Object.keys(actionableOpen).length,
      actionableOpen,
      actionableKeys: [...actionableKeys],
    };
  };

  let newSinceLastRun = currentKeys.size;
  let newViolationKeys = [...currentKeys];
  if (!showArg && !argv.includes('--no-snapshot')) {
    let previousKeys = new Set();
    let prev = null;
    try {
      prev = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
      previousKeys = new Set(prev.violationKeys || []);
    } catch {
      // No prior snapshot (first run) — every current hit counts as "new".
    }
    newViolationKeys = [...currentKeys].filter((k) => !previousKeys.has(k));
    newSinceLastRun = newViolationKeys.length;
    computeActionable(prev, previousKeys);

    try {
      fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
      fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({
        updatedAt: new Date().toISOString(),
        scanned,
        showsWithViolations: hits.length,
        totalViolations,
        newSinceLastRun,
        newViolationKeys: newViolationKeys.slice(0, 50),
        ...actionableFields(),
        violationKeys: [...currentKeys],
        hits,
        ...summary,
      }, null, 2) + '\n');
    } catch (e) {
      console.error(`::warning::could not write snapshot to ${SNAPSHOT_PATH}: ${e.message}`);
    }
  }

  if (json) {
    console.log(JSON.stringify({
      scanned,
      showsWithViolations: hits.length,
      totalViolations,
      newSinceLastRun,
      ...actionableFields(),
      hits,
      ...summary,
    }, null, 2));
  } else {
    console.log(`${checkModule.name} lifetime sweep (${taskRef}): ${scanned} show(s) with review-texts scanned, ${hits.length} show(s) with unhandled violations (${totalViolations} review(s), ${newSinceLastRun} new since last run${isActionable ? `, ${newActionable.length} newly with contamination evidence, ${Object.keys(actionableOpen).length} evidence hit(s) open` : ''}).`);
    for (const h of hits) {
      console.log(`\n-- ${h.title} (${h.showId}), opened ${h.openingDate || 'unknown'} --`);
      console.log(`  ${h.message.split('\n').join('\n  ')}`);
    }
    if (hits.length > 0) {
      console.log('\nEach hit needs a manual re-verification against the outlet\'s current article — same remediation as task #1712\'s findings.');
    }
  }

  return totalViolations > 0 ? 1 : 0;
}

module.exports = { EVIDENCE_HOLD_HOURS, runLifetimeSweep, loadReviewsDoc, defaultExtractViolations, defaultViolationKey };
