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
 *   - landing-verify.js isAncestor() (tri-state) + isShallowRepo(): a raw
 *     `merge-base --is-ancestor` silently answers "not an ancestor" on a
 *     truncated graph (its header records the incident), so a shallow clone
 *     short-circuits to unknown instead of attempting a multi-GB unshallow.
 *   - card-premises-auditor.js fetchOriginMain(): ONE depth-bounded fetch per
 *     factory, before any ancestry check; never an unbounded `git fetch`.
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
// A bare SHA is 11-40 hex containing BOTH a letter and a digit. Pure-digit runs
// are dates, run ids and issue numbers; pure-letter runs are English words
// ("defaced", "deadbeef"); 7-10 hex mixes are UUID/deploy-id fragments far
// more often than commits. 11 is this repo's own `git log --abbrev` width
// (226k+ commits — 7-char prefixes already collide ~100 times), so a copied
// short SHA always qualifies while noise tokens do not. Cite a URL for
// anything shorter.
const BARE_SHA_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{11,40}\b/gi;

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
  // Strip every URL, then every UUID, before scanning for bare SHAs: a
  // Linear/Vercel/GitHub path segment must never read as a commit, and a
  // UUID's 12-hex tail (hyphen is a \b boundary) would otherwise pass the
  // 11-char floor as a phantom ref.
  const stripped = s
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ');
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
function evaluateEvidence(refs, { isCommitOnMain, getPrMergeCommit, mentionsIssue, issueIdentifier }) {
  const checked = [];
  const commits = (refs && refs.commits) || [];
  const prs = (refs && refs.prs) || [];
  const foreign = (refs && refs.foreign) || [];

  // "On main" is necessary, not sufficient: the closers being policed write
  // the evidence, and citing origin/main's HEAD would otherwise be the
  // cheapest cheat. When the caller supplies the issue id and a way to read
  // the commit (or PR) text, the landed commit/PR must name the issue.
  const mustMention = typeof mentionsIssue === 'function' && issueIdentifier;
  const attributed = (kind, ref, sha, prNumber) => {
    if (!mustMention) return true;
    const m = mentionsIssue({ sha, prNumber, issueIdentifier });
    if (m === true) return true;
    checked.push({ kind, ref, onMain: true, attributed: m, detail: m === false ? `does not mention ${issueIdentifier}` : 'attribution unreadable' });
    return false;
  };

  for (const sha of commits) {
    const r = typeof isCommitOnMain === 'function' ? isCommitOnMain(sha) : null;
    if (r === true && attributed('commit', sha, sha, null)) {
      checked.push({ kind: 'commit', ref: sha, onMain: true });
      return { verified: true, reason: `commit ${sha} is on origin/main`, checked };
    }
    if (r !== true) checked.push({ kind: 'commit', ref: sha, onMain: r });
  }
  for (const n of prs) {
    const pr = typeof getPrMergeCommit === 'function' ? getPrMergeCommit(n) : null;
    if (!pr) { checked.push({ kind: 'pr', ref: n, onMain: null, detail: 'lookup failed' }); continue; }
    if (!pr.sha) { checked.push({ kind: 'pr', ref: n, onMain: false, detail: `state ${pr.state || 'unknown'}, no merge commit` }); continue; }
    const r = isCommitOnMain(pr.sha);
    if (r === true && attributed('pr', n, pr.sha, n)) {
      checked.push({ kind: 'pr', ref: n, mergeCommit: pr.sha, onMain: true });
      return { verified: true, reason: `PR #${n} merge commit ${pr.sha} is on origin/main`, checked };
    }
    if (r !== true) checked.push({ kind: 'pr', ref: n, mergeCommit: pr.sha, onMain: r });
  }
  // Foreign URLs are deliberately NOT in `checked`: they are neither confirmed
  // nor denied, and must not turn a definitive "not on main" for a local
  // commit on the same line into a vague "could not confirm <other repo>".

  if (!commits.length && !prs.length) {
    return {
      verified: null,
      reason: foreign.length
        ? `evidence points at another repo (${foreign[0]}) — it cannot be checked against this checkout's origin/main`
        : 'PR-EVIDENCE names no commit or PR URL',
      checked,
    };
  }
  const unattributed = checked.find(c => c.onMain === true && c.attributed === false);
  if (unattributed) {
    return {
      verified: null,
      reason: `${unattributed.kind} ${unattributed.ref} is on origin/main but ${unattributed.detail} — cite the commit or PR that carries this issue's work`,
      checked,
    };
  }
  const anyUnknown = checked.some(c => c.onMain === null || (c.onMain === true && c.attributed === null));
  if (anyUnknown) {
    const u = checked.find(c => c.onMain === null || (c.onMain === true && c.attributed === null));
    return { verified: null, reason: `could not confirm ${u.kind} ${u.ref} against origin/main${u.detail ? ` (${u.detail})` : ''}`, checked };
  }
  const bad = checked.find(c => c.onMain === false);
  return {
    verified: false,
    reason: `${bad.kind} ${bad.ref} is NOT on origin/main${bad.detail ? ` (${bad.detail})` : ''}`,
    checked,
  };
}

/**
 * Real mentionsIssue: does the landed commit's message (or, for a PR, its
 * title/body) name the issue? Commits in this repo carry `BRO-N` routinely.
 * null when the text cannot be read — the gate then refuses as unverified.
 */
function makeMentionsIssue({ cwd = process.cwd(), originRepo = null, timeoutMs = 15000, log = () => {} } = {}) {
  // `[^A-Za-z0-9]` (a '-' IS allowed before the id): this repo's merge
  // subjects read "Merge branch 'job/linear-BRO-3431-mu34ri7q'" and
  // "worktree-bro-3429-watchdog-park" — the id follows a hyphen.
  const idRe = (id) => new RegExp(`(^|[^A-Za-z0-9])${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i');
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs });
  return function mentionsIssue({ sha, prNumber, issueIdentifier }) {
    const re = idRe(issueIdentifier);
    try {
      // The cited commit's OWN message only. A merge commit's parent range is
      // deliberately NOT scanned: for a sync merge ("Merge remote-tracking
      // branch 'origin/main'") that range is main's own history and would
      // attribute to every issue mentioned in it — the exact "cite main's
      // HEAD" hole this check exists to close (verified live: one such SHA
      // attributed to 35 issues). A merge whose subject names the branch
      // ("Merge branch 'job/linear-BRO-N-x'") still attributes; otherwise cite
      // the fix commit itself, which the refusal text says.
      if (re.test(git(['log', '-1', '--format=%B', sha]))) return true;
    } catch (err) {
      log(`[done-evidence-verify] could not read commit ${sha}: ${String(err.message).slice(0, 120)}`);
      return null;
    }
    if (prNumber && originRepo) {
      try {
        const out = execFileSync('gh', ['pr', 'view', String(prNumber), '--repo', originRepo, '--json', 'title,body'], {
          cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs,
        });
        const j = JSON.parse(out);
        return re.test(`${j.title || ''}\n${j.body || ''}`);
      } catch (err) {
        log(`[done-evidence-verify] could not read PR #${prNumber}: ${String(err.message).slice(0, 120)}`);
        return null;
      }
    }
    return false;
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
 * Real isCommitOnMain: one depth-bounded fetch per factory (a failed fetch
 * makes every answer unknown), then tri-state ancestry against origin/main;
 * a SHA git cannot resolve (never fetched, ambiguous prefix) is unknown, never
 * false; an existing non-ancestor gets a patch-equivalence check so a
 * rebase-rewritten SHA still counts; a merge commit gets no such shortcut.
 */
function makeIsCommitOnMain({ cwd = process.cwd(), log = () => {} } = {}) {
  const { isAncestor, isShallowRepo } = require('./landing-verify.js');
  const { fetchOriginMain } = require('./card-premises-auditor.js');
  const git = (args, timeout = 15000) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout }).trim();
  // Decided ONCE per factory: a shallow clone can neither confirm nor deny
  // ancestry (merge-base is fooled by the graft — landing-verify.js header),
  // and unshallowing is a multi-GB fetch that has no place inside a CLI gate.
  // isShallowRepo never throws (it answers false on any git failure).
  const shallow = isShallowRepo(cwd);
  let fetchState = null; // null = not tried, true = refreshed, false = refresh failed
  const refresh = () => { if (fetchState === null) fetchState = fetchOriginMain({ repo: cwd, log }) === true; return fetchState; };

  return function isCommitOnMain(sha) {
    if (shallow) {
      log(`[done-evidence-verify] shallow clone — ${sha} cannot be verified from here`);
      return null;
    }
    // Refresh FIRST, once per factory. main is not force-push-proof here:
    // enforce_admins is off and purge-archives-history.yml rewrites it by
    // design, so a stale local origin/main can contain a commit the remote no
    // longer has. Ancestry against an un-refreshed ref is not a verdict in
    // either direction — a failed refresh yields unknown, never true or false.
    if (!refresh()) {
      log(`[done-evidence-verify] origin/main could not be refreshed — ${sha} cannot be verified this run`);
      return null;
    }
    const landed = isAncestor(sha, 'origin/main', cwd);
    if (landed === true) return true;
    // A SHA git cannot resolve (never fetched, or an AMBIGUOUS short prefix)
    // is unknown, never an accusation — the object may simply live in a
    // branch this clone never fetched.
    try { git(['cat-file', '-e', `${sha}^{commit}`]); } catch { return null; }
    if (landed === null) return null;
    // The commit exists and is definitively not an ancestor. Rebased? For a
    // NON-merge commit, ask git cherry whether that one patch is already
    // upstream ("- <sha>"). A merge commit has no single patch to compare, so
    // it stays not-on-main — cite the merge commit that is on main instead.
    try {
      git(['rev-parse', '--verify', '--quiet', `${sha}^2`]);
      return false;
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
 * @param {{cwd?: string, issueIdentifier?: string|null, log?: Function}} opts
 *   issueIdentifier (e.g. "BRO-3433"): when given, the landed commit/PR must
 *   name it — see evaluateEvidence. The CLIs always pass it.
 * @returns {(prRef: {body?: string}) => {verified: boolean|null, reason: string, checked: object[]}}
 */
function makeVerifyEvidence({ cwd = process.cwd(), issueIdentifier = null, log = () => {} } = {}) {
  const originRepo = detectOriginRepo(cwd);
  const isCommitOnMain = makeIsCommitOnMain({ cwd, log });
  const getPrMergeCommit = makeGetPrMergeCommit({ cwd, originRepo, log });
  const mentionsIssue = makeMentionsIssue({ cwd, originRepo, log });
  return function verifyEvidence(prRef) {
    const refs = extractEvidenceRefs(prRef && prRef.body, { originRepo });
    return evaluateEvidence(refs, { isCommitOnMain, getPrMergeCommit, mentionsIssue, issueIdentifier });
  };
}

module.exports = {
  extractEvidenceRefs,
  evaluateEvidence,
  detectOriginRepo,
  makeIsCommitOnMain,
  makeGetPrMergeCommit,
  makeMentionsIssue,
  makeVerifyEvidence,
};
