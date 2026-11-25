"use strict";
const { FIELDS } = require('./venue-access-agree');

function hasSourceUrl(value) {
  if (typeof value !== 'string') return false;
  try { const u = new URL(value); return /^https?:$/.test(u.protocol) && !!u.hostname; } catch { return false; }
}

/**
 * Convert gated facts for the shared badges. A legacy record is usable only with a source.
 * @param {any} entry
 * @param {any} [legacy]
 * @returns {import('../../src/lib/data-types').TheaterAccessibility | undefined}
 */
function accessibilityFor(entry, legacy) {
  const a = entry?.access;
  const flags = a?.verified === true && hasSourceUrl(a.sourceUrl)
    ? FIELDS.filter(f => typeof a[f] === 'boolean' && a.evidence?.[f]?.quote && hasSourceUrl(a.evidence[f].url)) : [];
  if (!flags.length) return legacy?.verified && hasSourceUrl(legacy.sourceUrl) ? legacy : undefined;
  const result = { verified: true, sourceUrl: a.sourceUrl };
  // False booleans hide affirmative badges; only explicit denials get a "No ..." badge.
  for (const f of FIELDS) result[f] = flags.includes(f) && a[f] === true;
  const denied = flags.filter(f => a[f] === false);
  if (denied.length) result.denied = denied;
  if (a.note && a.evidence?.note?.quote === a.note && hasSourceUrl(a.evidence.note.url)) result.notes = a.note;
  if (a.verifiedAt) result.checkedAt = a.verifiedAt;
  return result;
}

// Old seating text was copied from the same unsourced legacy records. Rebuild just that field.
function sourcedAccessTips(tips, accessibility) {
  if (!tips?.seating) return tips;
  const { accessibility: old, ...seating } = tips.seating;
  if (accessibility?.notes) seating.accessibility = accessibility.notes;
  return { ...tips, seating };
}

module.exports = { accessibilityFor, hasSourceUrl, sourcedAccessTips };
