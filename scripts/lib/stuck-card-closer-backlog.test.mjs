// BRO-7139 Step 1: Backlog/Todo cards close only on hard evidence (own single-test check passed in the
// open-backlog sweep AND a commit that finishes the card touched that test), through the Done gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  planBacklogCandidates, commitFinishesCard, decideBacklogClosure, buildBacklogClosureComment,
  MAX_BACKLOG_CLOSES_PER_RUN, BACKLOG_IDLE_MS, CLOSER_MARKER, BOUNCE_MARKER,
} = require('./stuck-card-closer.js');

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-08T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const cmd = (id) => `node --test scripts/lib/${id.toLowerCase()}.test.mjs`;

test('planBacklogCandidates: fresh report only; single test files only; flake retries refused', () => {
  assert.match(planBacklogCandidates({}, NOW).error, /no generatedAt/);
  assert.match(planBacklogCandidates({ generatedAt: iso(NOW - 7 * HOUR), alreadyDone: [] }, NOW).error, /7h old/);
  const plan = planBacklogCandidates({ generatedAt: iso(NOW - HOUR), alreadyDone: [
    { id: 'BRO-1', verifyCmd: cmd('BRO-1'), detail: 'exit 0' },
    { id: 'BRO-2', verifyCmd: 'node scripts/validate-data.js --strict', detail: 'exit 0' },
    { id: 'BRO-3', verifyCmd: cmd('BRO-3'), detail: 'passed on retry (flaky)' },
    { id: 'BRO-4', verifyCmd: `${cmd('BRO-4')} && rm -rf x`, detail: 'exit 0' },
    { id: 'BRO-5', verifyCmd: cmd('BRO-SHARED'), detail: 'exit 0' },
    { id: 'BRO-6', verifyCmd: cmd('BRO-SHARED'), detail: 'exit 0' },
    null,
  ] }, NOW);
  assert.deepEqual(plan.candidates, [{ id: 'BRO-1', cmd: cmd('BRO-1'), testPath: 'scripts/lib/bro-1.test.mjs' }]);
  assert.deepEqual(plan.skipped, { 'not-a-single-test-file': 2, 'passed-only-on-retry': 1, 'test-shared-with-another-card': 2 });
});

test('commitFinishesCard: a commit that files, defers or splits work off the card does not finish it', () => {
  assert.equal(commitFinishesCard('feat(BRO-9): the fix', 'BRO-9'), true);
  assert.equal(commitFinishesCard('BRO-9: done', 'BRO-9'), true);
  // only a trailer names the card: too weak for a card nobody claimed
  assert.equal(commitFinishesCard('fix: tidy\n\nRefs: BRO-9', 'BRO-9'), false);
  // one step of a larger card
  for (const m of ['feat(BRO-9) Step 1: handlers', 'BRO-9 part 2: x', 'wip(BRO-9): x', 'BRO-9: scaffold the closer',
    'test(BRO-9): add failing test', 'BRO-9 (1/3): first piece']) assert.equal(commitFinishesCard(m, 'BRO-9'), false, m);
  for (const m of ['fix: x; files BRO-9 for y', 'chore: defer z to BRO-9', 'feat(BRO-8): a, follow-up in BRO-9',
    'BRO-9: carded the rest', 'BRO-9: split out to a new card', 'BRO-9: part one; moved the rest to BRO-12', 'BRO-9: split off retries', 'BRO-10: unrelated']) {
    assert.equal(commitFinishesCard(m, 'BRO-9'), false, m);
  }
});

const candidate = { id: 'BRO-9', cmd: cmd('BRO-9'), testPath: 'scripts/lib/bro-9.test.mjs' };
const issue = (over = {}) => ({
  state: { name: 'Backlog' }, title: 'Fix the thing', createdAt: iso(NOW - 20 * DAY), updatedAt: iso(NOW - 5 * DAY),
  description: `## Acceptance criteria\n\`${cmd('BRO-9')}\``, labels: { nodes: [] }, comments: [], ...over,
});
const good = [{ sha: 'abcdef1234567890', message: 'feat(BRO-9): the fix' }];

test('decideBacklogClosure: closes only with every condition met; each missing one leaves the card', () => {
  const ok = decideBacklogClosure({ candidate, issue: issue(), commits: good, nowMs: NOW });
  assert.deepEqual(ok, { close: true, sha: 'abcdef1234567890', evidence: 'touched scripts/lib/bro-9.test.mjs' });
  assert.equal(decideBacklogClosure({ candidate, issue: issue({ state: { name: 'Todo' } }), commits: good, nowMs: NOW }).close, true);
  const leave = (over, commits = good) => decideBacklogClosure({ candidate, issue: over === null ? null : issue(over), commits, nowMs: NOW }).reason;
  assert.equal(leave(null), 'issue-not-found');
  assert.equal(leave({ state: { name: 'Paused' } }), 'state-Paused');
  assert.equal(leave({ state: { name: 'In Progress' } }), 'state-In Progress');
  assert.equal(leave({ comments: [{ body: `${CLOSER_MARKER} earlier`, createdAt: iso(NOW - 10 * DAY) }] }), 'closer-already-tried');
  assert.equal(leave({ comments: [{ body: `${BOUNCE_MARKER}`, createdAt: iso(NOW - 10 * DAY) }] }), 'closer-already-tried');
  assert.equal(leave({ description: 'DECISION NEEDED: owner picks A or B' }), 'owner-marker');
  assert.equal(leave({ labels: { nodes: [{ name: 'awaiting-owner' }] } }), 'owner-marker');
  assert.equal(leave({ description: 'Fix it.\nPARKED: needs the owner\'s Stripe key to deploy' }), 'parked');
  assert.equal(leave({ description: 'RECHECK-AFTER: 2026-01-01 (past)' }), 'recheck-stamped');
  assert.equal(leave({ comments: [{ body: 'RECHECK-AFTER: 2027-01-01', createdAt: iso(NOW - 10 * DAY) }] }), 'recheck-stamped');
  assert.equal(leave({ updatedAt: iso(NOW - BACKLOG_IDLE_MS + HOUR) }), 'recent-activity');
  assert.equal(leave({ comments: [{ body: 'working on it', createdAt: iso(NOW - DAY) }] }), 'recent-activity');
  assert.equal(leave({ createdAt: 'garbage' }), 'issue-created-unparseable');
  assert.equal(leave({}, []), 'no-commit-finishing-card-touched-test');
  assert.equal(leave({}, [{ sha: 'a', message: 'Revert "feat(BRO-9): the fix"' }]), 'no-commit-finishing-card-touched-test');
  assert.equal(leave({}, [{ sha: 'a', message: 'chore: defer rest to BRO-9' }]), 'no-commit-finishing-card-touched-test');
});

test('buildBacklogClosureComment cites the sweep, the commit and the command', () => {
  const c = buildBacklogClosureComment({ candidate, sha: 'abcdef1234567890', sweepGeneratedAt: iso(NOW), checkoutSha: '0123456789abcdef' });
  assert.ok(c.startsWith(CLOSER_MARKER));
  for (const s of ['backlog sweep', cmd('BRO-9'), 'abcdef123456', '0123456789ab', 'scripts/lib/bro-9.test.mjs']) assert.ok(c.includes(s), s);
});

test('CLI: backlog closes go through the Done gate, capped per run, and honour the kill switch', async () => {
  const { main } = require('../close-stuck-verified-cards.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closer-backlog-'));
  const now = Date.now();
  const auditPath = path.join(dir, 'audit.json');
  const outPath = path.join(dir, 'out.json');
  fs.writeFileSync(auditPath, JSON.stringify({ generatedAt: iso(now - HOUR), results: [] }));
  const ids = Array.from({ length: 8 }, (_, i) => `BRO-${200 + i}`);
  fs.writeFileSync(path.join(dir, 'open-backlog-acceptance-sweep.json'), JSON.stringify({
    generatedAt: iso(now - HOUR), checkoutSha: 'feedface00000000',
    alreadyDone: [...ids.map((id) => ({ id, verifyCmd: cmd(id), detail: 'exit 0' })), { id: 'BRO-299', verifyCmd: cmd('BRO-299'), detail: 'exit 0' }],
  }));
  const linear = {
    listOpenIssues: async () => [],
    graphql: async (q, { id }) => { assert.match(q, /labels\s*\{\s*nodes\s*\{\s*name/); return { issue: {
      identifier: id, title: `t ${id}`, priority: 3, state: { name: id === 'BRO-299' ? 'In Progress' : 'Backlog', type: 'backlog' },
      createdAt: iso(now - 30 * DAY), updatedAt: iso(now - 10 * DAY), description: 'x', comments: { nodes: [] },
    } }; },
  };
  const commitsTouching = async (testPath) => {
    const id = testPath.match(/(bro-\d+)/)[1].toUpperCase();
    return [{ sha: `${id.slice(4)}abcdef0123`, message: `feat(${id}): done` }];
  };
  const run = async (argv, env) => {
    const spawned = [];
    const spawn = (_n, args) => { spawned.push(args.slice(2, 5)); return { status: args[2] === 'BRO-201' ? 5 : 0, stdout: '', stderr: 'gate said no' }; };
    const saved = process.env.BACKLOG_CLOSE_DISABLED;
    if (env) process.env.BACKLOG_CLOSE_DISABLED = env; else delete process.env.BACKLOG_CLOSE_DISABLED;
    const log = console.log; const err = console.error;
    console.log = () => {}; console.error = () => {};
    try {
      assert.equal(await main(argv, { linear, commitsTouching, spawn, auditPath, outPath }), 0);
    } finally {
      console.log = log; console.error = err;
      if (saved === undefined) delete process.env.BACKLOG_CLOSE_DISABLED; else process.env.BACKLOG_CLOSE_DISABLED = saved;
    }
    return { spawned, out: JSON.parse(fs.readFileSync(outPath, 'utf8')) };
  };
  try {
    const dry = await run([]);
    assert.equal(dry.spawned.length, 0);
    assert.equal(dry.out.counts['backlog:would-close'], 8);
    assert.equal(dry.out.counts['backlog:state-In Progress'], 1);

    const real = await run(['--apply']);
    // every attempt is a Done-state update through linear-brain (the gate)
    for (const s of real.spawned) assert.deepEqual(s.slice(1), ['--state', 'Done']);
    assert.equal(real.out.counts['backlog:closed'], MAX_BACKLOG_CLOSES_PER_RUN);
    assert.equal(real.out.counts['backlog:gate-refused'], 1);
    assert.equal(real.spawned.length, MAX_BACKLOG_CLOSES_PER_RUN + 1);
    assert.equal(real.out.counts['backlog:over-run-cap'], 8 - MAX_BACKLOG_CLOSES_PER_RUN - 1);
    assert.equal(real.out.backlogSweepGeneratedAt, iso(now - HOUR));

    fs.writeFileSync(auditPath, JSON.stringify({ generatedAt: iso(now - 30 * HOUR), results: [] }));
    const stale = await run([]);
    assert.match(stale.out.error, /old/);
    assert.equal(stale.out.counts['backlog:would-close'], 8);

    const off = await run(['--apply'], 'true');
    assert.equal(off.spawned.length, 0);
    assert.equal(off.out.counts['backlog:disabled'], 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
