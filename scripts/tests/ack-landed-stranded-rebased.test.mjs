import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { computeStrandedTie } = require('../ack-landed.js');
const core = require('../lib/ack-landed-core.js');

// BRO-4078: BRO-4074's unit tests prove decideAck accepts a stranded row
// given a hand-set tiedToStrandedByPatch:true, but that boolean is computed
// by real git plumbing (git cherry + git patch-id) in ack-landed.js's
// computeStrandedTie, which had no test of its own against an actual rebase.
// This exercises that plumbing end to end: a "stranded" branch with two
// commits, landed by REBASING them onto "origin/main" (new shas, same
// patches — exactly what land.yml does), must be acked; an unrelated commit
// that merely names the card must not.
//
// A throwaway repo, not this repo's own history, for the same reason
// ack-landed-naming-candidates.test.mjs uses one: CI checks out at depth 1.

const REF = 'BRO-9999';
const TASK = `linear:${REF}`;
let repo;

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_COMMITTER_DATE: opts.date || '2026-01-01T12:00:00Z',
      GIT_AUTHOR_DATE: opts.date || '2026-01-01T12:00:00Z',
    },
  }).trim();
}

function commit(message, date, filename = 'f.txt') {
  fs.writeFileSync(path.join(repo, filename), String(Math.random()));
  git(['add', filename]);
  git(['commit', '-m', message], { date });
  return git(['rev-parse', 'HEAD']);
}

test.beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-landed-strand-'));
  git(['init', '-q', '-b', 'main']);
  commit('chore: base', '2026-01-01T09:00:00Z');
  // ack-landed.js always diffs the stranded job's commits against
  // "origin/main" (git cherry origin/main ...), never a bare "main" — mirror
  // that here with a real remote-tracking ref rather than relying on the
  // local branch name.
  git(['remote', 'add', 'origin', repo]);
  git(['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);
});

test.afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ } });

test('BRO-4078: a stranded job\'s two commits, REBASED onto origin/main (new shas), tie by patch — the twin is accepted', () => {
  // The "job" branches off, does two commits, then gets stranded there —
  // never merged into main.
  git(['checkout', '-q', '-b', 'job']);
  commit(`fix(${REF}): part one`, '2026-01-01T10:00:00Z', 'a.txt');
  const strandedSha = commit(`fix(${REF}): part two`, '2026-01-01T10:05:00Z', 'b.txt');

  // Meanwhile origin/main moved on (a real rebase, not a fast-forward).
  git(['checkout', '-q', 'main']);
  commit('chore: unrelated main-line work', '2026-01-01T10:02:00Z', 'c.txt');
  git(['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);

  // land.yml's own operation: rebase the job's commits onto current
  // origin/main. This mints two BRAND NEW shas with identical patches.
  git(['checkout', '-q', 'job']);
  git(['rebase', '-q', 'origin/main']);
  const rebasedTip = git(['rev-parse', 'HEAD']);
  assert.notEqual(rebasedTip, strandedSha, 'a real rebase must mint a new sha, or this test proves nothing');

  // land.yml then fast-forwards main to the rebased tip and pushes.
  git(['checkout', '-q', 'main']);
  git(['merge', '-q', '--ff-only', 'job']);
  git(['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);

  const tie = computeStrandedTie(rebasedTip, strandedSha, { cwd: repo });
  assert.equal(tie.tiedToStranded, false, 'the rebased sha is not an ancestor of the stranded sha (that is the whole bug)');
  assert.equal(tie.tiedToStrandedByPatch, true, 'but its patch matches one of the stranded job\'s own commits');

  // Feed the real git-derived tie into the real decision function — proves
  // the plumbing AND the policy agree, not just one or the other.
  const rows = [
    { ts: '2026-01-01T09:50:00.000Z', event: 'job-spawned', taskId: TASK, jobId: `${TASK}-fixture` },
    { ts: '2026-01-01T10:20:00.000Z', event: 'job-stranded', taskId: TASK, jobId: `${TASK}-fixture`, sha: strandedSha },
  ];
  const decision = core.decideAck({
    ref: REF,
    rows,
    landing: {
      verdict: 'LANDED',
      sha: rebasedTip,
      commitTs: '2026-01-01T11:00:00.000Z',
      authorTs: '2026-01-01T10:05:00.000Z',
      message: `fix(${REF}): part two`,
      tiedToStranded: tie.tiedToStranded,
      tiedToStrandedByPatch: tie.tiedToStrandedByPatch,
    },
    checkout: { containsSha: true, dirtyCodePaths: [] },
    verify: { cmd: 'node -e 1', safe: true, unsafeReason: null, exitCode: 0 },
    reason: 'rebase-landed twin verified via git cherry + patch-id',
  });
  assert.equal(decision.ok, true, decision.refusals.join('\n'));
  assert.equal(decision.row.strandedSha, strandedSha);
  assert.equal(decision.row.sha, rebasedTip);
});

test('BRO-4078: an unrelated commit that merely NAMES the card is rejected by a genuine patch mismatch, not a vacuous empty-upstream exit', () => {
  // Land the stranded job's OWN commits first (rebase, same as the accepted
  // test above), so alreadyUpstream is genuinely non-empty when the unrelated
  // sha is tested below. Without this, the rejection could pass for the
  // wrong reason: computeStrandedTie short-circuits to false whenever NO
  // stranded commit has landed at all (`if (alreadyUpstream.length)` never
  // entering the loop), which would pass this assertion even if the
  // patch-id comparison line was deleted entirely (adversarial review
  // catch — the original version of this test never landed anything).
  git(['checkout', '-q', '-b', 'job']);
  commit(`fix(${REF}): part one`, '2026-01-01T10:00:00Z', 'a.txt');
  const strandedSha = commit(`fix(${REF}): part two`, '2026-01-01T10:05:00Z', 'b.txt');
  git(['checkout', '-q', 'main']);
  commit('chore: unrelated main-line work', '2026-01-01T10:02:00Z', 'c.txt');
  git(['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);
  git(['checkout', '-q', 'job']);
  git(['rebase', '-q', 'origin/main']);
  git(['checkout', '-q', 'main']);
  git(['merge', '-q', '--ff-only', 'job']);
  git(['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);

  // NOW a genuinely unrelated commit lands, naming the card — the exact
  // shape a mistaken --sha would take.
  const unrelatedSha = commit(`chore(${REF}): unrelated cleanup that just happens to mention the card`, '2026-01-01T10:10:00Z', 'z.txt');
  git(['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);

  const tie = computeStrandedTie(unrelatedSha, strandedSha, { cwd: repo });
  assert.equal(tie.tiedToStranded, false);
  assert.equal(tie.tiedToStrandedByPatch, false, 'different diff — naming the card is not enough, even with real upstream twins to compare against');

  const rows = [
    { ts: '2026-01-01T09:50:00.000Z', event: 'job-spawned', taskId: TASK, jobId: `${TASK}-fixture` },
    { ts: '2026-01-01T10:20:00.000Z', event: 'job-stranded', taskId: TASK, jobId: `${TASK}-fixture`, sha: strandedSha },
  ];
  const decision = core.decideAck({
    ref: REF,
    rows,
    landing: {
      verdict: 'LANDED',
      sha: unrelatedSha,
      commitTs: '2026-01-01T11:00:00.000Z',
      authorTs: '2026-01-01T10:10:00.000Z',
      message: `chore(${REF}): unrelated cleanup that just happens to mention the card`,
      tiedToStranded: tie.tiedToStranded,
      tiedToStrandedByPatch: tie.tiedToStrandedByPatch,
    },
    checkout: { containsSha: true, dirtyCodePaths: [] },
    verify: { cmd: 'node -e 1', safe: true, unsafeReason: null, exitCode: 0 },
    reason: 'should be refused — not the stranded job\'s own work',
  });
  assert.equal(decision.ok, false);
  assert.match(decision.refusals.join('\n'), /patch-identical/);
});

test('BRO-4078: computeStrandedTie skips the patch lookup entirely when landed is explicitly false', () => {
  git(['checkout', '-q', '-b', 'job']);
  const strandedSha = commit(`fix(${REF}): work`, '2026-01-01T10:00:00Z', 'a.txt');
  const tie = computeStrandedTie('deadbeef', strandedSha, { cwd: repo, landed: false });
  assert.equal(tie.tiedToStranded, false);
  assert.equal(tie.tiedToStrandedByPatch, false, 'no point diffing a sha that is not even landed');
});
