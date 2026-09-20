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

test('extractEvidenceRefs: English hex words, pure-digit runs and short id fragments are not SHAs', () => {
  const refs = extractEvidenceRefs('merged deployed checked — defaced deadbeef 20260915 1234567 face2face 3f2b8c1a build 3f2b8c1a9d', { originRepo: LOCAL });
  assert.deepEqual(refs.commits, [], 'nothing under 11 hex chars is taken as a bare SHA');
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

test('evaluateEvidence: a commit on main that does not mention the issue is NOT proof — citing HEAD of main cannot close a card', () => {
  const mentions = ({ sha }) => (sha === 'aaaaaaa' ? false : null);
  const r = evaluateEvidence({ commits: ['aaaaaaa'], prs: [], foreign: [] }, { isCommitOnMain: onMain, mentionsIssue: mentions, issueIdentifier: 'BRO-1' });
  assert.equal(r.verified, null);
  assert.match(r.reason, /on origin\/main but does not mention BRO-1/);
  const ok = evaluateEvidence({ commits: ['aaaaaaa'], prs: [], foreign: [] }, { isCommitOnMain: onMain, mentionsIssue: () => true, issueIdentifier: 'BRO-1' });
  assert.equal(ok.verified, true);
  const noId = evaluateEvidence({ commits: ['aaaaaaa'], prs: [], foreign: [] }, { isCommitOnMain: onMain, mentionsIssue: () => false });
  assert.equal(noId.verified, true, 'attribution is only enforced when the caller supplies the issue id');
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

// BRO-3885: checkLinearDoneTransition now actually RUNS a recorded VERIFY
// command before it counts as evidence — orthogonal to what these PR-EVIDENCE
// tests exercise, so they stub the executor to always report a pass.
const ALWAYS_PASSES_CMD_EVIDENCE = () => ({ allowed: true, verdict: 'own-verify-passed', reason: 'stubbed pass' });

test('gate: when the PR claim fails, a runnable VERIFY: command on the issue is still evaluated (the refusal\'s own advice must work)', () => {
  const r = checkLinearDoneTransition({
    targetStateType: 'completed',
    description: EVIDENCE,
    existingComments: ['VERIFY: node --test tests/unit/some-fixture.test.mjs'],
    verifyEvidence: () => ({ verified: false, reason: 'commit aaaaaaa is NOT on origin/main' }),
    verifyCmdEvidence: ALWAYS_PASSES_CMD_EVIDENCE,
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
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const base = commit('a.txt');
  git('push', '-q', 'origin', 'main');
  const isOnMain = makeIsCommitOnMain({ cwd: work, log: () => {} });

  assert.equal(isOnMain(base), true, 'pushed commit is on origin/main');

  git('checkout', '-q', '-b', 'feature');
  const tip = commit('b.txt');
  assert.equal(isOnMain(tip), false, 'unpushed branch tip is definitively not on origin/main');
  assert.equal(isOnMain('deadbeefcafe'), null, 'a SHA this clone cannot resolve is unknown, never an accusation (it may live in a branch never fetched here)');

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

test('makeIsCommitOnMain: offline — nothing is confirmed OR denied, even a commit on the stale local origin/main (main can be rewritten)', (t) => {
  const { root, git, commit, work } = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const sha = commit('a.txt');
  git('push', '-q', 'origin', 'main');
  git('checkout', '-q', '-b', 'feature');
  const tip = commit('b.txt');
  git('remote', 'set-url', 'origin', path.join(root, 'does-not-exist.git'));
  const isOnMain = makeIsCommitOnMain({ cwd: work, log: () => {} });
  assert.equal(isOnMain(sha), null, 'a stale local origin/main is not proof — the remote may have been rewritten');
  assert.equal(isOnMain(tip), null, 'no refresh possible -> unknown');
});

test('makeIsCommitOnMain: after a history rewrite that dropped a commit, the refreshed check denies it (stale local ref must not approve)', (t) => {
  const { root, git, commit, work } = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const keep = commit('a.txt');
  const dropped = commit('b.txt');
  git('push', '-q', 'origin', 'main');
  assert.equal(makeIsCommitOnMain({ cwd: work, log: () => {} })(dropped), true, 'sanity: on main before the rewrite');
  git('reset', '-q', '--hard', keep);
  git('push', '-q', '--force', 'origin', 'main');
  // Simulate a clone whose local origin/main still points at the old tip.
  git('update-ref', 'refs/remotes/origin/main', dropped);
  const fresh = makeIsCommitOnMain({ cwd: work, log: () => {} });
  assert.equal(fresh(dropped), false, 'fetch-first sees the rewritten main; the dropped commit is definitively not on it');
});

test('evaluateEvidence: a foreign URL on the same line does not soften a definitive NOT-on-main verdict', () => {
  const r = evaluateEvidence({ commits: ['bbbbbbb'], prs: [], foreign: ['https://github.com/x/y/commit/abcdef1234567'] }, { isCommitOnMain: onMain });
  assert.equal(r.verified, false);
  assert.match(r.reason, /bbbbbbb is NOT on origin\/main/);
});

test('makeMentionsIssue: merge subjects like "Merge branch \'job/linear-BRO-14-x\'" attribute; a bare merge does NOT attribute through its parents (a sync merge of main would attribute to everything)', (t) => {
  const { root, git, work } = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const { makeMentionsIssue } = require('../../scripts/lib/done-evidence-verify.js');
  const mentions = makeMentionsIssue({ cwd: work, log: () => {} });
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n'); git('add', 'a.txt'); git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'job/linear-BRO-14-x');
  fs.writeFileSync(path.join(work, 'b.txt'), 'b\n'); git('add', 'b.txt'); git('commit', '-q', '-m', 'fix(BRO-14): the thing');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', "Merge branch 'job/linear-BRO-14-x'", 'job/linear-BRO-14-x');
  const named = git('rev-parse', 'HEAD');
  assert.equal(mentions({ sha: named, prNumber: null, issueIdentifier: 'BRO-14' }), true, 'hyphen before the id must not block the match');
  git('checkout', '-q', '-b', 'worktree-thing');
  fs.writeFileSync(path.join(work, 'c.txt'), 'c\n'); git('add', 'c.txt'); git('commit', '-q', '-m', 'feat(BRO-15): other');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'Merge branch worktree-thing', 'worktree-thing');
  const bare = git('rev-parse', 'HEAD');
  assert.equal(mentions({ sha: bare, prNumber: null, issueIdentifier: 'BRO-15' }), false, 'a merge whose subject names no issue is not attributed via its parent range — cite the fix commit');
  assert.equal(mentions({ sha: bare, prNumber: null, issueIdentifier: 'BRO-1' }), false);
});

test('extractEvidenceRefs: a bare UUID on the line never yields a phantom 12-hex commit', () => {
  const refs = extractEvidenceRefs('merged deployed checked session af318b12-6638-4621-8b18-e6b15b4e357c c447589a576', { originRepo: LOCAL });
  assert.deepEqual(refs.commits, ['c447589a576']);
});

test('gate: a proven-not-on-main ref beside an unresolvable sibling still triggers the warning when a VERIFY: command allows Done', () => {
  const r = checkLinearDoneTransition({
    targetStateType: 'completed',
    description: EVIDENCE,
    existingComments: ['VERIFY: node --test tests/unit/some-fixture.test.mjs'],
    verifyEvidence: () => ({ verified: null, reason: 'could not confirm commit deadbeefcafe14', checked: [{ kind: 'commit', ref: 'aaaaaaaaaaaa', onMain: false }, { kind: 'commit', ref: 'deadbeefcafe14', onMain: null }] }),
    verifyCmdEvidence: ALWAYS_PASSES_CMD_EVIDENCE,
  });
  assert.equal(r.allowed, true);
  assert.match(r.warning, /NOT on origin\/main/);
});

test('gate: a PROVEN-false PR claim next to a valid VERIFY: command is allowed but carries a warning', () => {
  const r = checkLinearDoneTransition({
    targetStateType: 'completed',
    description: EVIDENCE,
    existingComments: ['VERIFY: node --test tests/unit/some-fixture.test.mjs'],
    verifyEvidence: () => ({ verified: false, reason: 'commit aaaaaaa is NOT on origin/main' }),
    verifyCmdEvidence: ALWAYS_PASSES_CMD_EVIDENCE,
  });
  assert.equal(r.allowed, true);
  assert.match(r.warning, /NOT on origin\/main/);
  const unknown = checkLinearDoneTransition({
    targetStateType: 'completed',
    description: EVIDENCE,
    existingComments: ['VERIFY: node --test tests/unit/some-fixture.test.mjs'],
    verifyEvidence: () => ({ verified: null, reason: 'shallow' }),
    verifyCmdEvidence: ALWAYS_PASSES_CMD_EVIDENCE,
  });
  assert.equal(unknown.allowed, true);
  assert.equal(unknown.warning, undefined, 'unknown is not an accusation — no warning');
});

test('makeMentionsIssue: reads the landed commit message; BRO-14 does not match BRO-1', (t) => {
  const { root, git, work } = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const { makeMentionsIssue } = require('../../scripts/lib/done-evidence-verify.js');
  fs.writeFileSync(path.join(work, 'x.txt'), 'x\n'); git('add', 'x.txt'); git('commit', '-q', '-m', 'fix(BRO-14): thing');
  const sha = git('rev-parse', 'HEAD');
  const mentions = makeMentionsIssue({ cwd: work, log: () => {} });
  assert.equal(mentions({ sha, prNumber: null, issueIdentifier: 'BRO-14' }), true);
  assert.equal(mentions({ sha, prNumber: null, issueIdentifier: 'BRO-1' }), false);
  assert.equal(mentions({ sha: 'deadbeefcafe', prNumber: null, issueIdentifier: 'BRO-14' }), null);
});

test('detectOriginRepo parses owner/repo from https and ssh remotes', (t) => {
  const { root, git, work } = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  git('remote', 'set-url', 'origin', 'https://github.com/thomaspryor/Broadwayscore.git');
  assert.equal(detectOriginRepo(work), 'thomaspryor/Broadwayscore');
  git('remote', 'set-url', 'origin', 'git@github.com:thomaspryor/Broadwayscore.git');
  assert.equal(detectOriginRepo(work), 'thomaspryor/Broadwayscore');
});
