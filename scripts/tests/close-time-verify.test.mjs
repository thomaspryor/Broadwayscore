/**
 * close-time-verify.test.mjs — task #1003 acceptance.
 *
 * The four cases the card names:
 *   (a) a card whose OWN verifyCmd fails on a fresh origin/main checkout is
 *       refused Done
 *   (b) a card with an unrelated failing trunk closes normally
 *   (c) a card with no verifyCmd warns, does not block
 *   (d) the dry-run count is reported
 *
 * Plus the wiring proof: notion-brain.js's Done path really calls this, and
 * acceptance-check-core's runVerify really returns pass/fail/unverifiable when
 * pointed at a real command (no mock — CLAUDE.md §15).
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
const {
  CLOSE_REFUSED_EXIT_CODE, VERDICTS,
  normalizeNotionId, findCardDispatch, decideClose, summarizeDryRun,
} = require(path.join(REPO, 'scripts/lib/close-time-verify.js'));
const { runVerify } = require(path.join(REPO, 'scripts/lib/acceptance-check-core.js'));

// Real dispatch-ledger lines, verbatim shape from data/audit/dispatch-ledger.jsonl.
const LEDGER = [
  { ts: '2026-08-04T20:00:00.000Z', event: 'launch', taskId: '956', subject: 'tickets', workspaceRef: 'workspace:9', notionId: 'aaaaaaaa-1111-2222-3333-444444444444', verifyCmd: 'node --test scripts/tests/tm-gap-links.test.mjs', verifyReason: null, allowUnverifiable: null },
  { ts: '2026-08-04T21:15:38.874Z', event: 'launch', taskId: '1002', subject: 'drive main green', workspaceRef: 'workspace:170', notionId: null, verifyCmd: null, verifyReason: 'card has no acceptance-criteria section or VERIFY line', allowUnverifiable: null },
  { ts: '2026-08-04T21:16:01.808Z', event: 'launch', taskId: '1003', subject: 'close-time verify', workspaceRef: 'workspace:171', notionId: '3b2637c5-416f-8167-9908-e84c6deb38f5', verifyCmd: 'node --test scripts/tests/close-time-verify.test.mjs', verifyReason: null, allowUnverifiable: null },
  { ts: '2026-08-04T21:20:00.000Z', event: 'dead', taskId: '1003', workspaceRef: 'workspace:171' },
];

test('(a) a card whose OWN acceptance command fails on origin/main is refused Done', () => {
  const dispatch = findCardDispatch({ entries: LEDGER, notionId: 'aaaaaaaa11112222333344444444 4444'.replace(/\s/g, '') });
  assert.equal(dispatch.verifyCmd, 'node --test scripts/tests/tm-gap-links.test.mjs');

  const decision = decideClose({
    dispatch,
    verifyResult: { status: 'fail', detail: 'not ok 1 - renders Ticketmaster for TodayTix-gap shows' },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.verdict, VERDICTS.FAIL);
  assert.match(decision.message, /cannot close/);
  // The refusal must quote the command and the real failure, not a summary.
  assert.match(decision.message, /tm-gap-links\.test\.mjs/);
  assert.match(decision.message, /not ok 1 - renders Ticketmaster/);
  // And the exit code automated closers branch on is the shared constant.
  assert.equal(CLOSE_REFUSED_EXIT_CODE, 5);
});

test('(a2) undashed and uppercase notion ids find the same dispatch', () => {
  const dashed = findCardDispatch({ entries: LEDGER, notionId: '3b2637c5-416f-8167-9908-e84c6deb38f5' });
  const bare = findCardDispatch({ entries: LEDGER, notionId: '3B2637C5416F81679908E84C6DEB38F5' });
  assert.equal(dashed.entry.taskId, '1003');
  assert.deepEqual(bare.entry, dashed.entry);
  assert.equal(normalizeNotionId('3b2637c5-416f-8167-9908-e84c6deb38f5'), '3b2637c5416f81679908e84c6deb38f5');
});

test('(b) an unrelated failing trunk does NOT block: only this card\'s own command decides', () => {
  const dispatch = findCardDispatch({ entries: LEDGER, notionId: '3b2637c5-416f-8167-9908-e84c6deb38f5' });
  // Trunk is red from four other failures — this card's own check passes.
  const decision = decideClose({ dispatch, verifyResult: { status: 'pass', detail: null } });
  assert.equal(decision.allowed, true);
  assert.equal(decision.verdict, VERDICTS.PASS);
  assert.equal(decision.warn, false);
  // Nothing in the decision reads trunk state at all — that is the point.
  assert.equal(typeof decideClose({ dispatch, verifyResult: { status: 'pass' }, trunk: { state: 'RED' } }).allowed, 'boolean');
});

test('(c) a card with no verifyCmd warns and closes — never blocked', () => {
  // Native task dispatched without an acceptance command.
  const noCmd = findCardDispatch({ entries: LEDGER, taskId: '1002' });
  assert.equal(noCmd.entry.taskId, '1002');
  assert.equal(noCmd.verifyCmd, null);
  const d1 = decideClose({ dispatch: noCmd });
  assert.equal(d1.allowed, true);
  assert.equal(d1.verdict, VERDICTS.NO_VERIFY_CMD);
  assert.equal(d1.warn, true);
  assert.match(d1.message, /no acceptance-criteria section or VERIFY line/);

  // --allow-unverifiable says so explicitly.
  const unver = findCardDispatch({
    entries: [{ event: 'launch', taskId: '7', notionId: 'bb', verifyCmd: null, allowUnverifiable: true }],
    notionId: 'bb',
  });
  assert.match(decideClose({ dispatch: unver }).message, /--allow-unverifiable/);

  // A card that was never dispatched at all has no ledger entry.
  const none = findCardDispatch({ entries: LEDGER, notionId: 'ffffffff-0000-0000-0000-000000000000' });
  assert.equal(none.entry, null);
  const d2 = decideClose({ dispatch: none });
  assert.equal(d2.allowed, true);
  assert.equal(d2.verdict, VERDICTS.NO_LEDGER_ENTRY);
  assert.equal(d2.warn, true);
});

test('(c2) every ambiguous outcome fails OPEN — unverifiable, unrun, disabled, bypassed', () => {
  const dispatch = findCardDispatch({ entries: LEDGER, notionId: '3b2637c5-416f-8167-9908-e84c6deb38f5' });
  const cases = [
    [{ dispatch, verifyResult: { status: 'unverifiable', detail: 'check exited 3' } }, VERDICTS.UNVERIFIABLE],
    [{ dispatch, verifyResult: null }, VERDICTS.NOT_RUN],
    [{ dispatch, disabled: true }, VERDICTS.DISABLED],
    [{ dispatch, bypassReason: 'owner said ship it' }, VERDICTS.BYPASSED],
  ];
  for (const [input, verdict] of cases) {
    const d = decideClose(input);
    assert.equal(d.allowed, true, `${verdict} must not block`);
    assert.equal(d.verdict, verdict);
  }
  // Only a clean FAIL ever blocks.
  assert.equal(decideClose({ dispatch, verifyResult: { status: 'fail', detail: 'x' } }).allowed, false);
});

test('(a4) a command whose path is not on main yet says MERGE FIRST, not "your test fails"', () => {
  const dispatch = { entry: {}, verifyCmd: 'node --test scripts/tests/close-time-verify.test.mjs' };
  const d = decideClose({
    dispatch,
    verifyResult: { status: 'fail', detail: "Could not find 'scripts/tests/close-time-verify.test.mjs'" },
  });
  assert.equal(d.allowed, false);
  assert.equal(d.notOnMain, true);
  assert.match(d.message, /NOT ON MAIN/);
  assert.match(d.message, /Merge the branch first/);
  // A real assertion failure keeps the ordinary wording.
  const real = decideClose({ dispatch, verifyResult: { status: 'fail', detail: 'not ok 1 - thing' } });
  assert.equal(real.notOnMain, false);
  assert.match(real.message, /Fix it on main/);
});

test('(a3) a re-dispatched card uses its NEWEST verifyCmd, not the launch it was redrawn from', () => {
  const entries = [
    { event: 'launch', taskId: '1003', notionId: 'cc', verifyCmd: 'node --test scripts/tests/trunk-close-gate.test.mjs' },
    { event: 'dead', taskId: '1003' },
    { event: 'launch', taskId: '1003', notionId: 'cc', verifyCmd: 'node --test scripts/tests/close-time-verify.test.mjs' },
  ];
  assert.equal(findCardDispatch({ entries, notionId: 'cc' }).verifyCmd, 'node --test scripts/tests/close-time-verify.test.mjs');
});

test('a taskId is never used to match when a notionId was supplied and missed', () => {
  // The shared task list recycles ids; borrowing a stranger's command would
  // run the wrong check against this card.
  const d = findCardDispatch({ entries: LEDGER, notionId: 'dddddddd-0000-0000-0000-000000000000' });
  assert.equal(d.entry, null);
  assert.equal(d.verifyCmd, null);
});

test('(d) the dry-run reports how many in-flight cards would be refused', () => {
  const results = [
    { cardId: 'c1', taskId: '956', decision: decideClose({ dispatch: { entry: {}, verifyCmd: 'node --test a.mjs' }, verifyResult: { status: 'fail', detail: 'x' } }) },
    { cardId: 'c2', taskId: '1003', decision: decideClose({ dispatch: { entry: {}, verifyCmd: 'node --test b.mjs' }, verifyResult: { status: 'pass' } }) },
    { cardId: 'c3', taskId: '1002', decision: decideClose({ dispatch: { entry: {}, verifyCmd: null } }) },
    { cardId: 'c4', taskId: '900', decision: decideClose({ dispatch: { entry: {}, verifyCmd: 'node --test c.mjs' }, verifyResult: { status: 'unverifiable', detail: 'exit 3' } }) },
  ];
  const s = summarizeDryRun(results);
  assert.equal(s.total, 4);
  assert.equal(s.blocked, 1);
  assert.equal(s.withVerifyCmd, 3);
  assert.equal(s.withoutVerifyCmd, 1);
  assert.equal(s.blockedPct, 25);
  assert.deepEqual(s.blockedCards.map((b) => b.cardId), ['c1']);
  assert.match(s.line, /1\/4 in-flight card\(s\) would be REFUSED/);
  assert.equal(s.counts[VERDICTS.FAIL], 1);
  assert.equal(summarizeDryRun([]).blocked, 0);
  assert.equal(summarizeDryRun([]).blockedPct, 0);
});

// ── the real runner, not a mock ─────────────────────────────────────────────

test('runVerify returns pass/fail/unverifiable against real commands', () => {
  // Laid out like the repo: isSafeCheckCommand only accepts test paths under
  // tests/, scripts/ or src/, so a bare filename in a temp root would (and
  // did, first run) come back unverifiable instead of exercising the runner.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-test-'));
  fs.mkdirSync(path.join(dir, 'scripts', 'tests'), { recursive: true });
  const write = (name, body) => fs.writeFileSync(path.join(dir, 'scripts', 'tests', name), body);
  write('ctv-green.test.mjs', "import {test} from 'node:test';\ntest('ok', () => {});\n");
  write('ctv-red.test.mjs', "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\ntest('bad', () => assert.equal(1, 2));\n");
  try {
    assert.equal(runVerify(dir, 'node --test scripts/tests/ctv-green.test.mjs', { attempts: 1 }).status, 'pass');
    const bad = runVerify(dir, 'node --test scripts/tests/ctv-red.test.mjs', { attempts: 1 });
    assert.equal(bad.status, 'fail');
    assert.match(String(bad.detail), /not ok|fail/i);
    // An unsafe/unrunnable command is unverifiable, never a failure — a card
    // must not be refused because someone wrote prose in Acceptance criteria.
    assert.equal(runVerify(dir, 'rm -rf /', { attempts: 1 }).status, 'unverifiable');
    assert.equal(runVerify(dir, '', { attempts: 1 }).status, 'unverifiable');
    // A command that never STARTS must also be unverifiable — reading a spawn
    // error as FAIL would refuse a card over a broken environment (ship-check
    // finding). Provoked here with an unusable cwd, which is a spawn-level
    // failure (status null + errno code), the same shape as a missing binary;
    // isSafeCheckCommand only admits node/npx/test, so a missing binary cannot
    // be expressed as a card command at all (Codex second pass: the old
    // comment claimed this test used a missing binary — it never did).
    const spawnFail = runVerify('/definitely/not/a/directory-ctv', 'node --test scripts/tests/ctv-green.test.mjs', { attempts: 1 });
    assert.equal(spawnFail.status, 'unverifiable', `spawn failure must fail open, got ${spawnFail.status}`);
    assert.match(String(spawnFail.detail), /could not be started/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── wiring proof (the failure this card exists to prevent) ──────────────────

test('notion-brain.js calls this from its --status Done path, and nothing calls the deleted gate', () => {
  const brain = fs.readFileSync(path.join(REPO, 'scripts/notion-brain.js'), 'utf8');
  assert.match(brain, /require\('\.\/lib\/close-time-verify\.js'\)/);
  assert.match(brain, /if \(args\.status === 'Done'\) \{\s*\n\s*await enforceCloseTimeVerify\(pageId, args\);/);
  assert.match(brain, /require\('\.\/lib\/acceptance-check-core\.js'\)/);

  // The rejected v1 must be gone, not shadowed by a second implementation.
  assert.equal(fs.existsSync(path.join(REPO, 'scripts/lib/trunk-close-gate.js')), false);
  for (const f of ['scripts/notion-brain.js', 'scripts/notion-tasks-sync.js', 'scripts/autonomous-merge.js',
    'scripts/send-morning-digest.js', 'scripts/produce-trunk-snapshot.js']) {
    assert.ok(!fs.readFileSync(path.join(REPO, f), 'utf8').includes('trunk-close-gate'), `${f} still references trunk-close-gate`);
  }

  // Both refusal handlers branch on the shared constant, not a literal 5.
  for (const f of ['scripts/notion-tasks-sync.js', 'scripts/autonomous-merge.js']) {
    assert.match(fs.readFileSync(path.join(REPO, f), 'utf8'), /CLOSE_REFUSED_EXIT_CODE/);
  }
});

test('the nightly recheck and the close-time check share ONE checkout+verify implementation', () => {
  const recheck = fs.readFileSync(path.join(REPO, 'scripts/autonomous-acceptance-recheck.js'), 'utf8');
  assert.match(recheck, /require\('\.\/lib\/acceptance-check-core\.js'\)/);
  // No second COPY left behind — a one-line delegating wrapper is fine, a
  // second implementation of the checkout or the runner is not.
  assert.ok(!recheck.includes("'worktree', 'add'"), 'recheck still builds its own worktree');
  assert.ok(!/git', \['fetch'/.test(recheck), 'recheck still runs its own fetch');
  assert.ok(!/function runVerify\s*\(/.test(recheck), 'recheck still defines its own runVerify');
});
