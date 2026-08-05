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

module.exports = { assertCorpusScanned, CorpusNotScannedError };
