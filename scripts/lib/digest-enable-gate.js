'use strict';
// scripts/lib/digest-enable-gate.js — should a SCHEDULED morning-digest Action run send now? (BRO-6764)
//
// Two refusals, both fail-closed:
//  * before ENABLE_FROM (an ET calendar day; the handoffDate in config/morning-digest-handoff.json):
//    the Mac sender no-ops for owner sends from that same day (scripts/lib/digest-handoff.js), so the
//    Action must not send earlier or the owner gets two digests. A committed date, not a repo variable.
//  * before 07:45 ET: the workflow has cron lines for BOTH DST offsets (11:50/12:50/13:50 UTC) so
//    no March/November edit is needed; the early one for the current season is a no-op here, and
//    the Resend sent-today guard makes the later ones no-ops once the digest is out.
// Manual dispatch never goes through this gate.

const SEND_FROM_MINUTES_ET = 7 * 60 + 45;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function etParts(now) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function decideScheduledSend({ now = new Date(), enableFrom } = {}) {
  if (typeof enableFrom !== 'string' || !DAY_RE.test(enableFrom) || Number.isNaN(Date.parse(`${enableFrom}T00:00:00Z`))) {
    return { go: false, reason: `ENABLE_FROM "${enableFrom}" is not YYYY-MM-DD; refusing (fail closed)` };
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { go: false, reason: 'invalid clock; refusing' };
  const { day, minutes } = etParts(now);
  if (day < enableFrom) return { go: false, reason: `ET day ${day} is before ENABLE_FROM ${enableFrom}: the Mac job may still send` };
  if (minutes < SEND_FROM_MINUTES_ET) return { go: false, reason: `ET time is before 07:45 (DST-offset cron line that is early this season)` };
  return { go: true, reason: `ET ${day} is on/after ENABLE_FROM ${enableFrom} and past 07:45` };
}

if (require.main === module) {
  const r = decideScheduledSend({ enableFrom: process.argv[2] });
  console.log(`[digest-gate] ${r.go ? 'GO' : 'SKIP'} — ${r.reason}`);
  if (process.env.GITHUB_OUTPUT) require('fs').appendFileSync(process.env.GITHUB_OUTPUT, `go=${r.go}\n`);
}

module.exports = { decideScheduledSend, SEND_FROM_MINUTES_ET };
