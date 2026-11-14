'use strict';

// Unknown dates rank last; ties retain input order. Never mutate the report.
function rankByAge(items, ageField, ageDaysErrorThreshold = 21, now = new Date()) {
  if (!Array.isArray(items) || items.length === 0) return null;
  let oldest = items[0];
  let ageDays = null;
  for (const item of items) {
    const value = item && item[ageField];
    const timestamp = value ? Date.parse(value) : NaN;
    const days = Number.isFinite(timestamp)
      ? Math.floor((now - timestamp) / 86400000)
      : null;
    if (days != null && (ageDays == null || days > ageDays)) {
      oldest = item;
      ageDays = days;
    }
  }
  return { oldest, ageDays, status: ageDays != null && ageDays >= ageDaysErrorThreshold ? 'error' : 'warn' };
}

module.exports = { rankByAge };
