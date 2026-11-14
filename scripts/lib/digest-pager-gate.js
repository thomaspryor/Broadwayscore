'use strict';
// scripts/lib/digest-pager-gate.js — should this check-morning-digest-sent.yml run do its check now? (BRO-7017)
//
// The pager cron (16:45Z) starts 2-7h late in this repo (BRO-4282), so it also wakes on finished
// Test Suite / Deploy to Vercel runs. A cron or wake may check only at/after 11:45 ET (15 min past the edge where the
// catch-up sender stops, see digest-enable-gate.js) and only once per ET day: the workflow keys an
// Actions-cache marker on `day`, so extra wakes add no alert-ledger commit and never re-arm the 20h cooldown.
// Manual dispatch (a deliberate check, possibly with --date) always goes.

const { etParts, SEND_UNTIL_MINUTES_ET } = require('./digest-enable-gate.js');

// 15 min after the catch-up sender's last send minute (SEND_UNTIL 11:30 ET): a sender run that passed its gate at 11:29 is still
// sending, and the pager must not page for a digest that is seconds from landing.
const CHECK_FROM_MINUTES_ET = SEND_UNTIL_MINUTES_ET + 15;

function decidePagerWake({ now = new Date(), event, alreadyRan = false } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { go: false, day: '', reason: 'invalid clock; skipping' };
  const { day, minutes } = etParts(now);
  if (event === 'workflow_dispatch') return { go: true, day, reason: 'manual dispatch always checks' };
  if (alreadyRan) return { go: false, day, reason: `already checked for ET ${day}` };
  // Cron too: a cron delayed past midnight ET would otherwise consume the NEW day's marker before 09:00, when the checker no-ops.
  if (minutes < CHECK_FROM_MINUTES_ET) return { go: false, day, reason: 'ET time is before 11:45: too early to check' };
  return { go: true, day, reason: `ET ${day} check due (${event})` };
}

if (require.main === module) {
  const r = decidePagerWake({ event: process.argv[2], alreadyRan: process.argv[3] === 'true' });
  console.log(`[pager-gate] ${r.go ? 'GO' : 'SKIP'} — ${r.reason}`);
  if (process.env.GITHUB_OUTPUT) require('fs').appendFileSync(process.env.GITHUB_OUTPUT, `go=${r.go}\nday=${r.day}\n`);
}

module.exports = { decidePagerWake, CHECK_FROM_MINUTES_ET };
