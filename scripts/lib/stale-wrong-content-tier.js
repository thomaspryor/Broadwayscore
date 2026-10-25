'use strict';
/**
 * stale-wrong-content-tier (BRO-5356, BRO-5367): a review whose wrongShow /
 * wrongProduction flag has been CLEARED keeps contentTier 'invalid' ('Wrong
 * show' / 'Wrong production') unless something reclassifies it. explainExclusion
 * lifts that tier only while a rebuild auto-clear stamp is fresh, so the review
 * later drops off the site again (christmas-carol-goes-wrong-west-end-2026 x2,
 * much-ado-about-nothing-2026 x4; spamalot-2023 / the-whos-tommy-2024 NYSR after
 * an approved-fix clear).
 *
 * Retier only on evidence that the flag was cleared, never on its mere absence:
 * a persisted 'Wrong production' reason with no flag and no clear is the
 * contamination signal older-production-live-guard.js keys on (BRO-4432).
 * Rejected and garbage records are left alone (review-guards #316 warning).
 */
const CLEAR_EVIDENCE = [
  'wrongProductionAutoCleared', 'wrongProductionManualClear', 'wrongProductionOverride',
  'wrongShowAutoCleared', 'wrongShowManualClear', 'wrongShowOverride',
];

function hasClearEvidence(record) {
  if (CLEAR_EVIDENCE.some((k) => record[k])) return true;
  if (record.humanReviewedWrongProduction === false) return true;
  const fixes = Array.isArray(record.approvedFixes) ? record.approvedFixes : [];
  return fixes.some((f) => f && (f.field === 'wrongShow' || f.field === 'wrongProduction') && f.newValue === false);
}

function isGarbageOrRejected(record) {
  if (record.rejectionReason || record.rejectedAt) return true;
  const garbage = /garbage/i;
  return garbage.test(String(record.rejectionReason || '')) || garbage.test(String(record.incompleteReason || ''))
    || /^(Garbage content|Marked as garbage)/.test(String(record.contentTierReason || ''));
}

/**
 * Reclassify `record` in place when its invalid tier was caused by a
 * wrong-content flag that has since been cleared. Returns the keys changed.
 */
function retierStaleWrongContentTier(record) {
  if (!record || record.contentTier !== 'invalid') return [];
  if (record.wrongShow || record.wrongProduction) return [];
  if (!/^wrong (show|production)$/i.test(String(record.contentTierReason || record.tierReason || '').trim())) return [];
  if (!hasClearEvidence(record) || isGarbageOrRejected(record)) return [];
  const t = require('./content-quality').classifyContentTier({ ...record, contentTier: undefined });
  if (!t || !t.contentTier || t.contentTier === 'invalid') return [];
  record.contentTier = t.contentTier;
  record.contentTierReason = t.tierReason;
  record.tierReason = t.tierReason;
  const changed = ['contentTier', 'contentTierReason', 'tierReason'];
  if (record.incompleteReason === 'wrong_content') {
    record.incompleteReason = null;
    record.incompleteDetail = null;
    changed.push('incompleteReason', 'incompleteDetail');
  }
  return changed;
}

module.exports = { retierStaleWrongContentTier, hasClearEvidence };
