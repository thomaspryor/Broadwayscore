// BRO-5582: ~1.6k review files carry wrongProduction=true with no record of why (no Note, Reason,
// Provenance, DetectedBy or Detail). Their original basis is not recoverable, so this stamps a
// separate audit field instead of inventing a wrongProductionProvenance value: 'content' and
// 'manual' change auto-clear behavior (wrong-production-autoclear.js), 'url' enables the
// venue-transfer self-heal. wrongProductionLegacyAudit is read by no decision logic; it is in
// WRONG_PRODUCTION_PROVENANCE_FIELDS so it is cleared together with the flag.
'use strict';

const AUDIT_FIELD = 'wrongProductionLegacyAudit';

// Any other wrongProduction* key (incl. _-prefixed legacy forms) means the flag already has a trail.
function hasAnyWrongProductionTrail(record) {
  return Object.keys(record).some(k => /^_?wrongProduction/.test(k) && k !== 'wrongProduction' && k !== AUDIT_FIELD);
}

function isLegacyUnprovenanced(record) {
  return !!record && record.wrongProduction === true
    && !record[AUDIT_FIELD] && !hasAnyWrongProductionTrail(record);
}

/** The audit stamp for a legacy flag, or null when the file is not eligible. */
function legacyAuditStamp(record, { at, issue = 'BRO-5582' }) {
  if (!isLegacyUnprovenanced(record)) return null;
  const rejection = record.rejectedBy && record.rejectionReason
    ? { rejectedBy: record.rejectedBy, rejectionReason: record.rejectionReason } : null;
  return {
    basis: rejection ? 'recorded-rejection' : 'unrecorded',
    ...(rejection || {}),
    backfilledAt: at,
    backfilledBy: issue,
  };
}

module.exports = { AUDIT_FIELD, isLegacyUnprovenanced, legacyAuditStamp };
