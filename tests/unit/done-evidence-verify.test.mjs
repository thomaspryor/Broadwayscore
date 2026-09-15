// tests/unit/done-evidence-verify.test.mjs — the Done gate must verify that
// PR-EVIDENCE is actually on origin/main, not just that the words appear.
// Per CLAUDE.md rule 15 this require()s the real modules; the git-backed
// predicate is exercised against a throwaway repo (same fixture shape as
// scripts/lib/landing-verify.test.mjs), never against a stub of git.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractEvidenceRefs,
  evaluateEvidence,
  makeIsCommitOnMain,
  detectOriginRepo,
} = require('../../scripts/lib/done-evidence-verify.js');
const { checkLinearDoneTransition } = require('../../scripts/lib/linear-done-gate.js');
const { extractPrRef } = require('../../scripts/lib/linear-pr-evidence.js');

const LOCAL = 'thomaspryor/Broadwayscore';

// ── parsing ────────────────────────────────────────────────────────────────

test('extractEvidenceRefs: commit URL, PR URL and bare SHA are all found; foreign-repo URLs are set aside', () => {
  const body = 'merged deployed checked (https://github.com/thomaspryor/Broadwayscore/commit/0595e99ad68) '
    + 'see https://github.com/thomaspryor/Broadwayscore/pull/596 and c447589a576 '
    + 'plus https://github.com/thomaspryor/broadway-scorecard-data/commit/7709aa61674';
  const refs = extractEvidenceRefs(body, { originRepo: LOCAL });
  assert.deepEqual(refs.commits, ['0595e99ad68', 'c447589a576']);
  assert.deepEqual(refs.prs, [596]);
  assert.deepEqual(refs.foreign, ['https://github.com/thomaspryor/broadway-scorecard-data/commit/7709aa61674']);
});

test('extractEvidenceRefs: URL path segments, dates and run ids never read as SHAs', () => {
  const body = 'merged deployed checked (https://linear.app/broadway-scorecard/issue/BRO-3378/abcdef1234) run 34843981603 on 2026-09-15';
  const refs = extractEvidenceRefs(body, { originRepo: LOCAL });
  assert.deepEqual(refs, { commits: [], prs: [], foreign: [] });
});

test('extractEvidenceRefs: with the origin unidentified, every GitHub URL is foreign — an unknown checkout never claims someone else\'s PR #7', () => {
  const refs = extractEvidenceRefs('https://github.com/x/y/pull/7 c447589a576', {});
  assert.deepEqual(refs.prs, []);
  assert.deepEqual(refs.foreign, ['https://github.com/x/y/pull/7']);
  assert.deepEqual(refs.commits, ['c447589a576'], 'a bare SHA is still checked against whatever origin/main is here');
});

test('extractEvidenceRefs: English hex words and pure-digit runs are not SHAs', () => {
  const refs = extractEvidenceRefs('merged deployed checked — defaced deadbeef 20260915 1234567', { originRepo: LOCAL });
  assert.deepEqual(refs.commits, []);
});

// ── decision ───────────────────────────────────────────────────────────────

const onMain = (sha) => (sha === 'aaaaaaa' ? true : sha === 'bbbbbbb' ? false : null);

test('evaluateEvidence: one landed commit is enough', () => {
  const r = evaluateEvidence({ commits: ['bbbbbbb', 'aaaaaaa'], prs: [], foreign: [] }, { isCommitOnMain: onMain });
  assert.equal(r.verified, true);
  assert.match(r.reason, /aaaaaaa is on origin\/main/);
});

test('evaluateEvidence: every ref definitively absent -> verified:false', () => {
  const r = evaluateEvidence({ commits: ['bbbbbbb'], prs: [], foreign: [] }, { isCommitOnMain: onMain });
  assert.equal(r.verified, false);
  assert.match(r.reason, /NOT on origin\/main/);
});

test('evaluateEvidence: an unresolvable ref never becomes a false accusation — verified:null', () => {
  const r = evaluateEvidence({ commits: ['bbbbbbb', 'ccccccc'], prs: [], foreign: [] }, { isCommitOnMain: onMain });
  assert.equal(r.verified, null);
  assert.match(r.reason, /could not confirm commit ccccccc/);
});

test('evaluateEvidence: a PR resolves through its merge commit; an open PR is not evidence; a gh failure is unknown', () => {
  const getPr = (n) => (n === 1 ? { sha: 'aaaaaaa', state: 'MERGED' } : n === 2 ? { sha: null, state: 'OPEN' } : null);
  assert.equal(evaluateEvidence({ commits: [], prs: [1], foreign: [] }, { isCommitOnMain: onMain, getPrMergeCommit: getPr }).verified, true);
  const open = evaluateEvidence({ commits: [], prs: [2], foreign: [] }, { isCommitOnMain: onMain, getPrMergeCommit: getPr });
  assert.equal(open.verified, false);
  assert.match(open.reason, /state OPEN/);
  assert.equal(evaluateEvidence({ commits: [], prs: [3], foreign: [] }, { isCommitOnMain: onMain, getPrMergeCommit: getPr }).verified, null);
});

test('evaluateEvidence: no refs at all, or only a foreign repo, is unknown with a reason that says so', () => {
  assert.match(evaluateEvidence({ commits: [], prs: [], foreign: [] }, { isCommitOnMain: onMain }).reason, /names no commit or PR URL/);
  const f = evaluateEvidence({ commits: [], prs: [], foreign: ['https://github.com/a/b/commit/abcdef1'] }, { isCommitOnMain: onMain });
  assert.equal(f.verified, null);
  assert.match(f.reason, /another repo/);
});

// ── the gate ───────────────────────────────────────────────────────────────

const EVIDENCE = 'PR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/commit/aaaaaaa)';

test('gate: the same PR-EVIDENCE line is allowed, refused, or refused-unknown purely on what the verifier says', () => {
  const run = (verifyEvidence) => checkLinearDoneTransition({ targetStateType: 'completed', description: EVIDENCE, verifyEvidence });
  const ok = run(() => ({ verified: true, reason: 'stub' }));
  assert.equal(ok.allowed, true, ok.reason);
  assert.equal(ok.verdict, 'pr-merged-deployed-checked');

  const no = run(() => ({ verified: false, reason: 'commit aaaaaaa is NOT on origin/main' }));
  assert.equal(no.allowed, false);
  assert.equal(no.verdict, 'pr-evidence-not-on-main');
  assert.match(no.reason, /NOT on origin\/main/);
  assert.match(no.reason, /--force/);

  const unk = run(() => ({ verified: null, reason: 'shallow clone' }));
  assert.equal(unk.allowed, false);
  assert.equal(unk.verdict, 'pr-evidence-unverified');
});

test('gate: with no verifier wired, PR-EVIDENCE alone no longer closes anything (fail closed, not open)', () => {
  const r = checkLinearDoneTransition({ targetStateType: 'completed', description: EVIDENCE });
  assert.equal(r.allowed, false);
  assert.equal(r.verdict, 'pr-evidence-unverified');
  assert.match(r.reason, /no evidence verifier/);
});

test('gate: when the PR claim fails, a runnable VERIFY: command on the issue is still evaluated (the refusal\'s own advice must work)', () => {
  const r = checkLinearDoneTransition({
    targetStateType: 'completed',
    description: EVIDENCE,
    existingComments: ['VERIFY: node --test tests/unit/some-fixture.test.mjs'],
    verifyEvidence: () => ({ verified: false, reason: 'commit aaaaaaa is NOT on origin/main' }),
  });
  assert.equal(r.allowed, true, r.reason);
  assert.equal(r.verdict, 'verify-cmd-recorded');
  assert.equal(r.cmd, 'node --test tests/unit/some-fixture.test.mjs');
  assert.equal(r.verification.verified, false, 'the rejected PR verification is still reported alongside');
});

test('gate: a partial PR-EVIDENCE line (not deployed) never reaches the verifier', () => {
  let called = 0;
  const r = checkLinearDoneTransition({
    targetStateType: 'completed',
    description: 'PR-EVIDENCE: merged (https://github.com/thomaspryor/Broadwayscore/commit/aaaaaaa)',
    verifyEvidence: () => { called += 1; return { verified: true, reason: 'stub' }; },
  });
  assert.equal(called, 0);
  assert.equal(r.allowed, false);
});

test('gate: the verifier receives the raw PR-EVIDENCE body, so bare SHAs and commit URLs both reach it', () => {
  let seen = null;
  checkLinearDoneTransition({
    targetStateType: 'completed',
    description: 'PR-EVIDENCE: merged deployed checked c447589a576',
    verifyEvidence: (prRef) => { seen = prRef.body; return { verified: true, reason: 'stub' }; },
  });
  assert.equal(seen, 'merged deployed checked c447589a576');
  assert.equal(extractPrRef('PR-EVIDENCE: merged deployed checked c447589a576').body, 'merged deployed checked c447589a576');
});

// ── the real predicate against a throwaway repo ────────────────────────────

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'done-evidence-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  const git = (...a) => execFileSync('git', a, { cwd: work, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('remote', 'add', 'origin', origin);
  const commit = (name) => {
    fs.writeFileSync(path.join(work, name), `${name}\n`);
    git('add', name);
    git('commit', '-q', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  return { root, work, git, commit };
}

test('makeIsCommitOnMain: landed / not landed / never seen / rebase-rewritten SHA', (t) => {
  const { root, git, commit, work } = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const base = commit('a.txt');
  git('push', '-q', 'origin', 'main');
  const isOnMain = makeIsCommitOnMain({ cwd: work, log: () => {} });

  assert.equal(isOnMain(base), true, 'pushed commit is on origin/main');

  git('checkout', '-q', '-b', 'feature');
  const tip = commit('b.txt');
  assert.equal(isOnMain(tip), false, 'unpushed branch tip is definitively not on origin/main');
  assert.equal(isOnMain('deadbeefcafe'), false, 'a SHA this clone has never seen is not evidence');

  // Rebase-style landing: the same patch reaches main under a NEW sha.
  git('checkout', '-q', 'main');
  git('cherry-pick', tip);
  git('push', '-q', 'origin', 'main');
  const fresh = makeIsCommitOnMain({ cwd: work, log: () => {} });
  assert.equal(fresh(tip), true, 'the original branch-tip SHA is accepted via patch equivalence after a rebase/cherry-pick landing');

  // A merge commit that is not itself on main has no single patch to match —
  // it must stay NOT on main rather than borrowing equivalence from one side.
  git('checkout', '-q', '-b', 'side');
  commit('c.txt');
  git('checkout', '-q', 'feature');
  git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const mergeSha = git('rev-parse', 'HEAD');
  assert.equal(fresh(mergeSha), false, 'an unlanded merge commit gets no patch-equivalence shortcut');
});

test('makeIsCommitOnMain: when origin/main cannot be refreshed, nothing is confirmed OR denied (fail closed, not stale)', (t) => {
  const { root, git, commit, work } = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sha = commit('a.txt');
  git('push', '-q', 'origin', 'main');
  git('remote', 'set-url', 'origin', path.join(root, 'does-not-exist.git'));
  const isOnMain = makeIsCommitOnMain({ cwd: work, log: () => {} });
  assert.equal(isOnMain(sha), null, 'a commit that IS on the stale origin/main is still unknown when the refresh failed');
});

test('detectOriginRepo parses owner/repo from https and ssh remotes', (t) => {
  const { root, git, work } = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git('remote', 'set-url', 'origin', 'https://github.com/thomaspryor/Broadwayscore.git');
  assert.equal(detectOriginRepo(work), 'thomaspryor/Broadwayscore');
  git('remote', 'set-url', 'origin', 'git@github.com:thomaspryor/Broadwayscore.git');
  assert.equal(detectOriginRepo(work), 'thomaspryor/Broadwayscore');
});
