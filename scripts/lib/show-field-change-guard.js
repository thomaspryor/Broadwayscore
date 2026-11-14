/**
 * Scope guard for feedback-driven show edits: a submission that says "X closed
 * on D" may change only `status` and `closingDate` (plus their audit stamps).
 * Returns the fields that differ between two show entries and which of them
 * fall outside the allowed set.
 */
const CLOSURE_FIELDS = ['status', 'closingDate', 'closingDateSource', 'closingDateUpdatedAt'];

function diffShowFields(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((k) => JSON.stringify((before || {})[k]) !== JSON.stringify((after || {})[k]));
}

function checkFieldChangeScope(before, after, allowed = CLOSURE_FIELDS) {
  const changed = diffShowFields(before, after);
  const unexpected = changed.filter((k) => !allowed.includes(k));
  return { ok: unexpected.length === 0, changed, unexpected };
}

module.exports = { CLOSURE_FIELDS, diffShowFields, checkFieldChangeScope };
