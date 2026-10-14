/**
 * change-stability-guard.js
 *
 * Generic stability guard for bulk JSON-mutation scripts. Aborts when a single
 * run would change too many entries — protecting against parser regressions,
 * upstream format changes, or "the v1 backfill itself trips its own guard"
 * footguns.
 *
 * Generalized 2026-04-28 from `validateShowIdStability` in
 * scripts/scrape-lottery-rush.js (which counted added/removed show IDs in the
 * lottery-rush JSON). The new version supports:
 *   - explicit absolute thresholds (separate add/remove)
 *   - percentage-of-candidates thresholds (catches the "3 changes out of 4
 *     candidates" case where absolute counts would pass)
 *   - per-script `--initial-backfill` bypass for the first run
 *   - per-script `--force` operator override
 *   - audit-trail snapshot of the aborted state for postmortem
 *
 * Why this exists: every bulk mutator either reinvents this logic OR
 * silently mass-corrupts on a parser regression. (Reviewer-flagged risk;
 * see /plan-review output 2026-04-28.)
 *
 * Usage:
 *   const { validateChangeStability } = require('./lib/change-stability-guard');
 *   const result = validateChangeStability({
 *     name: 'enrich-off-broadway-dates',
 *     changes,                    // [{id, ...}, ...]
 *     candidateCount,             // total candidates considered
 *     thresholds: {
 *       absoluteChanges: 50,       // abort if more than 50 changes in one run
 *       changePercent: 0.5,        // abort if >50% of candidates change
 *     },
 *     forceFlag: process.argv.includes('--force'),
 *     initialBackfillFlag: process.argv.includes('--initial-backfill'),
 *     snapshotPath: 'data/audit/...-aborted.json', // optional
 *   });
 *   if (!result.ok) process.exit(1);
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @param {object} opts
 * @param {string} opts.name - script name for audit/log output
 * @param {Array<object>} opts.changes - the proposed changes (length checked)
 * @param {number} opts.candidateCount - total candidates considered (denominator for percent check)
 * @param {object} opts.thresholds
 * @param {number} [opts.thresholds.absoluteChanges] - abort if changes.length > this
 * @param {number} [opts.thresholds.changePercent] - abort if changes.length / candidateCount > this (0..1)
 * @param {boolean} [opts.forceFlag] - operator override; logs warning, allows run
 * @param {boolean} [opts.initialBackfillFlag] - first-run override; logs warning, allows run
 * @param {string} [opts.snapshotPath] - if abort, write a summary of the aborted change set here
 * @param {Function} [opts.log] - logger; defaults to console
 * @returns {{ok: boolean, reason?: string, snapshotPath?: string}}
 */
function validateChangeStability({
  name = 'unnamed-mutator',
  changes,
  candidateCount,
  thresholds = {},
  forceFlag = false,
  initialBackfillFlag = false,
  snapshotPath = null,
  log = console,
}) {
  if (!Array.isArray(changes)) {
    return { ok: true }; // nothing to guard
  }

  const total = changes.length;
  const reasons = [];

  if (typeof thresholds.absoluteChanges === 'number' && total > thresholds.absoluteChanges) {
    reasons.push(`${total} changes exceeds absolute threshold ${thresholds.absoluteChanges}`);
  }

  if (
    typeof thresholds.changePercent === 'number' &&
    typeof candidateCount === 'number' &&
    candidateCount > 0
  ) {
    const pct = total / candidateCount;
    if (pct > thresholds.changePercent) {
      reasons.push(
        `${total}/${candidateCount} = ${(pct * 100).toFixed(1)}% exceeds percent threshold ${(thresholds.changePercent * 100).toFixed(0)}%`
      );
    }
  }

  if (reasons.length === 0) {
    return { ok: true };
  }

  const reasonText = reasons.join('; ');

  if (forceFlag) {
    log.warn(`[${name}] STABILITY-GUARD WARN (--force bypass): ${reasonText}`);
    return { ok: true, reason: reasonText, bypass: 'force' };
  }
  if (initialBackfillFlag) {
    log.warn(`[${name}] STABILITY-GUARD WARN (--initial-backfill bypass): ${reasonText}`);
    return { ok: true, reason: reasonText, bypass: 'initial-backfill' };
  }

  // Hard abort. Persist a snapshot if requested.
  if (snapshotPath) {
    try {
      fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
      fs.writeFileSync(
        snapshotPath,
        JSON.stringify(
          {
            _meta: {
              script: name,
              abortedAt: new Date().toISOString(),
              reason: reasonText,
              candidateCount,
              changeCount: total,
            },
            changes,
          },
          null,
          2
        )
      );
      log.error(`[${name}] STABILITY-GUARD ABORT: ${reasonText}. Snapshot at ${snapshotPath}`);
      return { ok: false, reason: reasonText, snapshotPath };
    } catch (err) {
      log.error(`[${name}] STABILITY-GUARD ABORT: ${reasonText}. Failed to write snapshot: ${err.message}`);
      return { ok: false, reason: reasonText };
    }
  }

  log.error(`[${name}] STABILITY-GUARD ABORT: ${reasonText}. Pass --force or --initial-backfill to override.`);
  return { ok: false, reason: reasonText };
}

module.exports = { validateChangeStability };
