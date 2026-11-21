// Regression guard for BRO-2359: autonomous-acceptance-recheck.js only scanned
// Notion cards, so a RECHECK-AFTER stamp on a card without a Notion twin was
// invisible for days. BRO-3373 added the Linear candidate source; this asserts
// the recheck script still wires it in and the source exports its entry point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '../..');
const scriptPath = path.join(root, 'scripts/autonomous-acceptance-recheck.js');

test('recheck script exists', () => {
  assert.ok(fs.existsSync(scriptPath));
});

test('recheck script pulls Linear candidates, not only Notion', () => {
  const src = fs.readFileSync(scriptPath, 'utf8');
  assert.match(src, /require\('\.\/lib\/linear-recheck-source\.js'\)/);
  assert.match(src, /fetchLinearRecheckCandidates\(/);
});

test('linear-recheck-source exports the real entry points', () => {
  const mod = require('../../scripts/lib/linear-recheck-source.js');
  assert.equal(typeof mod.fetchLinearRecheckCandidates, 'function');
  assert.equal(typeof mod.mapIssueToCard, 'function');
  assert.equal(typeof mod.buildRecheckCandidatesQuery, 'function');
});

// ── BRO-6240: auto-close of passed cards. These call the REAL functions. ──
const core = require('../../scripts/lib/autonomous-recheck-core.js');
const { closeCardAfterPass } = require('../../scripts/lib/recheck-autoclose.js');

const goodTarget = { cardId: 'BRO-1', name: 'x', verifyCmd: 'node --test tests/unit/a.test.mjs', skip: null };
const goodCard = { id: 'BRO-1', stateType: 'unstarted', notes: 'RECHECK-AFTER: 2026-10-01' };
const pass = { status: 'pass', detail: null };

test('decideAutoClose closes an open stamped card whose real test passed', () => {
  assert.equal(core.decideAutoClose({ card: goodCard, target: goodTarget, result: pass }).close, true);
  assert.equal(core.decideAutoClose({ card: { ...goodCard, stateType: 'backlog' }, target: { ...goodTarget, verifyCmd: 'npx tsx --test scripts/lib/a.test.ts' }, result: pass }).close, true);
});

test('decideAutoClose keeps file-exists and generic checks open', () => {
  for (const verifyCmd of ['test -f docs/a.md', 'npm run lint', 'node scripts/validate-data.js', 'node scripts/run-unit-tests.js', 'node scripts/check-canary-marker.js --date=2026-10-01', 'node scripts/audit-orphan-tests.js', 'npx tsc --noEmit']) {
    const d = core.decideAutoClose({ card: goodCard, target: { ...goodTarget, verifyCmd }, result: pass });
    assert.equal(d.close, false, verifyCmd);
  }
});

test('decideAutoClose requires pass, first-try, stamp, and an open backlog state', () => {
  const t = goodTarget;
  assert.equal(core.decideAutoClose({ card: goodCard, target: t, result: { status: 'fail' } }).close, false);
  assert.equal(core.decideAutoClose({ card: goodCard, target: t, result: { status: 'unverifiable' } }).close, false);
  assert.equal(core.decideAutoClose({ card: goodCard, target: t, result: { status: 'pass', detail: 'passed on retry (first run flaked)' } }).close, false);
  assert.equal(core.decideAutoClose({ card: goodCard, target: { ...t, skip: 'someone is working this card right now' }, result: pass }).close, false);
  for (const stateType of ['started', 'completed', 'canceled', undefined]) {
    assert.equal(core.decideAutoClose({ card: { ...goodCard, stateType }, target: t, result: pass }).close, false, String(stateType));
  }
  assert.equal(core.decideAutoClose({}).close, false);
});

test('decideAutoClose leaves an unstamped card open, stamp read from notes or comments', () => {
  const unstamped = { id: 'BRO-2', stateType: 'unstarted', notes: 'no stamp here', comments: [] };
  assert.equal(core.decideAutoClose({ card: unstamped, target: goodTarget, result: pass }).close, false);
  const viaComment = { ...unstamped, comments: ['Paused.\nRECHECK-AFTER: 2026-10-01'] };
  assert.equal(core.decideAutoClose({ card: viaComment, target: goodTarget, result: pass }).close, true);
});

test('decideAutoClose refuses a not-yet-due stamp and a stamp followed by newer comments', () => {
  const future = { ...goodCard, notes: 'RECHECK-AFTER: 2026-12-01' };
  assert.equal(core.decideAutoClose({ card: future, target: goodTarget, result: pass, now: new Date('2026-10-25') }).close, false);
  const reopened = { id: 'BRO-3', stateType: 'unstarted', notes: '', comments: ['Paused.\nRECHECK-AFTER: 2026-10-01', 'Fix did not hold, redo'] };
  assert.equal(core.decideAutoClose({ card: reopened, target: goodTarget, result: pass }).close, false);
});

test('buildAutoCloseComment names command, commit, run URL and the VERIFY line', () => {
  const c = core.buildAutoCloseComment({ cmd: 'node --test tests/unit/a.test.mjs', sha: 'abc123', runUrl: 'https://github.com/o/r/actions/runs/9' });
  assert.match(c, /Command: `node --test tests\/unit\/a\.test\.mjs`/);
  assert.match(c, /Commit: abc123/);
  assert.match(c, /actions\/runs\/9/);
  assert.match(c, /^VERIFY: node --test tests\/unit\/a\.test\.mjs$/m);
});

function fakeBrain({ comments = [] } = {}) {
  const calls = { comment: [], state: [] };
  const issue = { id: 'u', identifier: 'BRO-1', title: 't', url: 'u', description: '', state: { id: 's-todo', name: 'Todo', type: 'unstarted' }, comments: { nodes: comments } };
  const deps = {
    getIssue: async () => issue,
    getTeam: async () => ({ states: [{ id: 's-todo', name: 'Todo', type: 'unstarted' }, { id: 's-done', name: 'Done', type: 'completed' }] }),
    createComment: async (_id, body) => { calls.comment.push(body); },
    updateIssue: async (_id, patch) => { calls.state.push(patch.stateId); },
  };
  return { calls, getIssue: deps.getIssue, run: (argv, extra) => require('../../scripts/linear-brain.js').main(argv, { ...deps, ...extra }) };
}

test('closeCardAfterPass closes through the real Done gate without re-running the command', async () => {
  const { calls, run, getIssue } = fakeBrain();
  let reran = 0;
  const out = await closeCardAfterPass({
    identifier: 'BRO-1', cmd: 'node --test tests/unit/a.test.mjs', sha: 'abc123', runUrl: 'https://x/runs/1', getIssue,
    linearBrainMain: (argv, deps) => run(argv, deps),
    verifyFallback: () => { reran++; return { allowed: false }; },
  });
  assert.equal(out.closed, true, JSON.stringify(out));
  assert.equal(reran, 0);
  assert.deepEqual(calls.state, ['s-done']);
  assert.match(calls.comment[0], /abc123/);
});

test('closeCardAfterPass refuses when the card left its open state mid-run', async () => {
  const { calls, run } = fakeBrain();
  const out = await closeCardAfterPass({
    identifier: 'BRO-1', cmd: 'node --test tests/unit/a.test.mjs', expectStateType: 'backlog',
    linearBrainMain: (argv, deps) => run(argv, deps),
    getIssue: async () => ({ state: { type: 'started' } }),
  });
  assert.equal(out.closed, false);
  assert.deepEqual(calls.state, []);
});

test('closeCardAfterPass turns a gate refusal into a result instead of exiting the process', async () => {
  const { calls, run, getIssue } = fakeBrain();
  const realExit = process.exit;
  const out = await closeCardAfterPass({
    identifier: 'BRO-1', cmd: 'node --test tests/unit/a.test.mjs', getIssue,
    // A gate that asks about a DIFFERENT command must hit the real fallback, which refuses here.
    linearBrainMain: (argv, deps) => run(argv, { ...deps, verifyCmdEvidence: () => ({ allowed: false, verdict: 'own-verify-failed', reason: 'stub' }) }),
  });
  assert.equal(out.closed, false);
  assert.equal(out.exitCode, 5);
  assert.deepEqual(calls.state, []);
  assert.equal(process.exit, realExit);
});
