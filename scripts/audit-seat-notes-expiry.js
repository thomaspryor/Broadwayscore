#!/usr/bin/env node
'use strict';
/**
 * Advisory: warn before "good value" seat notes expire (BRO-8057).
 *
 * A value note is hidden at render once its verifiedAt is older than
 * VALUE_MAX_AGE_DAYS (scripts/lib/seat-notes-publish.js). Nothing re-checks
 * prices on a schedule, so without this a theater's Best value line would
 * vanish silently (and the card could fall below the two-note bar).
 *
 *   node scripts/audit-seat-notes-expiry.js [--warn-days=60] [--strict] [--alert] [--json]
 *
 * Exit 0 always, unless --strict and something is expiring or expired (exit 1).
 * --alert files one worker card (scripts/lib/audit-alert.js) and closes it when clean.
 * Also prints GitHub ::warning:: lines. Re-verify by
 * re-running scripts/seat-notes.js (fetch, ground, apply) for the theater.
 */

const fs = require('fs');
const path = require('path');
const { valueNotesNearExpiry, VALUE_MAX_AGE_DAYS } = require('./lib/seat-notes-publish');
const { decideSeatNoteExpiryAlert } = require('./lib/seat-notes-expiry-alert');
const { routeAuditDecisions } = require('./lib/audit-alert');

const META = path.join(__dirname, '..', 'data', 'theater-metadata.json');

async function main(argv) {
  const warnArg = argv.find((a) => a.startsWith('--warn-days='));
  const warnDays = warnArg ? Number(warnArg.split('=')[1]) : 60;
  if (!Number.isFinite(warnDays) || warnDays < 0) { console.error('audit-seat-notes-expiry: --warn-days must be a non-negative number'); return 2; }
  const strict = argv.includes('--strict');
  const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
  const found = valueNotesNearExpiry(meta, { today: new Date(), warnDays });

  if (argv.includes('--json')) console.log(JSON.stringify(found, null, 2));
  for (const f of found) {
    const when = f.daysLeft <= 0 ? `expired ${-f.daysLeft} days ago and is now hidden` : `expires in ${f.daysLeft} days`;
    console.log(`::warning::Seat-note value tip for ${f.theater} (${f.where}) ${when}. Re-verify with scripts/seat-notes.js.`);
  }
  if (!found.length) console.log(`Seat-note value tips: none expiring within ${warnDays} days (max age ${VALUE_MAX_AGE_DAYS}).`);
  if (argv.includes('--alert')) await routeAuditDecisions(decideSeatNoteExpiryAlert(found), 'audit-seat-notes-expiry');
  return strict && found.length ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`audit-seat-notes-expiry: ${e.stack || e.message}`); process.exitCode = 3; });
}
module.exports = { main };
