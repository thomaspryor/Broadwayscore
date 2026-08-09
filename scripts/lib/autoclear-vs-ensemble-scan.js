#!/usr/bin/env node

/**
 * Corpus scanner for the autoclear-vs-ensemble defect class (#1146/#1156):
 * a rebuild auto-clear path (allowEarlyDate/allowCrossMarket bypass, UK-URL/
 * registry-region heuristic) deleted wrongProduction/wrongShow on a file the
 * LLM ensemble had already unanimously rejected on content grounds
 * (rejectionReason set by rejectedBy: 'ensemble-scoreability-check' —
 * scripts/llm-scoring/index.ts). The show-level date/market override or the
 * outlet-URL heuristic has no bearing on whether THIS review's TEXT is about
 * the right production; the ensemble's per-content verdict is the stronger
 * signal and auto-clear paths must defer to it
 * (scripts/lib/wrong-production-autoclear.js hasEnsembleRejection).
 *
 * A hit is exempted (not a violation) when either:
 *   - the text was re-fetched AFTER the ensemble rejection (textFetchedAt >
 *     rejectedAt) — the rejection is stale, about content that no longer
 *     backs the file, so clearing the flag was correct; or
 *   - a human has since explicitly overridden the flag
 *     (wrongProductionManualClear/Override, wrongShowManualClear/Override, or
 *     humanReviewedWrongProduction === false) — a deliberate human verdict
 *     outranks both the ensemble and the auto-clear, and must never be
 *     reverted by this scan.
 *
 * Used by scripts/audit-autoclear-vs-ensemble.js (CLI, --fix) and
 * scripts/lib/autoclear-vs-ensemble.test.mjs (live-corpus assertion).
 */

'use strict';

const fs = require('fs');
const path = require('path');

function isHumanOverridden(data) {
  return (
    data.wrongProductionManualClear === true ||
    data.wrongProductionOverride === true ||
    data.wrongShowManualClear === true ||
    data.wrongShowOverride === true ||
    data.humanReviewedWrongProduction === false
  );
}

function isStaleRejection(data) {
  return !!(
    data.textFetchedAt &&
    typeof data.textFetchedAt === 'string' &&
    typeof data.rejectedAt === 'string' &&
    data.textFetchedAt > data.rejectedAt
  );
}

/**
 * @param {object} data - review-text JSON
 * @returns {{ isViolation: boolean, exemptReason?: string }}
 */
function classifyAutoclearVsEnsemble(data, { reason, autoClearedField, flagField } = {}) {
  if (!data) return { isViolation: false };
  if (!data[autoClearedField]) return { isViolation: false };
  if (data.rejectionReason !== reason) return { isViolation: false };
  if (data.rejectedBy !== 'ensemble-scoreability-check') return { isViolation: false };
  if (data[flagField] === true) return { isViolation: false }; // flag never actually cleared
  if (isHumanOverridden(data)) return { isViolation: false, exemptReason: 'human-overridden' };
  if (isStaleRejection(data)) return { isViolation: false, exemptReason: 'stale-rejection-refetched' };
  return { isViolation: true };
}

/**
 * Walk data/review-texts and return every file where an auto-clear path
 * overrode a live (non-stale, non-human-overridden) unanimous ensemble
 * rejection, for both wrongProduction and wrongShow.
 *
 * @param {object} opts
 * @param {string} opts.reviewTextsDir
 * @returns {{ scanned: number, wpViolations: object[], wsViolations: object[] }}
 */
function scanAutoclearVsEnsembleViolations({ reviewTextsDir }) {
  let showDirs = [];
  try {
    showDirs = fs.readdirSync(reviewTextsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
      .map((d) => d.name);
  } catch {
    return { scanned: 0, wpViolations: [], wsViolations: [] };
  }

  let scanned = 0;
  const wpViolations = [];
  const wsViolations = [];

  for (const showId of showDirs) {
    const dir = path.join(reviewTextsDir, showId);
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = path.join(dir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        continue;
      }
      scanned++;

      const wp = classifyAutoclearVsEnsemble(data, {
        reason: 'wrong_production',
        autoClearedField: 'wrongProductionAutoCleared',
        flagField: 'wrongProduction',
      });
      if (wp.isViolation) {
        wpViolations.push({
          showId, file, filePath,
          breadcrumb: data.wrongProductionAutoCleared,
          rejectedAt: data.rejectedAt,
        });
      }

      const ws = classifyAutoclearVsEnsemble(data, {
        reason: 'wrong_show',
        autoClearedField: 'wrongShowAutoCleared',
        flagField: 'wrongShow',
      });
      if (ws.isViolation) {
        wsViolations.push({
          showId, file, filePath,
          breadcrumb: data.wrongShowAutoCleared,
          rejectedAt: data.rejectedAt,
        });
      }
    }
  }

  return { scanned, wpViolations, wsViolations };
}

module.exports = {
  classifyAutoclearVsEnsemble,
  scanAutoclearVsEnsembleViolations,
  isHumanOverridden,
  isStaleRejection,
};
