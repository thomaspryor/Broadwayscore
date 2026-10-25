// Launch the crowned v33 successor. Seed = the v32 handoff brief path plus the
// standing orders; the successor reads the brief itself rather than inheriting
// a summary of it.
const fs = require('fs');
const { launchCmuxSession } = require('/Users/tompryor/Broadwayscore/scripts/lib/cmux-launch.js');

const BRIEF = '/Users/tompryor/Documents/claude-outputs/HANDOFF-crown-v32-2026-09-05.md';
if (!fs.existsSync(BRIEF)) {
  console.error('BRIEF MISSING:', BRIEF);
  process.exit(1);
}

const seed = `Read ${BRIEF} IN FULL before anything else. You OWN end-to-end delivery of everything in it: monitor to completion, independently re-verify every claim (a predecessor's "done" or "green" is a hypothesis, not a fact), fix what fails, and report ONE final verdict. Never scatter-and-trust.

SECOND ACTION, first turn: CronCreate the cron prompt at the bottom of that brief (section 'MY CRON PROMPT — reuse verbatim') at '13,43 * * * *'.

Start by re-deriving main's colour yourself, using the gh api form the brief gives you, NEVER gh run list --limit. v32 left the last COMPLETED run green at 45de1bde312, proven job-by-job, but two runs were still in progress at handoff and main's colour is the fastest-decaying fact in that document.

FIRST REAL TASK: BRO-2828 — prove opening-night-broadcast.yml actually clears its checklist gate. Read the STEP, never the run conclusion: two runs on 2026-09-05 report success with "Checklist gate" SKIPPED because they short-circuited at the 7 AM ET time gate. The next real test is the first run after 11:00 UTC (daily cron 12:30 UTC). Do NOT force-trigger it — that sends an outward-facing email.

SECOND: BRO-2835 — the MANDATORY temporal-override regression exits 1 on main, runs nowhere in CI, and prints a PASS banner while failing. I filed it but did not diagnose it.

THREE owner decisions are pending (iOS overnight worktrees now fully triaged to ONE reviewable diff, the Forbes/Marc Hershberg date, and the public-repo worktree-gc logs). Restate all three in full at the bottom of every message per the DECISION NEEDED template.

If YOUR context fills, write v33 and launch a successor the same way, verify it started via wrapper-process liveness, CronDelete your cron, close.`;

(async () => {
  try {
    const res = await launchCmuxSession({
      title: '👑 OWNER — Crown v33: P1 backlog dispatch + triage',
      seed,
      seedKey: 'crown-v33-2026-09-05',
      cwd: '/Users/tompryor/Broadwayscore',
      model: 'opus',
      workKey: 'crown-bro-343',
      verifyTimeoutSec: 90,
    });
    console.log('LAUNCH_RESULT ' + JSON.stringify(res, null, 2));
  } catch (e) {
    console.error('LAUNCH_FAILED ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  }
})();
