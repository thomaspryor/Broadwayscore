'use strict';
// scripts/lib/digest-autofix-schedule.js — when the Mac runs the digest's auto-fix part on its own
// (BRO-6764, Mac-to-cloud Phase 2b). Pure; the spawn lives in scripts/checkout-sync-post.js.
//
// Why: runAutofix()/runAutofixCanary() are only ever called from send-morning-digest.js on the Mac
// (they need its task dir and dispatch fleet). From the handoff date (config/morning-digest-handoff.json)
// the email goes out from GitHub (--no-autofix) and the Mac's digest run no-ops, so nothing would run
// them. So from that date the first successful checkout-sync tick after AUTOFIX_FROM_HOUR_ET each ET
// day runs `send-morning-digest.js --autofix-only` once. Before the handoff date the Mac's own digest
// run still does auto-fix, so this stays off (no double run).
//
// Runs EARLY (from 05:00 ET) so the report-only rows in the 07:30 email see fresh card state.

const { dayKeyET } = require('./scheduled-email-count-rules');
const { handoffDate } = require('./digest-handoff.js');

const AUTOFIX_FROM_HOUR_ET = 5;

function etHour(now) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

// handoff: the ET handoff date (YYYY-MM-DD), default from config/morning-digest-handoff.json.
// last: { dayET } from the state file, or null.
function shouldRunAutofix({ handoff = handoffDate(), last, now = new Date() }) {
  const dayET = dayKeyET(now.toISOString());
  if (dayET < handoff) return { run: false, reason: `before the handoff date ${handoff}; the Mac digest run still does auto-fix`, dayET };
  if (etHour(now) < AUTOFIX_FROM_HOUR_ET) return { run: false, reason: `before ${AUTOFIX_FROM_HOUR_ET}:00 ET`, dayET };
  if (last && last.dayET === dayET) return { run: false, reason: `already ran for ${dayET}`, dayET };
  return { run: true, reason: `first sync tick after ${AUTOFIX_FROM_HOUR_ET}:00 ET on ${dayET}`, dayET };
}

module.exports = { AUTOFIX_FROM_HOUR_ET, shouldRunAutofix };
