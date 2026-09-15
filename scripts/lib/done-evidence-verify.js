/**
 * done-evidence-verify.js — is the evidence on a PR-EVIDENCE line actually on
 * origin/main?
 *
 * Until this existed, `PR-EVIDENCE: merged deployed checked (<url>)` moved an
 * issue to Done on the strength of those three WORDS (linear-pr-evidence.js
 * checks that they appear; nothing checked the URL). Dozens of Done cards
 * whose work never landed were found by hand in 2026-09 — every one of them
 * had passed the gate on shape alone. This module turns the claim into a
 * fact: the cited commit (or the cited PR's merge commit) must be an ancestor
 * of origin/main, or the transition is refused.
 *
 * Seam shape (matches classifyVacuousCheck(cmd, existsFn) and
 * checkCommitsOnMain(card, {isCommitOnMain})): the decision functions are pure
 * and take SEMANTIC predicates — `isCommitOnMain(sha)` and
 * `getPrMergeCommit(n)` — not a shell runner. Tests stub the question, not
 * argv. The real predicates are built by make*() factories that lazy-require
 * their I/O helpers so requiring this file stays cheap for callers that only
 * parse.
 *
 * Reused, not reinvented:
 *   - landing-verify.js checkLanded(): tri-state, shallow-aware ancestry. A raw
 *     `merge-base --is-ancestor` silently answers "not an ancestor" on a
 *     truncated graph — its header records the incident.
 *   - card-premises-auditor.js fetchOriginMain(): depth-bounded fetch, so the
 *     gate never runs an unbounded `git fetch` inside a synchronous CLI.
 *
 * Rebase-aware: autonomous-merge.js rebases a branch onto origin/main before
 * fast-forwarding, and merge-worktree-to-main.sh is the documented human flow
 * — a branch-tip SHA copied before the merge is NOT an ancestor afterwards.
 * Refusing that would accuse honest closers of faking evidence, so a commit
 * that is not an ancestor is given a second, patch-equivalence check
 * (`git cherry`) before it is called NOT_LANDED. PR URLs skip the problem
 * entirely by resolving to the PR's merge commit.
 *
 * Fail-closed on every uncertainty: a shallow clone, a fetch timeout, an
 * unreadable `gh` response, or a commit in some OTHER repo all yield
 * verified:null, and the gate refuses with a reason that says how to satisfy
 * it. Owner `--force "<reason>"` remains the only override.
 */

'use strict';

const { execFileSync } = require('node:child_process');

const COMMIT_URL_RE = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/commit\/([0-9a-f]{7,40})\b/gi;
const PR_URL_RE = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/gi;
// A bare SHA is 7-40 hex containing BOTH a letter and a digit. Pure-digit runs
// are dates, run ids and issue numbers; pure-letter runs are English words
// ("defaced", "deadbeef") — either would otherwise become a definitive "NOT on
// origin/main" verdict against an honest closer. Abbreviated SHAs that happen
// to be all-digit are the accepted cost (cite the URL or a longer SHA).
const BARE_SHA_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/gi;

function normalizeRepo(s) {
  return String(s || '').replace(/\.git$/, '').toLowerCase();
}

/**
 * Pull every commit / PR reference off a PR-EVIDENCE body.
 * @param {string} body - the text after "PR-EVIDENCE:" (linear-pr-evidence.js's prRef.body)
 * @param {{originRepo?: string|null}} [opts] - "owner/repo" of the checkout the
 *   gate runs in. URLs for any other repo are returned as `foreign`: they can
 *   be neither confirmed nor denied from here. When the origin could not be
 *   identified (null), EVERY GitHub URL is foreign — an unknown checkout must
 *   not silently claim someone else's PR number as its own (fail closed).
 *   Bare SHAs are still checked against whatever origin/main is here.
 * @returns {{commits: string[], prs: number[], foreign: string[]}}
 */
function extractEvidenceRefs(body, { originRepo = null } = {}) {
  const s = String(body || '');
  const want = originRepo ? normalizeRepo(originRepo) : null;
  const commits = [];
  const prs = [];
  const foreign = [];
  const push = (arr, v) => { if (!arr.includes(v)) arr.push(v); };

  for (const m of s.matchAll(COMMIT_URL_RE)) {
    if (want && normalizeRepo(m[1]) === want) push(commits, m[2].toLowerCase());
    else push(foreign, m[0]);
  }
  for (const m of s.matchAll(PR_URL_RE)) {
    if (want && normalizeRepo(m[1]) === want) push(prs, Number(m[2]));
    else push(foreign, m[0]);
  }
  // Strip every URL before scanning for bare SHAs so a Linear/Vercel/GitHub
  // path segment can never read as a commit.
  const stripped = s.replace(/https?:\/\/\S+/g, ' ');
  for (const m of stripped.matchAll(BARE_SHA_RE)) push(commits, m[0].toLowerCase());

  return { commits, prs, foreign };
}

/**
 * Decide whether the cited evidence is on origin/main.
 * @param {{commits: string[], prs: number[], foreign: string[]}} refs
 * @param {{isCommitOnMain: (sha: string) => boolean|null,
 *          getPrMergeCommit: (n: number) => {sha: string|null, state: string|null}|null}} predicates
 *   isCommitOnMain: true = on origin/main, false = definitively not, null = could not tell.
 *   getPrMergeCommit: {sha} when merged, {sha:null,state} when not, null on any lookup failure.
 * @returns {{verified: boolean|null, reason: string, checked: object[]}}
 *   verified:true  — at least one cited commit (or PR merge commit) is on origin/main.
 *   verified:false — every cited ref was definitively NOT on origin/main.
 *   verified:null  — nothing could be confirmed (no refs, foreign repo, lookup error, shallow clone).
 */
function evaluateEvidence(refs, { isCommitOnMain, getPrMergeCommit }) {
  const checked = [];
  const commits = (refs && refs.commits) || [];
  const prs = (refs && refs.prs) || [];
  const foreign = (refs && refs.foreign) || [];

  for (const sha of commits) {
    const r = typeof isCommitOnMain === 'function' ? isCommitOnMain(sha) : null;
    checked.push({ kind: 'commit', ref: sha, onMain: r });
    if (r === true) return { verified: true, reason: `commit ${sha} is on origin/main`, checked };
  }
  for (const n of prs) {
    const pr = typeof getPrMergeCommit === 'function' ? getPrMergeCommit(n) : null;
    if (!pr) { checked.push({ kind: 'pr', ref: n, onMain: null, detail: 'lookup failed' }); continue; }
    if (!pr.sha) { checked.push({ kind: 'pr', ref: n, onMain: false, detail: `state ${pr.state || 'unknown'}, no merge commit` }); continue; }
    const r = isCommitOnMain(pr.sha);
    checked.push({ kind: 'pr', ref: n, mergeCommit: pr.sha, onMain: r });
    if (r === true) return { verified: true, reason: `PR #${n} merge commit ${pr.sha} is on origin/main`, checked };
  }
  for (const url of foreign) checked.push({ kind: 'foreign', ref: url, onMain: null });

  if (!commits.length && !prs.length) {
    return {
      verified: null,
      reason: foreign.length
        ? `evidence points at another repo (${foreign[0]}) — it cannot be checked against this checkout's origin/main`
        : 'PR-EVIDENCE names no commit or PR URL',
      checked,
    };
  }
  const anyUnknown = checked.some(c => c.onMain === null);
  if (anyUnknown) {
    const u = checked.find(c => c.onMain === null);
    return { verified: null, reason: `could not confirm ${u.kind} ${u.ref} against origin/main${u.detail ? ` (${u.detail})` : ''}`, checked };
  }
  const bad = checked.find(c => c.onMain === false);
  return {
    verified: false,
    reason: `${bad.kind} ${bad.ref} is NOT on origin/main${bad.detail ? ` (${bad.detail})` : ''}`,
    checked,
  };
}

/** "owner/repo" of the checkout's origin remote, or null. */
function detectOriginRepo(cwd = process.cwd()) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 5000 }).trim();
    const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Real isCommitOnMain: one depth-bounded fetch per factory, then
 * checkLanded() (LANDED -> true, UNKNOWN -> null), with a patch-equivalence
 * fallback for NOT_LANDED so a rebase-rewritten SHA still counts, and a
 * definitive false for a SHA this clone has never seen.
 */
function makeIsCommitOnMain({ cwd = process.cwd(), log = () => {} } = {}) {
  const { checkLanded } = require('./landing-verify.js');
  const { fetchOriginMain } = require('./card-premises-auditor.js');
  let fetchState = null; // null = not yet tried, true = refreshed, false = refresh failed
  const git = (args, timeout = 15000) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout }).trim();

  return function isCommitOnMain(sha) {
    if (fetchState === null) fetchState = fetchOriginMain({ repo: cwd, log }) === true;
    // A refresh that failed leaves origin/main wherever it was — possibly
    // behind (would wrongly refuse) or, after a history rewrite, ahead of the
    // truth (would wrongly approve). Neither direction is a verdict.
    if (!fetchState) {
      log(`[done-evidence-verify] origin/main could not be refreshed — ${sha} cannot be verified this run`);
      return null;
    }
    let landed;
    try {
      landed = checkLanded({ sha, cwd, log });
    } catch (err) {
      log(`[done-evidence-verify] ancestry check errored for ${sha}: ${String(err.message).slice(0, 120)}`);
      return null;
    }
    if (landed.landed === true) return true;
    if (landed.verdict === 'UNKNOWN') {
      // A shallow clone may simply not HAVE the object yet — that stays
      // unknown. In a full clone, a SHA git has never seen is not "unknown",
      // it is not evidence.
      if (landed.shallow) return null;
      try { git(['cat-file', '-e', `${sha}^{commit}`]); } catch { return false; }
      return null;
    }
    // NOT_LANDED — the commit exists but is not an ancestor. Rebased? For a
    // NON-merge commit, ask git cherry whether that one patch is already
    // upstream ("- <sha>"). A merge commit has no single patch to compare, so
    // it stays NOT_LANDED — cite the merge commit that is on main instead.
    try {
      git(['rev-parse', '--verify', '--quiet', `${sha}^2`]);
      return false; // merge commit: no patch-equivalence shortcut
    } catch { /* not a merge — fall through */ }
    try {
      const lines = git(['cherry', 'origin/main', sha, `${sha}^`]).split('\n').filter(Boolean);
      return lines.length === 1 && lines[0].startsWith('- ');
    } catch (err) {
      log(`[done-evidence-verify] cherry check errored for ${sha}: ${String(err.message).slice(0, 120)}`);
      return null;
    }
  };
}

/**
 * Real getPrMergeCommit via `gh pr view` — one bounded call, pinned to
 * `--repo <originRepo>` so PR #7 can never resolve to some other repo's #7
 * through gh's default-repo config. Null on any failure (unauthenticated,
 * rate-limited, no such PR) — the gate then refuses as unverified.
 */
function makeGetPrMergeCommit({ cwd = process.cwd(), originRepo = null, timeoutMs = 15000, log = () => {} } = {}) {
  return function getPrMergeCommit(n) {
    if (!originRepo) return null;
    try {
      const out = execFileSync('gh', ['pr', 'view', String(n), '--repo', originRepo, '--json', 'state,mergeCommit'], {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs,
      });
      const j = JSON.parse(out);
      const sha = j && j.mergeCommit && j.mergeCommit.oid ? String(j.mergeCommit.oid).toLowerCase() : null;
      return { sha, state: (j && j.state) || null };
    } catch (err) {
      log(`[done-evidence-verify] gh pr view ${n} failed: ${String(err.message).slice(0, 120)}`);
      return null;
    }
  };
}

/**
 * The verifier the CLIs wire into checkLinearDoneTransition({verifyEvidence}).
 * @returns {(prRef: {body?: string}) => {verified: boolean|null, reason: string, checked: object[]}}
 */
function makeVerifyEvidence({ cwd = process.cwd(), log = () => {} } = {}) {
  const originRepo = detectOriginRepo(cwd);
  const isCommitOnMain = makeIsCommitOnMain({ cwd, log });
  const getPrMergeCommit = makeGetPrMergeCommit({ cwd, originRepo, log });
  return function verifyEvidence(prRef) {
    const refs = extractEvidenceRefs(prRef && prRef.body, { originRepo });
    return evaluateEvidence(refs, { isCommitOnMain, getPrMergeCommit });
  };
}

module.exports = {
  extractEvidenceRefs,
  evaluateEvidence,
  detectOriginRepo,
  makeIsCommitOnMain,
  makeGetPrMergeCommit,
  makeVerifyEvidence,
};
