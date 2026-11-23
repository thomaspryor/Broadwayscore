// LIVE-DATA-LANE: reads data/shows.json (untracked core data); data/audit/recurrence-classes.json (bot ledger) through the close-check modules. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
/**
 * linear-done-gate.test.mjs — BRO-3885 acceptance.
 *
 * The Linear Done gate (checkLinearDoneTransition) inherited
 * done-semantics-gate.js's VERIFY_CMD_RECORDED verdict, which only checks a
 * command's SHAPE (evaluateVerifiability/isSafeCheckCommand never run
 * anything) — the Notion→Linear migration dropped the execution half
 * (scripts/lib/close-time-verify.js) that Notion's `update --status Done`
 * still gets. BRO-3471 closed Done twice on a VERIFY: command naming a test
 * file that had never been created.
 *
 * These tests require() the real checkLinearDoneTransition and compose the
 * REAL runVerify (acceptance-check-core.js) + decideClose (close-time-verify.js)
 * — the exact functions notion-brain.js's close-time check uses — pointed at
 * a plain tmp directory instead of a real origin/main checkout, the same
 * substitution acceptance-check-core.test.mjs itself makes ("cwd - the fresh
 * checkout (or any directory, for tests)"). No stubbed verdicts: a real
 * missing-file command really returns 'unverifiable', a real passing test
 * file really returns 'pass', through the unmodified production functions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { checkLinearDoneTransition } = require(path.join(REPO, 'scripts/lib/linear-done-gate.js'));
const { runVerify } = require(path.join(REPO, 'scripts/lib/acceptance-check-core.js'));
const { decideClose, VERDICTS: CLOSE_VERDICTS } = require(path.join(REPO, 'scripts/lib/close-time-verify.js'));
const { VERDICTS: DONE_VERDICTS } = require(path.join(REPO, 'scripts/lib/done-semantics-gate.js'));

function tmpCheckout() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'linear-done-gate-test-'));
}

/** Real composition of runVerify + decideClose, exactly what
 * linear-cmd-execution.js's makeVerifyCmdEvidence() does, minus the git
 * checkout (cwd is handed in directly, same substitution runVerify's own
 * tests use). */
function realVerifyCmdEvidence(cwd) {
  return function verifyCmdEvidence(cmd) {
    const verifyResult = runVerify(cwd, cmd, { attempts: 1 });
    const dispatch = { verifyCmd: cmd, allowUnverifiable: false, verifyReason: null, taskId: null, matchedBy: null, entry: { source: 'test' } };
    const decision = decideClose({ dispatch, verifyResult });
    return { allowed: decision.verdict === CLOSE_VERDICTS.PASS, verdict: decision.verdict, reason: decision.message };
  };
}

test('BRO-3885: a VERIFY command naming a NONEXISTENT path is REFUSED, not trusted on shape', () => {
  const cwd = tmpCheckout();
  try {
    const gate = checkLinearDoneTransition({
      targetStateType: 'completed',
      description: 'VERIFY: node --test scripts/lib/does-not-exist-bro-3885.test.mjs',
      verifyCmdEvidence: realVerifyCmdEvidence(cwd),
    });
    assert.equal(gate.gated, true);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /does-not-exist-bro-3885\.test\.mjs/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('BRO-3885: a VERIFY command that actually PASSES is allowed', () => {
  const cwd = tmpCheckout();
  try {
    fs.mkdirSync(path.join(cwd, 'tests/unit'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'tests/unit/ok.test.mjs'),
      "import test from 'node:test';\ntest('ok', () => {});\n",
    );
    const gate = checkLinearDoneTransition({
      targetStateType: 'completed',
      description: 'VERIFY: node --test tests/unit/ok.test.mjs',
      verifyCmdEvidence: realVerifyCmdEvidence(cwd),
    });
    assert.equal(gate.gated, true);
    assert.equal(gate.allowed, true);
    assert.equal(gate.verdict, DONE_VERDICTS.VERIFY_CMD_RECORDED);
    // The proof this was actually EXECUTED, not just shape-checked.
    assert.equal(gate.cmdExecution.verdict, CLOSE_VERDICTS.PASS);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('BRO-3885: a VERIFY command that FAILS is refused (not just missing paths)', () => {
  const cwd = tmpCheckout();
  try {
    fs.mkdirSync(path.join(cwd, 'tests/unit'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'tests/unit/broken.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => { assert.equal(1, 2); });\n",
    );
    const gate = checkLinearDoneTransition({
      targetStateType: 'completed',
      description: 'VERIFY: node --test tests/unit/broken.test.mjs',
      verifyCmdEvidence: realVerifyCmdEvidence(cwd),
    });
    assert.equal(gate.allowed, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// The regression guard: if applyCmdExecution's call to verifyCmdEvidence is
// ever removed from checkLinearDoneTransition, a safe-shaped VERIFY command
// goes straight back to being trusted on shape alone (the old BRO-3471 hole)
// and this passes NO verifyCmdEvidence at all — so a caller that dropped the
// execution wiring would have this same shape and would need to be refused
// here exactly like a caller that forgot to build the real executor.
test('BRO-3885: with NO execution verifier wired in, a shape-only VERIFY command is refused, not trusted', () => {
  const gate = checkLinearDoneTransition({
    targetStateType: 'completed',
    description: 'VERIFY: node --test scripts/lib/some-real-looking-path.test.mjs',
    // verifyCmdEvidence deliberately omitted.
  });
  assert.equal(gate.gated, true);
  assert.equal(gate.allowed, false, 'a recorded command must never be treated as done-evidence without actually being run');
  assert.equal(gate.verdict, 'verify-cmd-unexecuted');
});

test('BRO-3885: PR-EVIDENCE path is untouched — a fully verified PR claim needs no cmd execution at all', () => {
  const gate = checkLinearDoneTransition({
    targetStateType: 'completed',
    description: 'PR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/commit/abcdef12345)',
    verifyEvidence: () => ({ verified: true, reason: 'commit is on origin/main', checked: [] }),
    // No verifyCmdEvidence — must not be needed on this path.
  });
  assert.equal(gate.gated, true);
  assert.equal(gate.allowed, true);
  assert.equal(gate.verdict, DONE_VERDICTS.PR_MERGED_DEPLOYED_CHECKED);
});

test('BRO-3885: no evidence at all is still refused (unchanged baseline)', () => {
  const gate = checkLinearDoneTransition({
    targetStateType: 'completed',
    description: 'just some prose with no acceptance criteria',
  });
  assert.equal(gate.gated, true);
  assert.equal(gate.allowed, false);
  assert.equal(gate.verdict, DONE_VERDICTS.BLOCKED_NO_EVIDENCE);
});

// BRO-5837: an infra timeout must not be captioned "was executed ... did not pass".
test('applyCmdExecution: infra-timeout verdict keeps its own reason, no "executed and did not pass" prefix', () => {
  const { checkLinearDoneTransition } = require('./linear-done-gate.js');
  const r = checkLinearDoneTransition({
    targetStateType: 'completed',
    description: 'VERIFY: node --test tests/unit/ok.test.mjs',
    verifyCmdEvidence: () => ({ allowed: false, verdict: 'verify-cmd-infra-timeout', reason: 'checkout timed out; re-run' }),
  });
  assert.equal(r.allowed, false);
  assert.equal(r.verdict, 'verify-cmd-infra-timeout');
  assert.equal(r.reason, 'checkout timed out; re-run');
});

// BRO-7879: evaluate the current UX card's own comments without a Linear key.
test('UX resolution uses this finding and fails closed for missing or malformed evidence', () => {
  const previous = process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_API_KEY;
  try {
    const key = '23609b65bef01ceb61605265e71412bc';
    const base = {
      targetStateType: 'completed', title: 'UX audit: Add a show button',
      description: `UX-FINDING: ${key}\nVERIFY: node scripts/lib/ux-walkthrough-resolution.js --key=${key}`,
      verifyCmdEvidence: () => ({ allowed: false, verdict: 'own-verify-unverifiable', reason: 'credential-withheld' }),
    };
    const reason = 'UX-RESOLUTION: noise: Checked the mobile watchlist and the button opens the date picker.';
    assert.equal(checkLinearDoneTransition({ ...base, existingComments: [reason] }).allowed, true);
    assert.equal(checkLinearDoneTransition({ ...base, commentText: reason }).allowed, true);
    for (const comments of [[], ['UX-RESOLUTION: noise: done'], [reason, 'UX-RESOLUTION: unresolved: Still broken']]) {
      assert.equal(checkLinearDoneTransition({ ...base, existingComments: comments }).allowed, false);
    }
    assert.equal(checkLinearDoneTransition({ ...base, title: 'Other card', existingComments: [reason] }).allowed, false);
    assert.equal(checkLinearDoneTransition({ ...base, description: base.description.replace(`UX-FINDING: ${key}`, `UX-FINDING: ${'b'.repeat(32)}`), existingComments: [reason] }).allowed, false);
  } finally {
    if (previous === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = previous;
  }
});

// BRO-7994: outside-setting close check.
test('BRO-7994 outsideSettingCloseCheck: the incident card (declared, 30-day recheck, test -f) is refused from the blocking date', async () => {
  const { outsideSettingCloseCheck } = (await import('node:module')).createRequire(import.meta.url)('./linear-done-gate.js');
  const card = 'OUTSIDE-SETTING: Google web client must list both site origins\nRECHECK-AFTER: 2026-12-21\nVERIFY: `test -f src/lib/google-one-tap.ts`';
  const before = outsideSettingCloseCheck({ description: card, nowMs: Date.parse('2026-11-21T12:00:00Z'), env: {} }, {});
  assert.equal(before.blocking, false);
  assert.match(before.message, /Advisory now/);
  const after = outsideSettingCloseCheck({ description: card, nowMs: Date.parse('2026-11-28T12:00:00Z'), env: {} }, {});
  assert.equal(after.blocking, true);
  assert.equal(outsideSettingCloseCheck({ description: card, nowMs: Date.parse('2026-11-28T12:00:00Z'), env: { OUTSIDE_SETTING_DONE_GATE: 'advisory' } }, {}).blocking, false);
});

test('BRO-7994 outsideSettingCloseCheck: no declaration, a LIVE-CHECK, or an executed real VERIFY passes', async () => {
  const { outsideSettingCloseCheck } = (await import('node:module')).createRequire(import.meta.url)('./linear-done-gate.js');
  const nowMs = Date.parse('2026-11-28T12:00:00Z');
  assert.equal(outsideSettingCloseCheck({ description: 'plain card', nowMs, env: {} }, {}), null);
  const decl = 'OUTSIDE-SETTING: Google web client must list both site origins';
  assert.equal(outsideSettingCloseCheck({ description: decl, commentText: 'LIVE-CHECK: 5 One Tap sign-ins completed since 14:00', nowMs, env: {} }, {}), null);
  assert.equal(outsideSettingCloseCheck({ description: decl, nowMs, env: {} }, { cmdExecution: { allowed: true }, cmd: 'node scripts/check-alert-condition-absent.js --key-b64 eA' }), null);
  assert.notEqual(outsideSettingCloseCheck({ description: decl, nowMs, env: {} }, { cmdExecution: { allowed: true }, cmd: 'test -f src/lib/google-one-tap.ts' }), null);
});

test('BRO-7994 outsideSettingCloseCheck: a short real recheck does not clear Done (it is a reason to pause)', async () => {
  const { outsideSettingCloseCheck } = (await import('node:module')).createRequire(import.meta.url)('./linear-done-gate.js');
  const nowMs = Date.parse('2026-11-28T12:00:00Z');
  const card = 'OUTSIDE-SETTING: Google web client must list both site origins\nRECHECK-AFTER: 2026-11-30\nVERIFY: `node scripts/lib/account-metrics.js --one-tap --min=2`';
  const r = outsideSettingCloseCheck({ description: card, nowMs, env: {} }, {});
  assert.notEqual(r, null);
  assert.equal(r.blocking, true);
  assert.match(r.message, /Paused \(not Done\)/);
});

test('BRO-7994 outsideSettingCloseCheck: NO-OUTSIDE-SETTING on the card clears it', async () => {
  const { outsideSettingCloseCheck } = (await import('node:module')).createRequire(import.meta.url)('./linear-done-gate.js');
  const card = 'OUTSIDE-SETTING: Google web client must list both site origins\nNO-OUTSIDE-SETTING: the origins were already listed before this change shipped';
  assert.equal(outsideSettingCloseCheck({ description: card, nowMs: Date.parse('2026-11-28T12:00:00Z'), env: {} }, {}), null);
});

// ── BRO-8079: Done checked process, not results ─────────────────────────────
const BRO_7930_TITLE = '_pending intake drain promotes 0 (6,838 waiting) + 313 limbo files neither scored nor rejected';
const passingVerify = () => ({ allowed: true, verdict: 'pass', reason: 'exit 0' });
const NOW_BLOCKING = Date.parse('2026-12-01T00:00:00Z');

test('BRO-8079: a data-count card with only a passing unit-test VERIFY is REFUSED Done', () => {
  const gate = checkLinearDoneTransition({
    targetStateType: 'completed',
    identifier: 'BRO-7930',
    title: BRO_7930_TITLE,
    description: 'VERIFY: node --test scripts/lib/pending-drain.test.mjs',
    commentText: 'Outcome: drain fixed, tests pass.',
    verifyCmdEvidence: passingVerify,
    env: {},
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.verdict, 'data-effect-unmeasured');
  assert.match(gate.reason, /promotes 0/);
  assert.match(gate.reason, /RECHECK-AFTER/);
});

test('BRO-8079: the same card is ALLOWED with a measured EFFECT before -> after line naming the command', () => {
  const gate = checkLinearDoneTransition({
    targetStateType: 'completed',
    identifier: 'BRO-7930',
    title: BRO_7930_TITLE,
    description: 'VERIFY: node --test scripts/lib/pending-drain.test.mjs',
    commentText: 'Outcome: drain fixed.\nEFFECT: _pending queue 6,838 -> 412 after one drain, measured by `node scripts/count-pending.js`',
    verifyCmdEvidence: passingVerify,
    env: {},
  });
  assert.equal(gate.allowed, true, gate.reason);
});

test('BRO-8079: an EFFECT with no numbers, no command, or "pending" is still refused', () => {
  for (const effect of [
    'EFFECT: the queue drains now',
    'EFFECT: 6,838 -> 412',
    'EFFECT: 6,838 -> numbers pending, `node scripts/count-pending.js`',
  ]) {
    const gate = checkLinearDoneTransition({
      targetStateType: 'completed', title: BRO_7930_TITLE, description: 'VERIFY: node --test scripts/lib/x.test.mjs',
      commentText: effect, verifyCmdEvidence: passingVerify, env: {},
    });
    assert.equal(gate.allowed, false, effect);
    assert.equal(gate.verdict, 'data-effect-unmeasured', effect);
  }
});

test('BRO-8079: an EFFECT line written into the card DESCRIPTION is a wish, not a measurement', () => {
  const gate = checkLinearDoneTransition({
    targetStateType: 'completed', title: BRO_7930_TITLE,
    description: 'VERIFY: node --test scripts/lib/x.test.mjs\nEFFECT: 6,838 -> 0 via `node scripts/count-pending.js`',
    verifyCmdEvidence: passingVerify, env: {},
  });
  assert.equal(gate.allowed, false);
});

test('BRO-8079: a non-data card is untouched; NO-DATA-EFFECT and the advisory env clear a false positive', () => {
  const plain = checkLinearDoneTransition({
    targetStateType: 'completed', title: 'Rename the board report header', description: 'VERIFY: node --test scripts/lib/x.test.mjs',
    verifyCmdEvidence: passingVerify, env: {},
  });
  assert.equal(plain.allowed, true);
  const bypass = checkLinearDoneTransition({
    targetStateType: 'completed', title: BRO_7930_TITLE, description: 'VERIFY: node --test scripts/lib/x.test.mjs',
    commentText: 'NO-DATA-EFFECT: the count in the title is the incident, this card only renames the script',
    verifyCmdEvidence: passingVerify, env: {},
  });
  assert.equal(bypass.allowed, true);
  const advisory = checkLinearDoneTransition({
    targetStateType: 'completed', title: BRO_7930_TITLE, description: 'VERIFY: node --test scripts/lib/x.test.mjs',
    verifyCmdEvidence: passingVerify, env: { DATA_EFFECT_DONE_GATE: 'advisory' },
  });
  assert.equal(advisory.allowed, true);
  assert.match(advisory.warning, /data count/);
});

test('BRO-8079: a worker Outcome claiming a settle rate needs a SAMPLE-AUDIT of 20+ urls (blocking from its date)', () => {
  const claim = 'Outcome: 2025-26: 98% settled/junk/duplicate.\nNO-DATA-EFFECT: rate card, see sample audit below';
  const refused = checkLinearDoneTransition({
    targetStateType: 'completed', title: 'Settle 2025-26 stub backlog', description: 'VERIFY: node --test scripts/lib/x.test.mjs',
    commentText: claim, verifyCmdEvidence: passingVerify, nowMs: NOW_BLOCKING, env: {},
  });
  assert.equal(refused.allowed, false);
  assert.equal(refused.verdict, 'sample-audit-missing');
  const urls = Array.from({ length: 20 }, (_, i) => `- https://www.talkinbroadway.com/page/ob/sample-${i}.html settled correctly`).join('\n');
  const allowed = checkLinearDoneTransition({
    targetStateType: 'completed', title: 'Settle 2025-26 stub backlog', description: 'VERIFY: node --test scripts/lib/x.test.mjs',
    commentText: `${claim}\nSAMPLE-AUDIT: 20 random settled stubs, 0 wrong\n${urls}`, verifyCmdEvidence: passingVerify, nowMs: NOW_BLOCKING, env: {},
  });
  assert.equal(allowed.allowed, true, allowed.reason);
  const short = checkLinearDoneTransition({
    targetStateType: 'completed', title: 'Settle 2025-26 stub backlog', description: 'VERIFY: node --test scripts/lib/x.test.mjs',
    commentText: `${claim}\nSAMPLE-AUDIT: 3 urls, 0 wrong\n${urls.split('\n').slice(0, 3).join('\n')}`, verifyCmdEvidence: passingVerify, nowMs: NOW_BLOCKING, env: {},
  });
  assert.equal(short.allowed, false);
  const early = checkLinearDoneTransition({
    targetStateType: 'completed', title: 'Settle 2025-26 stub backlog', description: 'VERIFY: node --test scripts/lib/x.test.mjs',
    commentText: claim, verifyCmdEvidence: passingVerify, nowMs: Date.parse('2026-11-23T00:00:00Z'), env: {},
  });
  assert.equal(early.allowed, true);
  assert.match(early.warning, /SAMPLE-AUDIT/);
});

test('BRO-8079 part 2: a job-stranded row produces a wake for the dispatching session (full suite: dispatcher-wake.test.mjs)', () => {
  const { planDispatcherWakes } = require(path.join(REPO, 'scripts/lib/dispatcher-wake.js'));
  const by = { sessionId: '12bb3cbc', workspaceId: 'AAAA-1111' };
  const wakes = planDispatcherWakes([
    { ts: '2026-11-22T19:00:00Z', event: 'launch', taskId: 'linear:BRO-8065', subject: 'BRO-8065 settle stubs', dispatchedBy: by },
    { ts: '2026-11-22T21:54:38Z', event: 'job-stranded', taskId: 'linear:BRO-8065', sha: 'd48e51d594d4b656aad548febf99acf4a3ff0e5b' },
  ], { nowMs: Date.parse('2026-11-22T22:30:00Z') });
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].workspaceId, by.workspaceId);
});

test('BRO-8079 ship-check: unchanged counts, date spans and non-command backticks are not a measurement', () => {
  for (const effect of [
    'EFFECT: _pending queue 6,838 -> 6,838, measured by `node scripts/count-pending.js`',
    'EFFECT: measured from 2026-11-21 to 2026-11-22 via `node scripts/count-pending.js`',
    'EFFECT: 6,838 -> 412 `looks good now`',
  ]) {
    const gate = checkLinearDoneTransition({
      targetStateType: 'completed', title: BRO_7930_TITLE, description: 'VERIFY: node --test scripts/lib/x.test.mjs',
      commentText: effect, verifyCmdEvidence: passingVerify, env: {},
    });
    assert.equal(gate.allowed, false, effect);
  }
});

test('BRO-8079 ship-check: ordinary titles are not data-count cards; weak count phrases only warn', async () => {
  const { dataCountMatch } = require(path.join(REPO, 'scripts/lib/data-effect-close.js'));
  for (const t of ['Fix 404 on show pages', 'P1: 500 error on review page', 'Top 10 shows page redesign', 'Upgrade to Next 15 reviews', 'Mobile shows 2 rows of cards', 'Render top 20 items in list', 'Get 100% of tests passing']) {
    assert.equal(dataCountMatch({ title: t }), null, t);
  }
  assert.equal(dataCountMatch({ title: BRO_7930_TITLE }).strong, true);
  assert.equal(dataCountMatch({ title: 'TR wrong_show repair, part 3: 8 files still rejected' }).strong, false);
  const weak = checkLinearDoneTransition({
    targetStateType: 'completed', title: 'TR wrong_show repair, part 3: 8 files still rejected', description: 'VERIFY: node --test scripts/lib/x.test.mjs',
    verifyCmdEvidence: passingVerify, env: {},
  });
  assert.equal(weak.allowed, true);
  assert.match(weak.warning, /data count/);
});

test('BRO-8079 ship-check: the nightly recheck auto-close of a Paused RECHECK-AFTER card is warned, not refused', () => {
  const gate = checkLinearDoneTransition({
    targetStateType: 'completed', title: BRO_7930_TITLE, description: 'VERIFY: node --test scripts/lib/x.test.mjs\nRECHECK-AFTER: 2026-11-25',
    commentText: 'Auto-closed by the nightly acceptance re-check: `node scripts/count-pending.js --max=500` passed on main.',
    verifyCmdEvidence: passingVerify, env: {},
  });
  assert.equal(gate.allowed, true, gate.reason);
  assert.match(gate.warning, /data count/);
});

test('BRO-8079 ship-check: SAMPLE-AUDIT urls after the block (Key Files, PR links) do not count, and the wrong count is required', () => {
  const urls = Array.from({ length: 20 }, (_, i) => `- https://www.standard.co.uk/culture/theatre/r-${i}`).join('\n');
  const base = { targetStateType: 'completed', title: 'Settle stubs', description: 'VERIFY: node --test scripts/lib/x.test.mjs', verifyCmdEvidence: passingVerify, nowMs: NOW_BLOCKING, env: {} };
  const noWrong = checkLinearDoneTransition({ ...base, commentText: `98% settled/junk.\nSAMPLE-AUDIT: 20 random\n${urls}` });
  assert.equal(noWrong.allowed, false);
  const outside = checkLinearDoneTransition({ ...base, commentText: `98% settled/junk.\nSAMPLE-AUDIT: 2 sampled, 0 wrong\n- https://a.com/x\n\nKey files:\n${urls}` });
  assert.equal(outside.allowed, false);
});

// ── BRO-8079 reopen (2026-11-23): keyword guessing on title phrasing missed real data cards ──
// Live probe on main 224437eb846: BRO-8091 -> no match (Done accepted with no EFFECT line), BRO-8090 -> weak (warn only).
const REAL_CARDS = {
  'BRO-8091': {
    title: 'Drain the _pending fetch candidates: 33 (2025-26), 166 (2015-24), 747 (pre-2015), chained + checkpointed, subscriber outlets via logged-in browser',
    description: '## Acceptance criteria\n\n* EFFECT: open candidates per era before -> after; promoted count; promoted reviews present in reviews.json on main after the CI rebuild.\n* 20-item sample of promoted stubs checked against the page.\n* VERIFY: `node --test tests/unit/pending-triage.test.mjs`\n',
  },
  'BRO-8090': {
    title: 'P1: _pending triage wrongly settles real reviews: ~415 belong to a tracked sibling production (junked as out-of-window) + 29 opaque URLs settled by url-token-mismatch',
    description: '## Acceptance criteria\n\n* Tests using the King of the Yees and 1536 examples (red on old code).\n* EFFECT: settled-but-real count before -> after; rehomed count.\n* VERIFY: `node --test tests/unit/pending-triage.test.mjs`\n',
  },
  'BRO-7930': { title: BRO_7930_TITLE, description: '## Acceptance criteria\n\nVERIFY: node scripts/validate-data.js\n' },
  'BRO-8023': {
    title: 'P1: ~500-600 real 2025-26 reviews stuck in _pending (6,786 queue, drain promotes 0 despite BRO-7930 Done); floors report blind to them',
    description: '## Acceptance criteria\n\n* VERIFY: `node --test tests/unit/pending-triage.test.mjs`\n',
  },
  'BRO-7569': {
    title: 'Close full-text gaps for 2025-26 shows across major outlets (~200 reviews: 78 stub, 71 excerpt, 47 truncated)',
    description: '## Acceptance criteria\n\n* VERIFY: node --test scripts/lib/review-guards.test.mjs\n',
  },
};

test('BRO-8079 reopen: all five real data cards are BLOCKED Done on a passing unit-test VERIFY alone', () => {
  for (const [id, card] of Object.entries(REAL_CARDS)) {
    const gate = checkLinearDoneTransition({
      targetStateType: 'completed', identifier: id, title: card.title, description: card.description,
      commentText: 'Outcome: fixed, tests pass.', verifyCmdEvidence: passingVerify, env: {},
    });
    assert.equal(gate.allowed, false, `${id}: ${gate.reason}`);
    assert.equal(gate.verdict, 'data-effect-unmeasured', id);
  }
});

test('BRO-8079 reopen: the same five cards are ALLOWED with a measured EFFECT line', () => {
  for (const [id, card] of Object.entries(REAL_CARDS)) {
    const gate = checkLinearDoneTransition({
      targetStateType: 'completed', identifier: id, title: card.title, description: card.description,
      commentText: 'Outcome: fixed.\nEFFECT: open candidates 946 -> 120, measured by `node scripts/count-pending.js --by-era`\nNO-SAMPLE-AUDIT: fixture, no rate claimed here',
      verifyCmdEvidence: passingVerify, env: {},
    });
    assert.equal(gate.verdict === 'data-effect-unmeasured', false, `${id}: ${gate.reason}`);
  }
});

test('BRO-8079 reopen: any card whose description carries an EFFECT: line is a strong data card, whatever its title', () => {
  const { dataCountMatch } = require(path.join(REPO, 'scripts/lib/data-effect-close.js'));
  const m = dataCountMatch({ title: 'Tidy the drain script', description: 'Notes\n- EFFECT: queue before -> after\n' });
  assert.equal(m && m.strong, true);
  // Prose that only mentions the word inline, or other EFFECT-ish tokens, does not count.
  for (const description of ['must require an `EFFECT: <before> -> <after>` line', 'NO-EFFECT-CHECK: docs only', 'NO-DATA-EFFECT: not a data card']) {
    assert.equal(dataCountMatch({ title: 'Tidy the drain script', description }), null, description);
  }
});

test('BRO-8079 reopen: a number >= 10 next to a data noun, in either order, is strong; small numbers and years are not', () => {
  const { dataCountMatch } = require(path.join(REPO, 'scripts/lib/data-effect-close.js'));
  for (const t of ['Drain the 6,500 pending candidates', 'Drain candidates: 6500', '29 opaque URLs settled wrongly', 'TR wrong_show repair, part 3: 88 files still rejected', 'Backfill 120 critic records', 'stubs: 78 left for 2025-26', 'Fix 35 broken links on show pages']) {
    const m = dataCountMatch({ title: t });
    assert.equal(m && m.strong, true, t);
  }
  for (const t of ['Fix 404 on show pages', 'Top 10 shows page redesign', 'Tony 2026 shows page', 'Mobile shows 2 rows of cards', 'Add 3 reviews to the fixture']) {
    const m = dataCountMatch({ title: t });
    assert.equal(Boolean(m && m.strong), false, t);
  }
});
