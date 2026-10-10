import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyJobDoneLanding, detectJobLanding, findUnlandedJobDoneEntries, resolveLandedVerdict,
} = require('../../scripts/lib/headless-unlanded-detection.js');

// Same fixture shape as scripts/lib/landing-verify.test.mjs: a bare origin
// plus a real working checkout, so the ancestry check runs against real git
// state rather than a mock.
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-unlanded-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  const seedGit = (...a) => execFileSync('git', a, { cwd: seed, encoding: 'utf8' });
  seedGit('config', 'user.email', 'test@example.com');
  seedGit('config', 'user.name', 'test');
  seedGit('remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(seed, 'base.txt'), 'base\n');
  seedGit('add', '-A');
  seedGit('commit', '-qm', 'base');
  seedGit('push', '-q', 'origin', 'main');
  return { root, origin };
}

// A fresh clone of origin, standing in for a job's worktree (bsc-runner.js
// provisions job worktrees off origin/main the same way).
function cloneJobCwd(origin, root, name) {
  const cwd = path.join(root, name);
  execFileSync('git', ['clone', '-q', origin, cwd]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd });
  return cwd;
}

function addUnpushedCommit(cwd, name) {
  const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  fs.writeFileSync(path.join(cwd, `${name}.txt`), `${name}\n`);
  git('add', '-A');
  git('commit', '-qm', name);
  return git('rev-parse', 'HEAD').trim();
}

function jobDoneLedger({ taskId, jobId, cwd, extra = {} }) {
  return [
    { event: 'job-spawned', taskId, jobId, subject: 'test job', cwd, logFile: null, model: null, ts: '2026-09-15T10:00:00.000Z' },
    { event: 'job-done', taskId, jobId, sessionId: 'sess-1', costUSD: 1.2, ts: '2026-09-15T10:20:00.000Z', ...extra },
  ];
}

test('classifyJobDoneLanding: pure fail-safe classification', () => {
  assert.equal(classifyJobDoneLanding({ cwdExists: false, landedVerdict: null }), 'unknown');
  assert.equal(classifyJobDoneLanding({ cwdExists: true, landedVerdict: 'LANDED' }), 'landed');
  assert.equal(classifyJobDoneLanding({ cwdExists: true, landedVerdict: 'NOT_LANDED' }), 'unlanded');
  assert.equal(classifyJobDoneLanding({ cwdExists: true, landedVerdict: 'UNKNOWN' }), 'unknown');
  assert.equal(classifyJobDoneLanding({ cwdExists: true, landedVerdict: null }), 'unknown');
});

test('detectJobLanding: missing cwd never reports unlanded', () => {
  const result = detectJobLanding({ cwd: '/tmp/does-not-exist-headless-unlanded-fixture' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.sha, null);
});

test('findUnlandedJobDoneEntries: a job-done with commits not reachable from origin/main is unlanded', () => {
  const { root, origin } = makeFixture();
  try {
    const jobCwd = cloneJobCwd(origin, root, 'job1');
    addUnpushedCommit(jobCwd, 'unpushed-fix'); // "THIS SESSION: KEEP OPEN" shape — committed locally, never landed

    const entries = jobDoneLedger({ taskId: 'linear:BRO-1', jobId: 'job1-abc', cwd: jobCwd });
    const result = findUnlandedJobDoneEntries(entries);

    assert.equal(result.length, 1);
    assert.equal(result[0].taskId, 'linear:BRO-1');
    assert.equal(result[0].jobId, 'job1-abc');
    assert.equal(result[0].verdict, 'NOT_LANDED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('findUnlandedJobDoneEntries: a job whose branch was merged into origin/main is NOT unlanded', () => {
  const { root, origin } = makeFixture();
  try {
    const jobCwd = cloneJobCwd(origin, root, 'job2');
    addUnpushedCommit(jobCwd, 'landed-fix');
    // Simulate merge-worktree-to-main.sh: push the job's commits straight to
    // origin/main (a real merge commit, never squash — see module header),
    // then refresh the job worktree's own view of origin/main.
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: jobCwd });
    execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: jobCwd });

    const entries = jobDoneLedger({ taskId: 'linear:BRO-2', jobId: 'job2-abc', cwd: jobCwd });
    const result = findUnlandedJobDoneEntries(entries);

    assert.deepEqual(result, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('findUnlandedJobDoneEntries: a job-done worktree with zero unique commits is NOT unlanded', () => {
  const { root, origin } = makeFixture();
  try {
    const jobCwd = cloneJobCwd(origin, root, 'job3'); // no extra commits at all
    const entries = jobDoneLedger({ taskId: 'linear:BRO-3', jobId: 'job3-abc', cwd: jobCwd });
    const result = findUnlandedJobDoneEntries(entries);
    assert.deepEqual(result, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('findUnlandedJobDoneEntries: a resumed job (new jobId, reused worktree) is still detected via its own recorded cwd', () => {
  const { root, origin } = makeFixture();
  try {
    const jobCwd = cloneJobCwd(origin, root, 'job4');
    addUnpushedCommit(jobCwd, 'still-unlanded');

    // The original job timed out (job-retried, terminal for the OLD jobId —
    // see dispatch-ledger.js JOB_EVENTS.RETRIED), then bsc-reconcile/
    // resume-headless-job.js spawned a NEW jobId with isolate:false against
    // the SAME worktree. Neither ledger row for the new jobId names a branch
    // — only its own cwd, which is what this detector must key off (not a
    // branch name derived from the new jobId).
    const entries = [
      { event: 'job-spawned', taskId: 'linear:BRO-4', jobId: 'job4-orig', cwd: jobCwd, ts: '2026-09-15T09:00:00.000Z' },
      { event: 'job-retried', taskId: 'linear:BRO-4', jobId: 'job4-orig', ts: '2026-09-15T09:30:00.000Z' },
      { event: 'job-spawned', taskId: 'linear:BRO-4', jobId: 'job4-resumed', cwd: jobCwd, resumed: true, ts: '2026-09-15T09:31:00.000Z' },
      { event: 'job-done', taskId: 'linear:BRO-4', jobId: 'job4-resumed', sessionId: 'sess-2', ts: '2026-09-15T10:00:00.000Z' },
    ];

    const result = findUnlandedJobDoneEntries(entries);
    assert.equal(result.length, 1);
    assert.equal(result[0].jobId, 'job4-resumed', 'must classify the DONE job, not the superseded RETRIED one');
    assert.equal(result[0].cwd, jobCwd);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('findUnlandedJobDoneEntries: a task with no job-done event at all is never reported', () => {
  const entries = [
    { event: 'job-spawned', taskId: 'linear:BRO-5', jobId: 'job5-abc', cwd: '/tmp/whatever', ts: '2026-09-15T10:00:00.000Z' },
    { event: 'job-failed', taskId: 'linear:BRO-5', jobId: 'job5-abc', ts: '2026-09-15T10:10:00.000Z' },
  ];
  assert.deepEqual(findUnlandedJobDoneEntries(entries), []);
});

test('findUnlandedJobDoneEntries: uncommitted (dirty) changes are unlanded even though HEAD never moved off origin/main', () => {
  const { root, origin } = makeFixture();
  try {
    const jobCwd = cloneJobCwd(origin, root, 'job7'); // no commits — HEAD == origin/main
    fs.writeFileSync(path.join(jobCwd, 'edited-but-not-committed.txt'), 'wip\n'); // "KEEP OPEN" shape: edited, never committed

    const entries = jobDoneLedger({ taskId: 'linear:BRO-7', jobId: 'job7-abc', cwd: jobCwd });
    const result = findUnlandedJobDoneEntries(entries);

    assert.equal(result.length, 1, 'a dirty worktree must count as unlanded even with HEAD at origin/main');
    assert.equal(result[0].taskId, 'linear:BRO-7');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('findUnlandedJobDoneEntries: never runs an ancestry check against mainRepoCwd', () => {
  const { root, origin } = makeFixture();
  try {
    const jobCwd = cloneJobCwd(origin, root, 'job8');
    addUnpushedCommit(jobCwd, 'would-be-unlanded');
    const entries = jobDoneLedger({ taskId: 'linear:BRO-8', jobId: 'job8-abc', cwd: jobCwd });

    assert.equal(findUnlandedJobDoneEntries(entries, { mainRepoCwd: jobCwd }).length, 0,
      'the guard must suppress the check entirely when cwd matches mainRepoCwd, regardless of what it would have found');
    assert.equal(findUnlandedJobDoneEntries(entries, { mainRepoCwd: '/some/other/repo' }).length, 1,
      'a non-matching mainRepoCwd must not suppress unrelated jobs');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('classifyJobDoneLanding: dirty always wins over a LANDED verdict', () => {
  assert.equal(classifyJobDoneLanding({ cwdExists: true, landedVerdict: 'LANDED', dirty: true }), 'unlanded');
  assert.equal(classifyJobDoneLanding({ cwdExists: true, landedVerdict: 'LANDED', dirty: false }), 'landed');
});

test('findUnlandedJobDoneEntries: sinceMs excludes job-done events older than the cutoff', () => {
  const { root, origin } = makeFixture();
  try {
    const jobCwd = cloneJobCwd(origin, root, 'job6');
    addUnpushedCommit(jobCwd, 'old-unlanded-work');
    const entries = jobDoneLedger({ taskId: 'linear:BRO-6', jobId: 'job6-abc', cwd: jobCwd });

    const cutoffAfterJob = Date.parse('2026-09-15T11:00:00.000Z'); // after the job-done ts
    assert.deepEqual(findUnlandedJobDoneEntries(entries, { sinceMs: cutoffAfterJob }), []);

    const cutoffBeforeJob = Date.parse('2026-09-15T09:00:00.000Z');
    assert.equal(findUnlandedJobDoneEntries(entries, { sinceMs: cutoffBeforeJob }).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// BRO-3873 step 4: land.yml REBASES before its fast-forward push, so a landed
// job's HEAD is no longer an ancestor of origin/main. Ancestry alone would
// call every such landing 'unlanded' (second-opinion design blocker).
test('resolveLandedVerdict: a landings.jsonl row by tip, or patch-equivalence, overrides NOT_LANDED; nothing overrides LANDED/UNKNOWN', () => {
  const sha = 'a'.repeat(40);
  assert.equal(resolveLandedVerdict({ ancestryVerdict: 'NOT_LANDED', sha, landings: [{ sha: 'b'.repeat(40), tip: sha, branch: 'land/job/x' }] }).verdict, 'LANDED');
  assert.equal(resolveLandedVerdict({ ancestryVerdict: 'NOT_LANDED', sha, landings: [], cherryPlus: false }).verdict, 'LANDED');
  assert.equal(resolveLandedVerdict({ ancestryVerdict: 'NOT_LANDED', sha, landings: [], cherryPlus: true }).verdict, 'NOT_LANDED');
  assert.equal(resolveLandedVerdict({ ancestryVerdict: 'NOT_LANDED', sha, landings: [], cherryPlus: null }).verdict, 'NOT_LANDED');
  assert.equal(resolveLandedVerdict({ ancestryVerdict: 'UNKNOWN', sha, landings: [{ tip: sha, sha }] }).verdict, 'UNKNOWN');
  assert.equal(resolveLandedVerdict({ ancestryVerdict: 'LANDED', sha }).verdict, 'LANDED');
});

test('findUnlandedJobDoneEntries: a job landed by REBASE (land.yml) — HEAD not an ancestor, patches upstream — is NOT unlanded', () => {
  const { root, origin } = makeFixture();
  try {
    const jobCwd = cloneJobCwd(origin, root, 'job-rebased');
    const jobSha = addUnpushedCommit(jobCwd, 'rebased-fix');
    // What land.yml does: origin/main moves (bot churn), the job's commit is
    // replayed on top (new sha, same patch) and fast-forwarded to main.
    const lander = cloneJobCwd(origin, root, 'lander');
    addUnpushedCommit(lander, 'bot-churn');
    execFileSync('git', ['fetch', '-q', jobCwd, 'main'], { cwd: lander });
    execFileSync('git', ['cherry-pick', 'FETCH_HEAD'], { cwd: lander, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: lander });
    execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: jobCwd });
    const landedSha = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: jobCwd, encoding: 'utf8' }).trim();
    assert.notEqual(landedSha, jobSha);
    assert.throws(() => execFileSync('git', ['merge-base', '--is-ancestor', jobSha, 'origin/main'], { cwd: jobCwd }), 'fixture must not be an ancestor');

    const entries = jobDoneLedger({ taskId: 'linear:BRO-3', jobId: 'job3-abc', cwd: jobCwd });
    assert.deepEqual(findUnlandedJobDoneEntries(entries), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
