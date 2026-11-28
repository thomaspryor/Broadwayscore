#!/usr/bin/env node
/**
 * Dispatcher Canary (card #1073, W5.3)
 *
 * Mac-local, standalone test harness for the Investigate→Fix escalation
 * decision and its storm behavior — WITHOUT touching Notion or spawning a
 * `claude` session. This is NOT a CI test: it exercises
 * scripts/lib/plan-ready.js's shouldEscalateToFix() directly against a
 * fixture table that mirrors how notion-action-poll.js actually calls it
 * (see the call site there for the real wiring), so a change to the guard
 * logic or the storm-handling loop shape can be sanity-checked in seconds
 * on the machine that actually runs the dispatcher.
 *
 * Usage: node scripts/dispatcher-canary.js
 * Exit code: 0 if every case PASSes, 1 if any FAILs.
 */

const { shouldEscalateToFix, AUTO_ROUTER_TAG } = require('./lib/plan-ready.js');

const ELIGIBLE_CARD = {
  tags: [AUTO_ROUTER_TAG],
  priority: 'P1 Next',
  notes: 'Condition "gap:some-show-2026/nyt.json" no longer fires on the next check.',
};

const NON_ALLOWLISTED_CARD = {
  tags: [AUTO_ROUTER_TAG],
  priority: 'P1 Next',
  notes: 'Condition "contradiction:some-show-2026/wapo.json" no longer fires on the next check.',
};

let failures = 0;

function report(name, pass, detail) {
  const line = `${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`;
  console.log(line);
  if (!pass) failures += 1;
}

// (a) single eligible T1-gap card → escalates.
function caseSingleEligible() {
  const ctx = { hadChanges: false, alreadyEscalated: false, escalatedThisCycle: 0, killSwitch: false };
  const result = shouldEscalateToFix(ELIGIBLE_CARD, ctx);
  report('(a) single eligible T1-gap card escalates', result === true, `got ${result}`);
}

// (b) a 10-card storm in one cycle → exactly 2 escalate, 8 deferred. Mirrors
// how notion-action-poll.js's main loop threads a single escalatedThisCycle
// counter across every card it processes in one poll (see the call site
// there — the counter only increments on an actual escalation, same as here).
function caseStorm() {
  let escalatedThisCycle = 0;
  let escalatedCount = 0;
  let deferredCount = 0;
  for (let i = 0; i < 10; i++) {
    const ctx = { hadChanges: false, alreadyEscalated: false, escalatedThisCycle, killSwitch: false };
    const escalate = shouldEscalateToFix(ELIGIBLE_CARD, ctx);
    if (escalate) {
      escalatedThisCycle += 1;
      escalatedCount += 1;
    } else {
      deferredCount += 1;
    }
  }
  report('(b) 10-card storm: exactly 2 escalate, 8 deferred',
    escalatedCount === 2 && deferredCount === 8,
    `escalated=${escalatedCount} deferred=${deferredCount}`);
}

// (c) kill-switch file present → 0 escalate. The real kill switch is a file
// existence check (~/.claude-action-dispatcher/escalation-off) done ONCE per
// poll in notion-action-poll.js and threaded into ctx.killSwitch for every
// card — this canary exercises the resulting ctx shape directly rather than
// touching the filesystem, since the file check itself is a one-line
// fs.existsSync with nothing to regress.
function caseKillSwitch() {
  const ctx = { hadChanges: false, alreadyEscalated: false, escalatedThisCycle: 0, killSwitch: true };
  const result = shouldEscalateToFix(ELIGIBLE_CARD, ctx);
  report('(c) kill-switch present: 0 escalate', result === false, `got ${result}`);
}

// (d) already-escalated card → not re-escalated.
function caseAlreadyEscalated() {
  const ctx = { hadChanges: false, alreadyEscalated: true, escalatedThisCycle: 0, killSwitch: false };
  const result = shouldEscalateToFix(ELIGIBLE_CARD, ctx);
  report('(d) already-escalated card is not re-escalated', result === false, `got ${result}`);
}

// (e) non-allowlisted condition → never escalates, regardless of anything else.
function caseNonAllowlisted() {
  const ctx = { hadChanges: false, alreadyEscalated: false, escalatedThisCycle: 0, killSwitch: false };
  const result = shouldEscalateToFix(NON_ALLOWLISTED_CARD, ctx);
  report('(e) non-allowlisted condition never escalates', result === false, `got ${result}`);
}

caseSingleEligible();
caseStorm();
caseKillSwitch();
caseAlreadyEscalated();
caseNonAllowlisted();

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
