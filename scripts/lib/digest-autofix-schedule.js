'use strict';
// scripts/lib/digest-autofix-schedule.js — when the Mac runs the digest's auto-fix part on its own
// (BRO-6764, Mac-to-cloud Phase 2b). Pure; the spawn lives in scripts/checkout-sync-post.js.
//
// Why: runAutofix()/runAutofixCanary() are only ever called from send-morning-digest.js on the Mac
// (they need its task dir and dispatch fleet). Once com.broadwayscore.morning-digest is retired and
// the email goes out from GitHub (--no-autofix), nothing would run them. So after the retire entry
// is past its grace date, the first successful checkout-sync tick after AUTOFIX_FROM_HOUR_ET each ET
// day runs `send-morning-digest.js --autofix-only` once. Before the entry is acted on, the Mac's own
// digest run still does auto-fix, so this stays off (no double run).
//
// Runs EARLY (from 05:00 ET) so the report-only rows in the 07:30 email see fresh card state.

const { dayKeyET } = require('./scheduled-email-count-rules');
const { RETIRE_GRACE_DAYS } = require('./mac-retired-reconciler.js');

const DIGEST_LABEL = 'com.broadwayscore.morning-digest';
const AUTOFIX_FROM_HOUR_ET = 5;

function etHour(now) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

// config: parsed mac-retired.json. last: { dayET } from the state file, or null.
function shouldRunAutofix({ config, last, now = new Date() }) {
  const entry = ((config && config.entries) || []).find((e) => e && e.label === DIGEST_LABEL);
  if (!entry) return { run: false, reason: 'morning-digest is not retired; its own run does auto-fix' };
  const actAt = Date.parse(`${entry.retiredAt}T00:00:00Z`) + RETIRE_GRACE_DAYS * 86400e3;
  if (Number.isNaN(actAt) || now.getTime() < actAt) return { run: false, reason: 'retire entry not past its grace date; the Mac digest run still does auto-fix' };
  const dayET = dayKeyET(now.toISOString());
  if (etHour(now) < AUTOFIX_FROM_HOUR_ET) return { run: false, reason: `before ${AUTOFIX_FROM_HOUR_ET}:00 ET`, dayET };
  if (last && last.dayET === dayET) return { run: false, reason: `already ran for ${dayET}`, dayET };
  return { run: true, reason: `first sync tick after ${AUTOFIX_FROM_HOUR_ET}:00 ET on ${dayET}`, dayET };
}

module.exports = { DIGEST_LABEL, AUTOFIX_FROM_HOUR_ET, shouldRunAutofix };
