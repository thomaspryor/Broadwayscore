import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CLOSER_MARKER,
  cardTestPath,
  mentionsCard,
  branchIsForCard,
  parseLandingRows,
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

test('cardTestPath accepts only a single node --test file', () => {
  assert.equal(cardTestPath('node --test scripts/lib/a.test.mjs'), 'scripts/lib/a.test.mjs');
  assert.equal(cardTestPath('node --test tests/unit/b.test.js'), 'tests/unit/b.test.js');
  assert.equal(cardTestPath('node --test a.test.mjs b.test.mjs'), null);
  assert.equal(cardTestPath('node scripts/validate-data.js'), null);
  assert.equal(cardTestPath('node --test scripts/lib/a.mjs'), null);
  assert.equal(cardTestPath(undefined), null);
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
      row({ id: 'BRO-9', cmd: 'node scripts/audit-workflow-hygiene.js' }),
      row({ id: 'BRO-10', verdict: 'VERIFIED', cmd: 'node scripts/audit-workflow-hygiene.js' }),
      row({ id: 'BRO-11', cmd: 'node --test scripts/lib/a.test.mjs scripts/lib/b.test.mjs' }),
    ],
  };
  const { candidates, skipped } = planCandidates(report, NOW);
  // BRO-4814: a shared TEST command stays a candidate (its evidence is a card-
  // naming commit touching the file); an unshared non-test command is a
  // candidate on landing evidence; a shared non-test command is not.
  assert.deepEqual(candidates.map((c) => c.id), ['BRO-1', 'BRO-2', 'BRO-5', 'BRO-6']);
  assert.equal(candidates[0].testPath, 'scripts/lib/one.test.mjs');
  assert.equal(candidates[2].testPath, null);
  assert.equal(candidates[3].testPath, 'scripts/lib/shared.test.mjs');
  assert.deepEqual(skipped, {
    'state-Todo': 1,
    'no-verify-command': 1,
    'command-shared-with-another-card': 1,
    'command-multi-file-test': 1,
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
  assert.deepEqual(decideClosure({ candidate, issue: issue(), commits, nowMs: NOW }),
    { close: true, sha: 'bbb222bbb222ccc', evidence: 'touched scripts/lib/one.test.mjs' });
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
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
  assert.deepEqual(d({ description: `needs /visual-qa\n${'## Acceptance criteria\n`node --test scripts/lib/x.test.mjs` passes'}` }), { bounce: true, priorBounces: 0 }); // BRO-6241: a UI card is dispatchable
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
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  assert.equal(code, 3);
  assert.equal(out.counts['bounce:read-failed'], 1);
  assert.deepEqual(spawned, ['BRO-402']);
  assert.equal(out.counts.closed, 1);
});

// ── BRO-4814: non-test commands close on a land/ branch naming the card ────

test('branchIsForCard matches the land/ naming styles in use, never a longer id', () => {
  assert.equal(branchIsForCard('land/bro-4171-row-fix', 'BRO-4171'), true);
  assert.equal(branchIsForCard('land/job/linear-BRO-4171-mv3x9uwn', 'BRO-4171'), true);
  assert.equal(branchIsForCard('land/codex-bro-4171', 'BRO-4171'), true);
  assert.equal(branchIsForCard('land/bro-41710-other', 'BRO-4171'), false);
  assert.equal(branchIsForCard('land/xbro-4171', 'BRO-4171'), false);
});

test('parseLandingRows keeps complete rows and drops torn ones', () => {
  const text = '{"ts":"2026-10-01T00:00:00Z","branch":"land/bro-1","sha":"aaa"}\n{"ts":\n\n{"branch":"land/bro-2"}\n';
  assert.deepEqual(parseLandingRows(text), [{ ts: '2026-10-01T00:00:00Z', branch: 'land/bro-1', sha: 'aaa' }]);
});

test('decideClosure on a non-test command needs a post-creation, non-revert landing naming the card', () => {
  const cand = { id: 'BRO-1', state: 'In Review', cmd: 'node scripts/check-health-row-absent.js --row-b64 eA', testPath: null };
  const created = issue().createdAt;
  const after = new Date(Date.parse(created) + DAY).toISOString();
  const before = new Date(Date.parse(created) - DAY).toISOString();
  const d = (landings) => decideClosure({ candidate: cand, issue: issue(), commits: [], landings, nowMs: NOW });
  assert.deepEqual(d([{ ts: after, branch: 'land/job/linear-BRO-1-x', sha: 'fff' }]),
    { close: true, sha: 'fff', evidence: 'land branch land/job/linear-BRO-1-x' });
  assert.equal(d([]).reason, 'no-landing-naming-card');
  assert.equal(d(undefined).reason, 'no-landing-naming-card');
  assert.equal(d([{ ts: before, branch: 'land/bro-1-early', sha: 'e' }]).reason, 'no-landing-naming-card');
  assert.equal(d([{ ts: after, branch: 'land/bro-10-other', sha: 'o' }]).reason, 'no-landing-naming-card');
  assert.equal(d([{ ts: after, branch: 'land/revert-bro-1', sha: 'r' }]).reason, 'no-landing-naming-card');
  // A commit touching some file is not the evidence for a non-test command.
  assert.equal(decideClosure({ candidate: cand, issue: issue(), commits, landings: [], nowMs: NOW }).reason, 'no-landing-naming-card');
  // Every other safety rule still runs first.
  assert.equal(decideClosure({ candidate: cand, issue: issue({ updatedAt: iso(NOW - 3600e3) }), commits: [],
    landings: [{ ts: after, branch: 'land/bro-1', sha: 'f' }], nowMs: NOW }).reason, 'recent-activity');
  // A card still In Progress has not claimed the work is finished, so a landing
  // that names it (e.g. a plans-only branch) is not enough.
  const ip = { ...cand, state: 'In Progress' };
  assert.equal(decideClosure({ candidate: ip, issue: issue({ state: { name: 'In Progress' }, updatedAt: iso(NOW - 4 * DAY), comments: [] }),
    commits: [], landings: [{ ts: after, branch: 'land/bro-1-plans', sha: 'p' }], nowMs: NOW }).reason, 'landing-evidence-needs-in-review');
  // An unparseable creation date refuses instead of matching every landing.
  assert.equal(decideClosure({ candidate: cand, issue: issue({ createdAt: 'garbage' }), commits: [],
    landings: [{ ts: after, branch: 'land/bro-1', sha: 'f' }], nowMs: NOW }).reason, 'issue-created-unparseable');
});

test('buildClosureComment names the evidence the close used', () => {
  const body = buildClosureComment({ candidate: { id: 'BRO-1', cmd: 'node scripts/x.js', testPath: null }, sha: 'abcdef1234567', auditGeneratedAt: 'T' });
  assert.match(body, /land\/ branch naming this card/);
  assert.doesNotMatch(body, /changed null/);
});

// ── In Review sweep (BRO-5433) ───────────────────────────────────────────
const sweepMod = require('./stuck-card-closer.js');
const listRow = (over = {}) => ({
  identifier: 'BRO-900', title: 'technical thing', priority: 2, updatedAt: iso(NOW - 4 * DAY),
  state: { name: 'In Review', type: 'started' }, labels: { nodes: [] }, ...over,
});
const fullCard = (over = {}) => ({
  identifier: 'BRO-900', title: 'technical thing', priority: 2, updatedAt: iso(NOW - 4 * DAY),
  state: { name: 'In Review', type: 'started' }, description: 'did the work', comments: [], ...over,
});

test('planInReviewSweep: idle 3d+, no owner marker, not already handled, oldest first', () => {
  const issues = [
    listRow({ identifier: 'BRO-1', updatedAt: iso(NOW - 4 * DAY) }),
    listRow({ identifier: 'BRO-2', updatedAt: iso(NOW - 9 * DAY) }),
    listRow({ identifier: 'BRO-3', updatedAt: iso(NOW - 1 * DAY) }),
    listRow({ identifier: 'BRO-4', title: '👑 OWNER: cancel the plan' }),
    listRow({ identifier: 'BRO-5', labels: { nodes: [{ name: 'awaiting-owner' }] } }),
    listRow({ identifier: 'BRO-6' }),
    listRow({ identifier: 'BRO-7', state: { name: 'Todo', type: 'unstarted' } }),
  ];
  assert.deepEqual(sweepMod.planInReviewSweep(issues, NOW, new Set(['BRO-6'])), ['BRO-2', 'BRO-1']);
});

test('decideSweep: only gate-verifiable evidence closes, a refused runnable check bounces, everything else stays', () => {
  const d = (issue, extra = {}) => sweepMod.decideSweep({ issue, nowMs: NOW, ...extra });
  assert.deepEqual(d(fullCard({ description: 'PR-EVIDENCE: merged deployed checked (https://github.com/x/y/commit/abc)' })), { action: 'try-close' });
  assert.deepEqual(d(fullCard({ description: '## Acceptance criteria\n`node --test tests/unit/in-review-backlog.test.mjs`' })), { action: 'try-close' });
  // no evidence and no runnable check: a Todo bounce would strand it (workers skip it), so it stays
  assert.deepEqual(d(fullCard()), { action: 'leave', reason: 'no-evidence' });
  // gate refused on a card a worker could pick up (it has a runnable check): bounce
  const withCmd = '## Acceptance criteria\n`node --test tests/unit/in-review-backlog.test.mjs`';
  assert.deepEqual(d(fullCard({ description: withCmd }), { gateRefused: true }), { action: 'bounce', priorBounces: 0 });
  // gate refused on a PR reference with no runnable check: nothing to hand a worker
  assert.equal(d(fullCard({ description: 'PR-EVIDENCE: merged (https://x/y)' }), { gateRefused: true }).action, 'leave');
  // a land/ branch naming the card is NOT evidence (partial or follow-up landings): nothing closes on it
  assert.equal(d(fullCard()).reason, 'no-evidence');
  // guards on the try-close path (decideClosure/decideBounce parity)
  const evid = 'PR-EVIDENCE: merged deployed checked (https://github.com/x/y/commit/abc)';
  assert.equal(d(fullCard({ description: `${evid}\nRECHECK-AFTER: 2099-01-01` })).reason, 'recheck-after-pending');
  assert.equal(d(fullCard({ description: evid, comments: [{ body: 'worker note', createdAt: iso(NOW - 1 * DAY) }] })).reason, 'recent-activity');
  // an ask to the owner in a comment (where worker reports live) keeps the card out of the sweep
  assert.equal(d(fullCard({ description: evid, comments: [{ body: 'Report. DECISION NEEDED: pick A or B', createdAt: iso(NOW - 6 * DAY) }] })).reason, 'owner-marker');
  // BRO-6166: a worker comment that merely NAMES the Mac coordinator tab is not an ask to the owner
  assert.equal(d(fullCard({ description: evid, comments: [{ body: "Crown passed to cmux tab '\u{1F451} OWNER \u2014 main-green keep-green watch' with a brief", createdAt: iso(NOW - 6 * DAY) }] })).action, 'try-close');
  // refused recently: cooldown; refused long ago: tries again
  assert.equal(d(fullCard({ description: evid, comments: [{ body: sweepMod.buildSweepRefusedComment(), createdAt: iso(NOW - 4 * DAY) }] })).reason, 'refused-recently');
  assert.equal(d(fullCard({ description: evid, comments: [{ body: sweepMod.buildSweepRefusedComment(), createdAt: iso(NOW - 9 * DAY) }] })).action, 'try-close');
  assert.equal(d(fullCard({ description: 'DECISION NEEDED: pick one' })).reason, 'owner-marker');
  assert.equal(d(fullCard({ comments: [{ body: sweepMod.CLOSER_MARKER, createdAt: iso(NOW) }] })).reason, 'closer-already-tried');
  const exhausted = Array.from({ length: MAX_BOUNCES }, () => ({ body: BOUNCE_MARKER, createdAt: iso(NOW - 5 * DAY) }));
  assert.equal(d(fullCard({ description: withCmd, comments: exhausted }), { gateRefused: true }).reason, 'bounce-exhausted');
  // no worker picks priority 0, so it is never bounced into Todo
  assert.equal(d(fullCard({ priority: 0, description: withCmd }), { gateRefused: true }).reason, 'no-auto-worker');
  assert.deepEqual(d(fullCard({ priority: 4, description: withCmd }), { gateRefused: true }), { action: 'bounce', priorBounces: 0 });
});

test('sweep comments never read as gate evidence', () => {
  const { extractPrRef } = require('./linear-pr-evidence.js');
  const { evaluateVerifiability } = require('./verify-gate.js');
  for (const body of [sweepMod.buildSweepClosureComment(), sweepMod.buildSweepBounceComment({ priorBounces: 0 }),
    sweepMod.buildSweepBounceComment({ priorBounces: 1 }), sweepMod.buildSweepRefusedComment()]) {
    assert.equal(extractPrRef(body), null);
    assert.equal(evaluateVerifiability('', [body]).armed, false);
  }
  assert.match(sweepMod.buildSweepBounceComment({ priorBounces: 1, refused: false }), new RegExp(`${BOUNCE_MARKER} \\(2 of ${MAX_BOUNCES}\\)`));
});

test('CLI sweep: closes cards the gate accepts, bounces only one a worker can pick up, leaves the rest', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { main } = require('../close-stuck-verified-cards.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closer-sweep-'));
  const auditPath = path.join(dir, 'audit.json');
  const outPath = path.join(dir, 'out.json');
  const now = Date.now();
  fs.writeFileSync(auditPath, JSON.stringify({ generatedAt: new Date(now - 3600e3).toISOString(), results: [] }));
  const old = new Date(now - 5 * DAY).toISOString();
  const cards = {
    'BRO-901': 'PR-EVIDENCE: merged deployed checked (https://github.com/o/r/commit/aaa)',
    'BRO-902': 'PR-EVIDENCE: merged (https://github.com/o/r/commit/bbb)',
    'BRO-903': 'finished, no reference',
    'BRO-904': 'DECISION NEEDED: owner picks',
    'BRO-905': 'finished, landed under its own branch (a landing alone is not evidence)',
    'BRO-906': '## Acceptance criteria\n`node --test tests/unit/in-review-backlog.test.mjs`',
  };
  const row = (id) => ({ identifier: id, title: `t ${id}`, priority: 2, updatedAt: old, state: { name: 'In Review', type: 'started' }, labels: { nodes: [] } });
  const linear = {
    listOpenIssues: async () => Object.keys(cards).map(row),
    graphql: async (_q, { id }) => ({ issue: { ...row(id), createdAt: old, description: cards[id], comments: { nodes: [] } } }),
  };
  const spawned = [];
  const comments = {};
  const spawn = (_n, args) => {
    const isState = args[3] === '--state';
    spawned.push({ id: args[2], state: isState ? args[4] : 'comment-only' });
    comments[args[2] + (isState ? args[4] : 'comment-only')] = isState ? args[6] : args[4];
    // the Done gate accepts 901 and 905, refuses 902 and 906
    return { status: ['BRO-902', 'BRO-906'].includes(args[2]) && args[3] === '--state' && args[4] === 'Done' ? 5 : 0, stdout: '', stderr: 'gate' };
  };
  const log = console.log; const err = console.error;
  console.log = () => {}; console.error = () => {};
  let out;
  try {
    assert.equal(await main(['--apply'], { linear, commitsTouching: async () => [], spawn, auditPath, outPath,
      landings: [{ ts: new Date(now - DAY).toISOString(), branch: 'land/bro-905-done', sha: 'c0ffee1234567' }] }), 0);
    out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } finally { console.log = log; console.error = err; fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  assert.deepEqual(spawned, [
    { id: 'BRO-901', state: 'Done' },
    { id: 'BRO-902', state: 'Done' },
    { id: 'BRO-902', state: 'comment-only' },
    { id: 'BRO-906', state: 'Done' },
    { id: 'BRO-906', state: 'Todo' },
  ]);
  assert.match(comments['BRO-902comment-only'], /closer-sweep-refused/);
  assert.doesNotMatch(comments['BRO-901Done'], /PR-EVIDENCE/);
  const act = Object.fromEntries(out.rows.map((r) => [r.id, r.action]));
  assert.deepEqual(act, { 'BRO-901': 'sweep-closed', 'BRO-902': 'sweep-leave', 'BRO-903': 'sweep-leave', 'BRO-904': 'sweep-leave', 'BRO-905': 'sweep-leave', 'BRO-906': 'sweep-bounced' });
});
