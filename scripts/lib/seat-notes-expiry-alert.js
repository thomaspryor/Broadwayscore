'use strict';
/**
 * Alert decision for the seat-note value-expiry audit (BRO-8057). Pure: rows in
 * (from valueNotesNearExpiry), one audit-alert decision out.
 */
const { buildAuditAlert } = require('./audit-alert');

const CONDITION_KEY = 'seat-notes-value-expiry';

function decideSeatNoteExpiryAlert(found) {
  const rows = (found || []).map((f) => (
    `${f.theater} (${f.where}): ${f.invalid ? 'verification date missing or invalid, hidden on the site' : f.daysLeft <= 0 ? `expired ${-f.daysLeft}d ago, hidden on the site` : `hides in ${f.daysLeft}d`}`
  ));
  return buildAuditAlert({
    conditionKey: CONDITION_KEY,
    rows,
    title: (n) => `Seat-note "good value" tips expiring or expired (${n})`,
    intro: 'Good-value seat notes are hidden 270 days after they were last verified, because prices move. An expired value note can also drop the whole Where to Sit card below its two-note minimum.',
    hint: 'Re-verify the listed theaters: node scripts/seat-notes.js fetch, ground, then apply for each theater (see the header of scripts/seat-notes.js). Grounding only proves a quote exists and names the place, not that the price is current: open the source page and confirm the price still holds before applying, and drop the note if it does not. Done when node scripts/audit-seat-notes-expiry.js --strict exits 0.',
  });
}

module.exports = { decideSeatNoteExpiryAlert, CONDITION_KEY };
