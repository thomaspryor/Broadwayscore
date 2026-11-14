'use strict';

const { classifyAutoclearVsEnsemble } = require('./autoclear-vs-ensemble-scan');

const CLASSES = [
  {
    kind: 'wrong_show',
    flag: 'wrongShow',
    breadcrumb: 'wrongShowAutoCleared',
    reasonField: 'wrongShowReason',
    atField: 'wrongShowReasonAt',
  },
  {
    kind: 'wrong_production',
    flag: 'wrongProduction',
    breadcrumb: 'wrongProductionAutoCleared',
    reasonField: 'wrongProductionReason',
    atField: 'wrongProductionReasonAt',
  },
];

// Used by the standing audit and its backfill writer. An old heuristic clear
// conflicts with a live ensemble verdict only while that verdict still stands.
function findAutoClearConflicts(data) {
  if (!data || typeof data !== 'object') return [];
  // Share the standing corpus audit's exemptions for explicit recovery,
  // corrected URLs and rechecked production verdicts (BRO-202).
  return CLASSES.filter((c) => classifyAutoclearVsEnsemble(data, {
    reason: c.kind,
    autoClearedField: c.breadcrumb,
    flagField: c.flag,
  }).isViolation);
}

module.exports = { CLASSES, findAutoClearConflicts };
