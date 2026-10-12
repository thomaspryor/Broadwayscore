import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CLOSER_MARKER,
  cardTestPath,
  cardTestPaths,
  landedViaLandRef,
  NO_OWN_COMMIT,
  mentionsCard,
  commitIsForCard,
  planCandidates,
  futureRecheckAfter,
  decideClosure,
  buildClosureComment,
  closeRunStopReason,
  MAX_CLOSES_PER_RUN,
  MAX_REFUSALS_PER_RUN,
  BOUNCE_MARKER,
  MAX_BOUNCES,
  MAX_BOUNCES_PER_RUN,
  decideBounce,
  buildBounceComment,
} = require('./stuck-card-closer.js');

const NOW = Date.parse('2026-10-02T18:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

test('cardTestPath accepts a single node --test file', () => {
  assert.equal(cardTestPath('node --test scripts/lib/a.test.mjs'), 'scripts/lib/a.test.mjs');
  assert.equal(cardTestPath('node --test tests/unit/b.test.js'), 'tests/unit/b.test.js');
  assert.equal(cardTestPath('node scripts/validate-data.js'), null);
  assert.equal(cardTestPath('node --test scripts/lib/a.mjs'), null);
  assert.equal(cardTestPath(undefined), null);
});

test('cardTestPaths (BRO-4814) widens to npx tsx --test and multi-file runs', () => {
  assert.deepEqual(cardTestPaths('npx tsx --test tests/unit/show-market.test.ts'), ['tests/unit/show-market.test.ts']);
  assert.deepEqual(cardTestPaths('npx tsx --test scripts/lib/a.test.mjs tests/unit/b.test.ts'), ['scripts/lib/a.test.mjs', 'tests/unit/b.test.ts']);
  assert.deepEqual(cardTestPaths('node --test scripts/lib/a.test.mjs tests/unit/b.test.js'), ['scripts/lib/a.test.mjs', 'tests/unit/b.test.js']);
  assert.deepEqual(cardTestPaths('node --test --test-timeout 60000 scripts/lib/a.test.mjs'), ['scripts/lib/a.test.mjs']);
  // A file named twice is one file.
  assert.deepEqual(cardTestPaths('node --test scripts/lib/a.test.mjs scripts/lib/a.test.mjs'), ['scripts/lib/a.test.mjs']);
  assert.equal(cardTestPath('node --test scripts/lib/a.test.mjs tests/unit/b.test.js'), 'scripts/lib/a.test.mjs');
});

test('cardTestPaths keeps every safe-form refusal: shapes, traversal, directories, injection', () => {
  for (const cmd of [
    'node --test tests/unit/a.test.ts', // plain node never runs .ts
    'node --test a.test.mjs', // outside tests/, scripts/, src/
    'node --test scripts/../../etc/x.test.mjs',
    'node --test scripts/lib/a.test.mjs; rm -rf /',
    'node --test scripts/lib/a.test.mjs && node scripts/push-anything.js',
    'npx tsx --test scripts/lib/a.test.mjs $(whoami)',
    'npx tsx scripts/lib/a.test.mjs',
    'npx tsc --noEmit', // safe, but not a test run of named files
    'test -f scripts/lib/a.test.mjs',
    'node --test',
    'node --test scripts/lib/a.test.cjs',
  ]) assert.equal(cardTestPaths(cmd), null, cmd);
});

test('mentionsCard matches the exact identifier only', () => {
  assert.ok(mentionsCard('BRO-71: fix the gap', 'BRO-71'));
  assert.ok(mentionsCard('fix (BRO-71)', 'BRO-71'));
  assert.ok(!mentionsCard('BRO-710: other card', 'BRO-71'));
  assert.ok(!mentionsCard('XBRO-71 thing', 'BRO-71'));
  assert.ok(!mentionsCard('', 'BRO-71'));
});

const row = (over) => ({ id: 'BRO-1', state: 'In Review', verdict: 'STUCK', channels: ['verify-command'], cmd: 'node --test scripts/lib/one.test.mjs', ...over });

test('planCandidates refuses a stale or undated report', () => {
  assert.match(planCandidates({ generatedAt: iso(NOW - 7 * 3600e3), results: [] }, NOW).error, /7h old/);
  assert.match(planCandidates({ results: [] }, NOW).error, /no generatedAt/);
});

test('planCandidates keeps only card-specific STUCK rows', () => {
  const report = {
    generatedAt: iso(NOW - 3600e3),
    results: [
      row({ id: 'BRO-1' }),
      row({ id: 'BRO-2', state: 'In Progress', cmd: 'node --test scripts/lib/two.test.mjs' }),
      row({ id: 'BRO-3', state: 'Todo', cmd: 'node --test scripts/lib/three.test.mjs' }),
      row({ id: 'BRO-4', channels: ['pr-evidence'], cmd: 'node --test scripts/lib/four.test.mjs' }),
      row({ id: 'BRO-5', cmd: 'node scripts/validate-data.js' }),
      row({ id: 'BRO-6', cmd: 'node --test scripts/lib/shared.test.mjs' }),
      row({ id: 'BRO-7', verdict: 'VERIFIED', cmd: 'node --test scripts/lib/shared.test.mjs' }),
      row({ id: 'BRO-8', verdict: 'FAILED', cmd: 'node --test scripts/lib/eight.test.mjs' }),
    ],
  };
  const { candidates, skipped } = planCandidates(report, NOW);
  assert.deepEqual(candidates.map((c) => c.id), ['BRO-1', 'BRO-2']);
  assert.equal(candidates[0].testPath, 'scripts/lib/one.test.mjs');
  assert.deepEqual(skipped, {
    'state-Todo': 1,
    'no-verify-command': 1,
    'command-not-a-test-run': 1,
    'command-shared-with-another-card': 1,
  });
});

test('futureRecheckAfter only fires for dates still ahead', () => {
  assert.equal(futureRecheckAfter(['RECHECK-AFTER: 2026-10-09'], NOW), '2026-10-09');
  assert.equal(futureRecheckAfter(['RECHECK-AFTER: 2026-10-01'], NOW), null);
  assert.equal(futureRecheckAfter([null, 'nothing here'], NOW), null);
});

const candidate = { id: 'BRO-1', state: 'In Review', cmd: 'node --test scripts/lib/one.test.mjs', testPath: 'scripts/lib/one.test.mjs' };
const issue = (over) => ({
  state: { name: 'In Review', type: 'started' },
  createdAt: iso(NOW - 10 * DAY),
  updatedAt: iso(NOW - 3 * DAY),
  description: 'problem text',
  comments: [{ body: 'Session report (in-review)', createdAt: iso(NOW - 3 * DAY) }],
  ...over,
});
const commits = [{ sha: 'aaa111', message: 'unrelated change' }, { sha: 'bbb222bbb222ccc', message: 'BRO-1: the fix' }];

test('commitIsForCard reads the subject and Refs/Fixes/Closes trailers only', () => {
  assert.ok(commitIsForCard('BRO-1: the fix\n\nbody', 'BRO-1'));
  assert.ok(commitIsForCard('fix the gap\n\nwhy\n\nRefs: BRO-1', 'BRO-1'));
  // A body that cites the card as context is not the card's own landing.
  assert.ok(!commitIsForCard('excerpt-validation: generic nouns\n\nThe BRO-1 corpus sweep flagged it.', 'BRO-1'));
  assert.ok(!commitIsForCard('', 'BRO-1'));
});

test('decideClosure closes an idle card whose own commit touched its test', () => {
  assert.deepEqual(decideClosure({ candidate, issue: issue(), commits, nowMs: NOW }), { close: true, route: 'commit', sha: 'bbb222bbb222ccc' });
});

test('decideClosure refuses every unsafe case', () => {
  const r = (over, c = commits, cand = candidate) => decideClosure({ candidate: cand, issue: over === null ? null : issue(over), commits: c, nowMs: NOW }).reason;
  assert.equal(r(null), 'issue-not-found');
  assert.equal(r({ state: { name: 'Done', type: 'completed' } }), 'state-changed-since-audit');
  assert.equal(r({ updatedAt: iso(NOW - 2 * 3600e3) }), 'recent-activity');
  assert.equal(r({ comments: [{ body: 'x', createdAt: iso(NOW - 3600e3) }] }), 'recent-activity');
  assert.equal(r({ description: 'RECHECK-AFTER: 2026-10-09' }), 'recheck-after-pending');
  assert.equal(r({ comments: [{ body: `${CLOSER_MARKER}.`, createdAt: iso(NOW - 3 * DAY) }] }), 'closer-already-tried');
  assert.equal(r({}, [{ sha: 'a', message: 'BRO-10: other card' }]), 'no-commit-naming-card-touched-test');
  assert.equal(r({}, []), 'no-commit-naming-card-touched-test');
  assert.equal(r({}, [{ sha: 'a', message: 'Revert "BRO-1: fix"\n\nThis reverts commit abc.' }]), 'no-commit-naming-card-touched-test');
  assert.equal(r({}, [{ sha: 'a', message: 'other work\n\nThe BRO-1 sweep found this.' }]), 'no-commit-naming-card-touched-test');
  // In Progress needs 72h of quiet, not 24h.
  const ip = { ...candidate, state: 'In Progress' };
  assert.equal(r({ state: { name: 'In Progress' }, updatedAt: iso(NOW - 2 * DAY), comments: [] }, commits, ip), 'recent-activity');
  assert.equal(decideClosure({ candidate: ip, issue: issue({ state: { name: 'In Progress' }, updatedAt: iso(NOW - 4 * DAY), comments: [] }), commits, nowMs: NOW }).close, true);
});

test('buildClosureComment carries the marker and no gate-evidence keywords', () => {
  const body = buildClosureComment({ candidate, sha: 'bbb222bbb222ccc', auditGeneratedAt: '2026-10-02T13:20:17Z' });
  assert.ok(body.startsWith(CLOSER_MARKER));
  assert.match(body, /bbb222bbb222/);
  assert.doesNotMatch(body, /VERIFY:|PR-EVIDENCE:|^Dispatched/m);
});

test('CLI refuses --git-repo on a shallow clone instead of reporting every card as uncommitted', async () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closer-shallow-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', 'full');
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(dir, 'full', 'f.txt'), String(n));
    git('-C', 'full', 'add', 'f.txt');
    git('-C', 'full', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', `c${n}`);
  }
  git('clone', '-q', '--depth', '1', `file://${path.join(dir, 'full')}`, 'shallow');
  const { main } = require('../close-stuck-verified-cards.js');
  const linear = { graphql: () => { throw new Error('must not reach Linear'); } };
  const noWrite = true;
  const err = console.error;
  console.error = () => {};
  try {
    assert.equal(await main(['--git-repo', path.join(dir, 'shallow')], { linear, noWrite, auditPath: '/nonexistent' }), 2);
  } finally {
    console.error = err;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 3 with a recorded error when the audit cannot be read', async () => {
  const { main } = require('../close-stuck-verified-cards.js');
  const linear = { graphql: () => { throw new Error('must not reach Linear'); } };
  const err = console.error;
  console.error = () => {};
  try {
    assert.equal(await main([], { linear, noWrite: true, commitsTouching: async () => [], auditPath: '/nonexistent/audit.json' }), 3);
  } finally {
    console.error = err;
  }
});

test('closeRunStopReason: time is the limiter, refusals trip the breaker, the ceiling is a backstop', () => {
  const ok = { closed: 0, refused: 0, remainingMs: 10 * 60e3, closeTimeoutMs: 5 * 60e3 };
  assert.equal(closeRunStopReason(ok), null);
  // Far past the old flat 10: quick checks keep closing while time remains.
  assert.equal(closeRunStopReason({ ...ok, closed: 25 }), null);
  assert.equal(closeRunStopReason({ ...ok, closed: MAX_CLOSES_PER_RUN }), 'over-run-cap');
  assert.equal(closeRunStopReason({ ...ok, refused: MAX_REFUSALS_PER_RUN - 1 }), null);
  assert.equal(closeRunStopReason({ ...ok, refused: MAX_REFUSALS_PER_RUN }), 'refusal-breaker');
  assert.equal(closeRunStopReason({ ...ok, remainingMs: 4 * 60e3 }), 'over-time-budget');
});

test('CLI --apply closes past 10 and stops after repeated Done-gate refusals', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { main } = require('../close-stuck-verified-cards.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closer-apply-'));
  const ids = Array.from({ length: 20 }, (_, i) => `BRO-${100 + i}`);
  const auditPath = path.join(dir, 'audit.json');
  const outPath = path.join(dir, 'out.json');
  const now = Date.now();
  fs.writeFileSync(auditPath, JSON.stringify({
    generatedAt: new Date(now - 3600e3).toISOString(),
    results: ids.map((id) => row({ id, cmd: `node --test scripts/lib/${id.toLowerCase()}.test.mjs` })),
  }));
  const linear = {
    graphql: async (_q, { id }) => ({ issue: {
      identifier: id, title: `Fix ${id}`, priority: 2, state: { name: 'In Review', type: 'started' },
      createdAt: new Date(now - 10 * DAY).toISOString(), updatedAt: new Date(now - 3 * DAY).toISOString(),
      description: 'x', comments: { nodes: [] },
    } }),
  };
  const commitsTouching = async (testPath) => {
    const id = testPath.match(/(bro-\d+)/)[1].toUpperCase();
    return [{ sha: 'abc123abc123', message: `${id}: the fix` }];
  };
  // The Done gate accepts the first 12 cards, then refuses everything.
  const spawned = [];
  const spawn = (_node, args) => {
    spawned.push(args[2]);
    return spawned.length <= 12 ? { status: 0, stdout: '' } : { status: 5, stderr: 'REFUSED' };
  };
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    assert.equal(await main(['--apply'], { linear, commitsTouching, spawn, auditPath, outPath }), 0);
  } finally {
    console.log = log;
    console.error = err;
  }
  const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(out.counts.closed, 12);
  assert.equal(out.counts['gate-refused'], MAX_REFUSALS_PER_RUN);
  assert.equal(out.counts['refusal-breaker'], 20 - 12 - MAX_REFUSALS_PER_RUN);
  assert.equal(spawned.length, 12 + MAX_REFUSALS_PER_RUN);
});

// ── bounce: In Review cards whose own check fails go back to Todo ──────────

const failRow = (over = {}) => ({
  id: 'BRO-7', state: 'In Review', verdict: 'UNVERIFIABLE', cmd: 'node --test scripts/lib/bro-7.test.mjs',
  openCheckFails: true, failDetail: 'exit 1: 2 failing', channels: [], ...over,
});

test('planCandidates lists only flagged In Review rows as bounces', () => {
  const plan = planCandidates({ generatedAt: iso(NOW - 3600e3), results: [
    failRow(),
    failRow({ id: 'BRO-8', state: 'In Progress' }),
    failRow({ id: 'BRO-9', openCheckFails: undefined }),
    failRow({ id: 'BRO-10', cmd: null }),
  ] }, NOW);
  assert.deepEqual(plan.bounces.map((b) => b.id), ['BRO-7']);
  assert.equal(plan.bounces[0].failDetail, 'exit 1: 2 failing');
});

test('decideBounce sends an idle failing card back, and gives up after MAX_BOUNCES', () => {
  const cand = { id: 'BRO-7', state: 'In Review', cmd: 'node --test x.test.mjs' };
  const iss = (over = {}) => ({ state: { name: 'In Review' }, priority: 1, title: 'Fix thing', updatedAt: iso(NOW - 2 * DAY), description: '## Acceptance criteria\n`node --test scripts/lib/x.test.mjs` passes', comments: [], ...over });
  const d = (over) => decideBounce({ candidate: cand, issue: over === null ? null : iss(over), nowMs: NOW });
  assert.deepEqual(d({}), { bounce: true, priorBounces: 0 });
  assert.equal(d(null).reason, 'issue-not-found');
  assert.equal(d({ state: { name: 'Todo' } }).reason, 'state-changed-since-audit');
  assert.equal(d({ updatedAt: iso(NOW - 3600e3) }).reason, 'recent-activity');
  assert.equal(d({ description: `RECHECK-AFTER: 2026-10-09\n${'## Acceptance criteria\n`node --test scripts/lib/x.test.mjs` passes'}` }).reason, 'recheck-after-pending');
  // Only cards an automatic worker would pick up from Todo go back.
  assert.deepEqual(d({ priority: 2 }), { bounce: true, priorBounces: 0 });
  assert.equal(d({ priority: 3 }).reason, 'no-auto-worker');
  assert.equal(d({ priority: 0 }).reason, 'no-auto-worker');
  assert.equal(d({ description: `needs /visual-qa\n${'## Acceptance criteria\n`node --test scripts/lib/x.test.mjs` passes'}` }).reason, 'no-auto-worker');
  const old = (n) => Array.from({ length: n }, () => ({ body: `${BOUNCE_MARKER} (1 of 2).`, createdAt: iso(NOW - 5 * DAY) }));
  assert.deepEqual(d({ comments: old(MAX_BOUNCES - 1) }), { bounce: true, priorBounces: MAX_BOUNCES - 1 });
  assert.equal(d({ comments: old(MAX_BOUNCES) }).reason, 'bounce-exhausted');
});

test('buildBounceComment carries the marker and count, and no gate-evidence keywords', () => {
  const body = buildBounceComment({ candidate: { cmd: 'node --test x.test.mjs', failDetail: 'exit 1' }, priorBounces: 1, auditGeneratedAt: 'T' });
  assert.ok(body.startsWith(`${BOUNCE_MARKER} (2 of ${MAX_BOUNCES})`));
  assert.match(body, /exit 1/);
  assert.doesNotMatch(body, /VERIFY:|PR-EVIDENCE:|^Dispatched|PARKED:/m);
});

test('CLI --apply moves failing In Review cards to Todo, capped per run; dry run only reports', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { main } = require('../close-stuck-verified-cards.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closer-bounce-'));
  const ids = Array.from({ length: MAX_BOUNCES_PER_RUN + 3 }, (_, i) => `BRO-${300 + i}`);
  const auditPath = path.join(dir, 'audit.json');
  const outPath = path.join(dir, 'out.json');
  const now = Date.now();
  fs.writeFileSync(auditPath, JSON.stringify({
    generatedAt: new Date(now - 3600e3).toISOString(),
    results: ids.map((id) => failRow({ id, cmd: `node --test scripts/lib/${id.toLowerCase()}.test.mjs` })),
  }));
  const exhausted = ids[0];
  const linear = {
    graphql: async (_q, { id }) => ({ issue: {
      identifier: id, title: `Fix ${id}`, priority: 2, state: { name: 'In Review', type: 'started' },
      createdAt: new Date(now - 10 * DAY).toISOString(), updatedAt: new Date(now - 3 * DAY).toISOString(),
      description: '## Acceptance criteria\n`node --test scripts/lib/x.test.mjs` passes',
      comments: { nodes: id === exhausted
        ? Array.from({ length: MAX_BOUNCES }, () => ({ body: BOUNCE_MARKER, createdAt: new Date(now - 4 * DAY).toISOString() }))
        : [] },
    } }),
  };
  const run = async (argv) => {
    const spawned = [];
    const spawn = (_node, args) => { spawned.push(args.slice(1, 5)); return { status: 0, stdout: '' }; };
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      assert.equal(await main(argv, { linear, commitsTouching: async () => [], spawn, auditPath, outPath }), 0);
    } finally {
      console.log = log;
      console.error = err;
    }
    return { spawned, out: JSON.parse(fs.readFileSync(outPath, 'utf8')) };
  };
  const dry = await run([]);
  assert.equal(dry.spawned.length, 0);
  assert.equal(dry.out.counts['would-bounce'], ids.length - 1);
  const live = await run(['--apply']);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(live.out.counts.bounced, MAX_BOUNCES_PER_RUN);
  assert.equal(live.out.counts['bounce:bounce-exhausted'], 1);
  assert.equal(live.out.counts['bounce:over-run-cap'], ids.length - 1 - MAX_BOUNCES_PER_RUN);
  assert.ok(live.spawned.every((a) => a[0] === 'update' && a[2] === '--state' && a[3] === 'Todo'));
  assert.equal(live.out.rows.find((r) => r.id === exhausted).action, 'bounce-exhausted');
});

test('CLI: a failed read on a bounce card skips that card and still runs the closes (exit 3)', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { main } = require('../close-stuck-verified-cards.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closer-readfail-'));
  const auditPath = path.join(dir, 'audit.json');
  const outPath = path.join(dir, 'out.json');
  const now = Date.now();
  fs.writeFileSync(auditPath, JSON.stringify({
    generatedAt: new Date(now - 3600e3).toISOString(),
    results: [
      failRow({ id: 'BRO-401', cmd: 'node --test scripts/lib/bro-401.test.mjs' }),
      row({ id: 'BRO-402', cmd: 'node --test scripts/lib/bro-402.test.mjs' }),
    ],
  }));
  const linear = {
    graphql: async (_q, { id }) => {
      if (id === 'BRO-401') throw new Error('Linear 502');
      return { issue: {
        identifier: id, title: `Fix ${id}`, priority: 2, state: { name: 'In Review', type: 'started' },
        createdAt: new Date(now - 10 * DAY).toISOString(), updatedAt: new Date(now - 3 * DAY).toISOString(),
        description: 'x', comments: { nodes: [] },
      } };
    },
  };
  const commitsTouching = async () => [{ sha: 'abc123abc123', message: 'BRO-402: the fix' }];
  const spawned = [];
  const spawn = (_node, args) => { spawned.push(args[2]); return { status: 0, stdout: '' }; };
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  let code;
  try {
    code = await main(['--apply'], { linear, commitsTouching, spawn, auditPath, outPath });
  } finally {
    console.log = log;
    console.error = err;
  }
  const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 3);
  assert.equal(out.counts['bounce:read-failed'], 1);
  assert.deepEqual(spawned, ['BRO-402']);
  assert.equal(out.counts.closed, 1);
});

// ── BRO-4814: the land route, multi-file planning, the raised budget ──────

test('planCandidates admits tsx and multi-file runs, and flags a test file another card names', () => {
  const plan = planCandidates({ generatedAt: iso(NOW - 3600e3), results: [
    row({ id: 'BRO-21', cmd: 'npx tsx --test tests/unit/twenty-one.test.ts' }),
    row({ id: 'BRO-22', cmd: 'node --test scripts/lib/a22.test.mjs scripts/lib/b22.test.mjs' }),
    row({ id: 'BRO-23', cmd: 'node --test scripts/lib/b22.test.mjs' }),
    row({ id: 'BRO-24', cmd: 'node --test scripts/lib/x.test.mjs; true' }),
  ] }, NOW);
  assert.deepEqual(plan.candidates.map((c) => [c.id, c.testPaths, c.sharesTestFile]), [
    ['BRO-21', ['tests/unit/twenty-one.test.ts'], false],
    ['BRO-22', ['scripts/lib/a22.test.mjs', 'scripts/lib/b22.test.mjs'], true],
    ['BRO-23', ['scripts/lib/b22.test.mjs'], true],
  ]);
  assert.deepEqual(plan.skipped, { 'command-not-a-test-run': 1 });
});

const created = iso(NOW - 10 * DAY);
const landing = (over = {}) => ({
  runs: [{ id: 901, branch: 'land/bro-1-the-fix', headSha: 'tip901', createdAt: iso(NOW - 5 * DAY) }],
  refs: [{ branch: 'land/bro-77-other-card', sha: 'x' }],
  ...over,
});

test('landedViaLandRef needs a successful Land run for the card after it was filed, and no ref left', () => {
  const l = (over, identifier = 'BRO-1') => landedViaLandRef({ identifier, cardCreatedAt: created, landing: over === null ? null : landing(over) });
  assert.deepEqual(l({}), { landed: true, branch: 'land/bro-1-the-fix', runId: 901, createdAt: iso(NOW - 5 * DAY) });
  assert.equal(l(null).reason, 'no-land-evidence');
  assert.equal(l({ refs: [{ branch: 'land/bro-1-retry', sha: 'newtip' }] }).reason, 'land-ref-still-open');
  assert.equal(l({ refs: ['land/bro-1-retry'] }).reason, 'land-ref-still-open'); // no sha known: wait
  // A ref left behind at exactly the tip Land already landed holds nothing unlanded.
  assert.equal(l({ refs: [{ branch: 'land/bro-1-the-fix', sha: 'tip901' }] }).landed, true);
  // A card older than the run listing is not judged until the caller lists further back.
  assert.equal(l({ runs: [], coveredSinceMs: NOW - 3 * DAY }).reason, 'land-history-not-covered');
  assert.equal(l({ runs: [], coveredSinceMs: NOW - 30 * DAY }).reason, NO_OWN_COMMIT);
  assert.equal(l({ runs: [{ id: 1, branch: 'land/bro-1-old', createdAt: iso(NOW - 20 * DAY) }] }).reason, NO_OWN_COMMIT);
  // BRO-10's landing is not BRO-1's.
  assert.equal(l({ runs: [{ id: 2, branch: 'land/bro-10-x', createdAt: iso(NOW - DAY) }] }).reason, NO_OWN_COMMIT);
  assert.equal(l({ runs: [{ id: 3, branch: 'feature/bro-1', createdAt: iso(NOW - DAY) }] }).reason, NO_OWN_COMMIT);
  assert.equal(l({}, 'not-a-card').reason, 'no-land-evidence');
  const newest = l({ runs: [
    { id: 4, branch: 'land/bro-1-a', createdAt: iso(NOW - 4 * DAY) },
    { id: 5, branch: 'land/bro-1-b', createdAt: iso(NOW - 2 * DAY) },
  ] });
  assert.equal(newest.runId, 5);
});

test('decideClosure land route: landed + ref gone + test touched closes without a commit naming the card', () => {
  const anon = [{ sha: 'ddd444', message: 'tighten the guard\n\nno card named here', date: iso(NOW - 7 * DAY) }];
  const d = (over = {}) => decideClosure({ candidate: { ...candidate, sharesTestFile: false, ...over.cand }, issue: issue({ createdAt: created }), commits: over.commits || anon, landing: 'landing' in over ? over.landing : landing(), nowMs: NOW });
  assert.deepEqual(d(), { close: true, route: 'land-ref', sha: 'ddd444', branch: 'land/bro-1-the-fix', runId: 901 });
  // The commit route still wins when it applies.
  assert.equal(d({ commits }).route, 'commit');
  assert.equal(d({ landing: null }).reason, NO_OWN_COMMIT);
  assert.equal(d({ landing: landing({ refs: [{ branch: 'land/bro-1-the-fix', sha: 'unlanded' }] }) }).reason, 'land-ref-still-open');
  assert.equal(d({ cand: { sharesTestFile: true } }).reason, 'landed-but-test-shared-with-another-card');
  assert.equal(d({ commits: [] }).reason, 'landed-but-test-untouched-since-card');
  assert.equal(d({ commits: [{ sha: 'r', message: 'Revert "BRO-1: fix"' }, ...anon] }).reason, 'landed-but-reverted');
  assert.equal(d({ commits: [{ sha: 'r', message: 'Revert "unrelated"' }] }).reason, 'landed-but-test-untouched-since-card');
  // The safety checks before the landing still apply.
  // The touching commit must predate the landing run, and a revert/undo branch is no landing.
  assert.equal(d({ commits: [{ ...anon[0], date: iso(NOW - 1 * DAY) }] }).reason, 'landed-but-test-untouched-since-card');
  assert.equal(d({ commits: [{ sha: 'u', message: 'x' }] }).reason, 'landed-but-test-untouched-since-card');
  assert.equal(d({ landing: landing({ runs: [{ id: 9, branch: 'land/revert-bro-1-x', headSha: 'tip901', createdAt: iso(NOW - 5 * DAY) }] }) }).close, false);
  assert.equal(decideClosure({ candidate, issue: issue({ createdAt: created, updatedAt: iso(NOW - 3600e3) }), commits: anon, landing: landing(), nowMs: NOW }).reason, 'recent-activity');
});

test('buildClosureComment names the land run and every test file on the land route', () => {
  const cand = { ...candidate, testPaths: ['scripts/lib/one.test.mjs', 'tests/unit/two.test.ts'] };
  const body = buildClosureComment({ candidate: cand, sha: 'ddd444ddd444', route: 'land-ref', branch: 'land/bro-1-x', runId: 901, auditGeneratedAt: 'T' });
  assert.ok(body.startsWith(CLOSER_MARKER));
  assert.match(body, /Land run 901 landed land\/bro-1-x/);
  assert.match(body, /tests\/unit\/two\.test\.ts/);
  assert.doesNotMatch(body, /VERIFY:|PR-EVIDENCE:|^Dispatched/m);
});

test('per-run close ceiling is raised to 100 (BRO-4814)', () => {
  assert.equal(MAX_CLOSES_PER_RUN, 100);
  const ok = { closed: 60, refused: 0, remainingMs: 10 * 60e3, closeTimeoutMs: 5 * 60e3 };
  assert.equal(closeRunStopReason(ok), null);
});

test('CLI closes a multi-file card via the land route, reads land evidence once, and goes through the Done gate', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { main } = require('../close-stuck-verified-cards.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closer-land-'));
  const auditPath = path.join(dir, 'audit.json');
  const outPath = path.join(dir, 'out.json');
  const now = Date.now();
  fs.writeFileSync(auditPath, JSON.stringify({
    generatedAt: new Date(now - 3600e3).toISOString(),
    results: [
      row({ id: 'BRO-501', cmd: 'node --test scripts/lib/a501.test.mjs tests/unit/b501.test.mjs' }),
      row({ id: 'BRO-502', cmd: 'npx tsx --test tests/unit/c502.test.ts' }),
      row({ id: 'BRO-503', cmd: 'node --test scripts/lib/d503.test.mjs' }),
    ],
  }));
  const linear = {
    graphql: async (_q, { id }) => ({ issue: {
      identifier: id, title: `Fix ${id}`, priority: 2, state: { name: 'In Review', type: 'started' },
      createdAt: new Date(now - 10 * DAY).toISOString(), updatedAt: new Date(now - 3 * DAY).toISOString(),
      description: 'x', comments: { nodes: [] },
    } }),
  };
  const touched = [];
  const commitsTouching = async (p) => {
    touched.push(p);
    // b501 only: no subject names the card. c502: subject names it. d503: nothing at all.
    if (p.includes('b501')) return [{ sha: 'eee555eee555', message: 'harden the parser', date: new Date(now - 7 * DAY).toISOString() }];
    if (p.includes('c502')) return [{ sha: 'fff666fff666', message: 'BRO-502: the fix' }];
    return [];
  };
  let landingReads = 0;
  const fetchLanding = async () => {
    landingReads++;
    return {
      runs: [
        { id: 7001, branch: 'land/bro-501-parser', createdAt: new Date(now - 2 * DAY).toISOString() },
        { id: 7003, branch: 'land/bro-503-x', createdAt: new Date(now - 2 * DAY).toISOString() },
      ],
      refs: [{ branch: 'land/bro-503-x', sha: 'zzz' }],
    };
  };
  const run = async (argv) => {
    const spawned = [];
    const spawn = (_node, args) => { spawned.push(args.slice(1, 5).concat(args[6])); return { status: 0, stdout: '' }; };
    const log = console.log;
    console.log = () => {};
    try {
      assert.equal(await main(argv, { linear, commitsTouching, fetchLanding, spawn, auditPath, outPath }), 0);
    } finally {
      console.log = log;
    }
    return { spawned, out: JSON.parse(fs.readFileSync(outPath, 'utf8')) };
  };
  const dry = await run([]);
  assert.equal(dry.spawned.length, 0);
  assert.deepEqual(dry.out.rows.map((r) => [r.id, r.action, r.route || r.reason]), [
    ['BRO-501', 'would-close', 'land-ref'],
    ['BRO-502', 'would-close', 'commit'],
    // No commit touched its test at all: the land listing is not even read for it.
    ['BRO-503', 'leave', NO_OWN_COMMIT],
  ]);
  assert.ok(touched.includes('scripts/lib/a501.test.mjs') && touched.includes('tests/unit/b501.test.mjs'));
  assert.equal(landingReads, 1);
  const live = await run(['--apply']);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(live.out.counts.closed, 2);
  // Every close is a Done-gate update, never a forced one.
  for (const a of live.spawned) {
    assert.deepEqual(a.slice(0, 4), ['update', a[1], '--state', 'Done']);
    assert.ok(!a.includes('--force'));
  }
  assert.match(live.spawned[0][4], /Land run 7001 landed land\/bro-501-parser/);
});

test('CLI: unreadable land evidence turns the land route off for the run, nothing else', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { main } = require('../close-stuck-verified-cards.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closer-land-err-'));
  const auditPath = path.join(dir, 'audit.json');
  const outPath = path.join(dir, 'out.json');
  const now = Date.now();
  fs.writeFileSync(auditPath, JSON.stringify({
    generatedAt: new Date(now - 3600e3).toISOString(),
    results: [row({ id: 'BRO-601', cmd: 'node --test scripts/lib/a601.test.mjs' })],
  }));
  const linear = { graphql: async (_q, { id }) => ({ issue: {
    identifier: id, title: 'x', priority: 2, state: { name: 'In Review', type: 'started' },
    createdAt: new Date(now - 10 * DAY).toISOString(), updatedAt: new Date(now - 3 * DAY).toISOString(),
    description: 'x', comments: { nodes: [] },
  } }) };
  const err = console.error;
  const log = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    assert.equal(await main([], { linear, commitsTouching: async () => [{ sha: 'a1', message: 'anon' }], fetchLanding: async () => { throw new Error('403 rate limit'); }, auditPath, outPath }), 0);
  } finally {
    console.error = err;
    console.log = log;
  }
  const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(out.rows[0].reason, NO_OWN_COMMIT);
  assert.match(out.landEvidenceError, /403/);
});

test('CLI lists Land runs further back for a card older than the first listing', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { main } = require('../close-stuck-verified-cards.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closer-land-old-'));
  const auditPath = path.join(dir, 'audit.json');
  const outPath = path.join(dir, 'out.json');
  const now = Date.now();
  fs.writeFileSync(auditPath, JSON.stringify({
    generatedAt: new Date(now - 3600e3).toISOString(),
    results: [row({ id: 'BRO-701', cmd: 'node --test scripts/lib/a701.test.mjs' })],
  }));
  const cardCreated = new Date(now - 40 * DAY).toISOString();
  const linear = { graphql: async (_q, { id }) => ({ issue: {
    identifier: id, title: 'x', priority: 2, state: { name: 'In Review', type: 'started' },
    createdAt: cardCreated, updatedAt: new Date(now - 3 * DAY).toISOString(), description: 'x', comments: { nodes: [] },
  } }) };
  const calls = [];
  const fetchLanding = async (opts) => {
    calls.push(opts || null);
    if (!opts) return { runs: [], refs: [], coveredSinceMs: now - 12 * DAY };
    return { runs: [{ id: 8001, branch: 'land/bro-701-old', headSha: 's', createdAt: new Date(now - 30 * DAY).toISOString() }], coveredSinceMs: Date.parse(opts.sinceIso) };
  };
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await main([], { linear, commitsTouching: async () => [{ sha: 'b1b1', message: 'anon', date: new Date(now - 35 * DAY).toISOString() }], fetchLanding, auditPath, outPath }), 0);
  } finally {
    console.log = log;
  }
  const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sinceIso, cardCreated);
  assert.equal(calls[1].untilMs, now - 12 * DAY);
  assert.equal(out.rows[0].action, 'would-close');
  assert.equal(out.rows[0].branch, 'land/bro-701-old');
});
