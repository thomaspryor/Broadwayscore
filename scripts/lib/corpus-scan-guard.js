#!/usr/bin/env node

/**
 * Shared FAIL-LOUD guard for corpus audits (scripts/audit-*.js) that walk
 * data/review-texts. review-texts is a private-repo checkout that can be
 * missing or empty (failed checkout, a worktree without the private clone,
 * a misconfigured CI job) — an audit that reports "0 issues found" in that
 * state is a vacuous pass, worse than no gate at all: it goes green exactly
 * when it is least able to see a regression (task #1063, following the
 * pattern first fixed in audit-self-contradictory-clears.js 2026-08-05).
 *
 * Call after the scan completes with the number of files the audit actually
 * examined. Throws CorpusNotScannedError when `gate` is truthy and `scanned`
 * is 0; a no-op when `gate` is falsy or `scanned` is positive — mirrors the
 * audits' own --gate opt-in so a report-only run never trips it.
 */

'use strict';

class CorpusNotScannedError extends Error {
  constructor(label) {
    super(
      `scanned 0 review files — ${label} is missing or empty. ` +
        'The gate cannot pass vacuously; check out the review-texts private repo first.'
    );
    this.name = 'CorpusNotScannedError';
  }
}

function assertCorpusScanned(scanned, { gate, label = 'data/review-texts' } = {}) {
  if (!gate) return;
  if (scanned > 0) return;
  throw new CorpusNotScannedError(label);
}

/**
 * Companion to assertCorpusScanned for audits that scan a DATE-WINDOWED
 * subset of the corpus rather than all of it. assertCorpusScanned answers
 * "did we look at anything at all"; this answers the question that actually
 * misleads readers of a windowed audit — "how much did we NOT look at, and
 * why".
 *
 * The failure it exists to prevent (BRO-2348): audit-cv-flag-contradiction.js
 * printed `132 shows opened in the last 30d, 12 contradiction(s) found` /
 * `(12 baselined, 0 new)` and exited 0. Every part of that reads like corpus
 * health and none of it is. Measured on the real corpus on 2026-09-07:
 *   - 110 of those 132 had a FUTURE openingDate. The window filter is a
 *     lower bound only (`t >= cutoff`), so "opened in the last 30d" counted
 *     shows that have not opened. Only 22 had actually opened.
 *   - Only 72 of the 132 had a data/review-texts/<id> directory. The other
 *     60 hit a bare `continue` and were never opened.
 *   - 342 of the 2,943 corpus shows carry no openingDate at all, so they are
 *     excluded at EVERY window, not merely this one.
 * Collapsing those four distinct populations into one "scanned" number is
 * what made the blind spot invisible, so this deliberately keeps them apart
 * instead of returning a single coverage percentage.
 *
 * Pure: takes counts, returns counts and strings. No I/O, no formatting
 * decisions the caller cannot override — the caller prints `lines`.
 *
 * `openedShows` is the subset of `windowShows` whose openingDate is already
 * in the past; the upcoming count is derived, never passed, so the two can
 * never disagree.
 */
function summarizeWindowCoverage({
  windowDays,
  corpusShows,
  eligibleShows,
  windowShows,
  openedShows,
  showsWithTexts,
  filesParsed,
} = {}) {
  const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const corpus = num(corpusShows);
  const eligible = Math.min(num(eligibleShows), corpus);
  const inWindow = Math.min(num(windowShows), corpus);
  const opened = Math.min(num(openedShows), inWindow);
  const withTexts = Math.min(num(showsWithTexts), inWindow);

  const upcoming = inWindow - opened;
  const ineligible = corpus - eligible;
  const notExamined = corpus - inWindow;
  const skippedNoTexts = inWindow - withTexts;

  const lines = [
    `Coverage: examined ${withTexts} of ${corpus} corpus shows ` +
      `(${num(filesParsed)} review file(s) parsed).`,
    `  --window=${num(windowDays)}d selected ${inWindow} show(s): ` +
      `${opened} already opened, ${upcoming} not yet opened ` +
      '(the window filter has no upper bound).',
    `  ${skippedNoTexts} selected show(s) had no data/review-texts directory ` +
      'and were skipped.',
    `  ${notExamined} corpus show(s) were NOT examined, of which ${ineligible} ` +
      'carry no openingDate and are excluded at EVERY window.',
    '  A clean result above covers only the examined shows. It is not a ' +
      'statement about the corpus.',
  ];

  return {
    corpusShows: corpus,
    eligibleShows: eligible,
    ineligibleShows: ineligible,
    windowShows: inWindow,
    openedShows: opened,
    upcomingShows: upcoming,
    showsWithTexts: withTexts,
    skippedNoTexts,
    notExamined,
    filesParsed: num(filesParsed),
    lines,
  };
}

module.exports = { assertCorpusScanned, CorpusNotScannedError, summarizeWindowCoverage };
