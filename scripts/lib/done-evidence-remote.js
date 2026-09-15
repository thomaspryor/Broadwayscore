/**
 * done-evidence-remote.js — resolve a card's evidence against GitHub's copy of
 * the history, because this sweep's host has no local copy of it (BRO-3426).
 *
 * WHY REMOTE, AND WHY THIS IS NOT A REINVENTION OF landing-verify.js.
 *
 * The obvious implementation of "did this commit land on main" is
 * `git merge-base --is-ancestor <sha> origin/main`, and this repo already has
 * the careful version of it: scripts/lib/landing-verify.js's checkLanded(),
 * with the LANDED / NOT_LANDED / UNKNOWN contract this module's EVIDENCE
 * tri-state is copied from. It cannot be used here, and the reason is written
 * in its own header: on a shallow checkout that git call returns a FALSE
 * "not an ancestor", so checkLanded first tries `git fetch --unshallow` — and
 * under GITHUB_ACTIONS it skips that fetch outright and returns UNKNOWN,
 * because on this repo an unshallow must move ~1.8 GB and cannot finish inside
 * any workable timeout (BRO-3320; it was the wall behind ~3,800 push failures).
 *
 * This sweep's host is exactly that case. .github/workflows/data-health-check.yml
 * checks out with a bare `actions/checkout@v5`, i.e. fetch-depth 1. So every
 * local ancestry probe here would answer UNKNOWN, forever, and the whole
 * PR-EVIDENCE channel would be inert while looking green — the same
 * "silently unverified" shape BRO-3373 had to fix for a different reason.
 * checkLanded's own header names the escape hatch ("callers can escalate to a
 * remote-side check … GitHub compare API"); this module is that escalation,
 * not a second copy of the local check. Measured 2026-09-15: the whole live
 * board carries 19 PR-EVIDENCE lines, so this is ~19 API calls a night.
 *
 * The same argument applies to the vacuous-check refinement below. BRO-3426
 * asks for `git log --diff-filter=A` against the issue's createdAt, and that
 * needs history a depth-1 checkout does not have either — so it is asked of
 * the same remote.
 *
 * TODO (BRO-3426, consolidation): the Linear Migration owner tab is adding
 * scripts/lib/pr-evidence-verify.js — a git-ancestry verifier for PR-EVIDENCE
 * at CLOSE time, i.e. the same question commitIsOnMain/pullIsOnMain answer
 * here, asked at the moment a card is marked Done rather than the morning
 * after. It was NOT on origin/main when this shipped (checked with
 * `git ls-tree origin/main scripts/lib/`), so the check is implemented inline
 * here per that card's own instruction. When it lands, this module should
 * import it rather than keep a second copy — and note that
 * scripts/lib/linear-done-gate.js:85 currently calls extractPrRef and TRUSTS
 * the marker text without re-proving it, which is precisely the gap that
 * makes this sweep necessary after the fact; whichever module wins should be
 * wired into that gate too. Do not edit linear-done-gate.js from here: that
 * tab owns it concurrently.
 *
 * `gh` is injected (runGh) so every function here is unit-testable with a stub
 * and makes zero network calls in tests.
 */

'use strict';

const { execFileSync } = require('child_process');

const REPO_SLUG = 'thomaspryor/Broadwayscore';
// One call, bounded. A hung probe must never eat the step budget the verify
// re-runs need; a slow answer is worth exactly as much as no answer here,
// since both resolve to UNKNOWN and UNKNOWN never accuses anyone.
const GH_TIMEOUT_MS = 15000;

/** Default injectable: one `gh api` call, stdout as a string, null on any failure. */
function defaultRunGh(args, { timeoutMs = GH_TIMEOUT_MS } = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // Rate limit, auth, network, a deleted commit — every one of them means
    // "no answer this run", and this module's callers treat that as UNKNOWN.
    return null;
  }
}

// A PR-EVIDENCE url is free text a human typed into a Linear comment, and it
// is routinely written as a markdown link, so the captured token keeps the
// closing paren: extractPrRef's own url regex is /https?:\/\/\S+/ and 13 of
// the 16 live urls end in ')'. Trailing punctuation is stripped before the
// url is parsed — without this every one of those cards resolves to a
// nonexistent sha and reports FAILED, which is precisely the false accusation
// this whole file is careful about.
function cleanUrl(url) {
  return String(url || '').trim().replace(/[)\].,;'"]+$/, '');
}

/**
 * Split a PR-EVIDENCE url into what it actually references.
 * @returns {{kind:'commit',sha:string}|{kind:'pull',number:string}|{kind:'other'}}
 */
function parseEvidenceUrl(url, { repo = REPO_SLUG } = {}) {
  const u = cleanUrl(url);
  // The owner/repo in the URL must be OURS. Every lookup below is made against
  // the hardcoded REPO_SLUG, so a commit or PR number copied from a different
  // GitHub repository would otherwise be resolved against this one — and PR
  // numbers especially collide freely across repos, so `…/other-repo/pull/827`
  // would silently be answered by OUR PR 827 and reported as that card's
  // evidence (Codex adversarial finding). A foreign URL is 'other', i.e.
  // UNKNOWN, which is the honest answer: we cannot re-prove it from here.
  // ALLOW-LIST, not a deny-list: the url must positively be a github.com url
  // naming OUR owner/repo before any commit/PR shape is read off it. An
  // earlier version only rejected a FOREIGN github.com repo, which left a
  // non-GitHub host (a GitLab or self-hosted mirror ending in /commit/<sha>)
  // falling straight through to the commit parser and being resolved against
  // REPO_SLUG — the same misattribution, one host over. Caught by this
  // module's own test, not in review.
  const host = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\//i.exec(u);
  if (!host) return { kind: 'other' };
  if (host[1].toLowerCase() !== String(repo).toLowerCase()) return { kind: 'other', foreignRepo: host[1] };
  const commit = /\/commit\/([0-9a-f]{7,40})$/i.exec(u);
  if (commit) return { kind: 'commit', sha: commit[1] };
  const pull = /\/pull\/(\d+)$/.exec(u);
  if (pull) return { kind: 'pull', number: pull[1] };
  // e.g. BRO-3247's https://broadwayscorecard.com/data/shows/…json — a real
  // deploy proof, just not one made of git history. 'other' resolves to
  // UNKNOWN upstream, never to BROKEN.
  return { kind: 'other' };
}

/**
 * Is `sha` an ancestor of main right now?
 *
 * GitHub's compare endpoint answers this directly: comparing main...<sha>
 * reports "behind" when <sha> is reachable from main and "identical" when it
 * IS main's tip. "ahead" or "diverged" means it genuinely is not on main.
 * Verified live against four real PR-EVIDENCE shas (including abbreviated
 * ones, which the endpoint resolves).
 *
 * @returns {'holds'|'broken'|'unknown'}
 */
function commitIsOnMain(sha, { runGh = defaultRunGh, repo = REPO_SLUG } = {}) {
  if (!sha) return 'unknown';
  const out = runGh(['api', `repos/${repo}/compare/main...${sha}`, '--jq', '.status']);
  if (out === null || out === '') return 'unknown';
  const status = out.trim();
  if (status === 'behind' || status === 'identical') return 'holds';
  if (status === 'ahead' || status === 'diverged') return 'broken';
  // An unrecognised status is a schema change, not a verdict about this card.
  return 'unknown';
}

/**
 * Was PR #n merged, and is its merge commit on main?
 *
 * Merged-ness alone is not enough: a PR can be merged into a release branch,
 * and a merge commit can later be reverted or dropped by a force-push. So a
 * merged PR's own merge_commit_sha is put through the same ancestry check as
 * a bare commit url — one extra call, only for the handful of PR-shaped urls
 * (1 of 19 live).
 *
 * @returns {'holds'|'broken'|'unknown'}
 */
function pullIsOnMain(number, { runGh = defaultRunGh, repo = REPO_SLUG } = {}) {
  if (!number) return 'unknown';
  const out = runGh(['api', `repos/${repo}/pulls/${number}`, '--jq', '[.merged, .merge_commit_sha] | @tsv']);
  if (out === null || out === '') return 'unknown';
  const [merged, mergeSha] = out.trim().split('\t');
  if (merged !== 'true') return 'broken';
  if (!mergeSha) return 'unknown';
  return commitIsOnMain(mergeSha, { runGh, repo });
}

/**
 * Resolve one PR-EVIDENCE url to the tri-state the classifier expects.
 * @returns {'holds'|'broken'|'unknown'}
 */
function resolveEvidenceUrl(url, opts = {}) {
  const ref = parseEvidenceUrl(url, opts);
  if (ref.kind === 'commit') return commitIsOnMain(ref.sha, opts);
  if (ref.kind === 'pull') return pullIsOnMain(ref.number, opts);
  return 'unknown';
}

/**
 * Did `path` already exist in the repo BEFORE `createdAt`?
 *
 * This is BRO-3426's `git log --diff-filter=A <path>` vs the issue's createdAt,
 * asked remotely (see this file's header for why it cannot be asked locally).
 * The commits endpoint with `path` + `until` lists commits touching that path
 * up to that instant; ANY result means the path predates the card.
 *
 * It is the refinement that makes card-premises-auditor.js's
 * classifyVacuousCheck() safe to apply to a DONE card. That function answers
 * "does this path exist on origin/main NOW", which is the right question for
 * an open card (work unfinished + check already green = the check proves
 * nothing) but the wrong one for a finished card, where the path existing is
 * exactly what success looks like. Without this, every Done card that
 * correctly created the file it promised would be reported VACUOUS.
 *
 * @returns {boolean|null} true = predates the card (vacuous), false = the card's
 *   own work created it (legitimate), null = could not resolve — never scored
 *   as vacuous, same fail-open contract as pathExistsOnOriginMain.
 */
function pathPredatesCard(path, createdAt, { runGh = defaultRunGh, repo = REPO_SLUG } = {}) {
  if (!path || !createdAt) return null;
  const until = new Date(createdAt);
  if (!Number.isFinite(until.getTime())) return null;
  const out = runGh([
    'api',
    `repos/${repo}/commits?path=${encodeURIComponent(path)}&until=${until.toISOString()}&per_page=1`,
    '--jq', 'length',
  ]);
  if (out === null || out === '') return null;
  const n = Number(out.trim());
  if (!Number.isFinite(n)) return null;
  return n > 0;
}

/**
 * Has this path EVER existed in the repo, at any point in its history?
 *
 * The discriminator that stops this sweep from accusing finished work, found
 * by an adversarial pre-ship review against the first live report. Two Done
 * cards were reported FAILED for the same superficial reason — their `node
 * --test` / `test -f` path is absent from main — but the cause was opposite:
 *
 *   BRO-2304  `test -f scripts/push-with-retry.sh`
 *             The real file is scripts/lib/push-with-retry.sh and always was.
 *             The WORK is fine; the card's acceptance criterion has a wrong
 *             path in it and could never have passed, on any day, before or
 *             after the work. Calling that FAILED accuses finished work.
 *   BRO-2421  `node --test tests/unit/bsc-runner.test.mjs`
 *             Same shape — the real file is scripts/lib/bsc-runner.test.mjs.
 *
 * "Absent from main now" cannot tell those two apart from a path that existed
 * and was deleted or reverted, which IS a real regression. Only history can,
 * and a depth-1 CI checkout has none — so, like every other history question
 * in this module, it goes to the remote. Zero commits EVER touching the path
 * means it never existed, i.e. the card is MIS-ARMED rather than broken.
 *
 * This is the same defect class card-premises-auditor.js's auditCardCheckPaths
 * (BRO-2977/BRO-3076) already reports for OPEN cards — "this card can never
 * pass its own check". That function is not reused directly here because it
 * answers existence-now against origin/main, which is the question that cannot
 * separate these two cases; this adds the missing time dimension.
 *
 * Costs one call per Done card that failed — 17 on the first live sweep.
 *
 * @returns {boolean|null} true = never existed (mis-armed), false = it existed
 *   at some point, null = unresolved (never scored either way).
 */
function pathNeverExisted(path, opts = {}) {
  if (!path) return null;
  const { runGh = defaultRunGh, repo = REPO_SLUG } = opts;
  const out = runGh(['api', `repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`, '--jq', 'length']);
  if (out === null || out === '') return null;
  const n = Number(out.trim());
  if (!Number.isFinite(n)) return null;
  return n === 0;
}

module.exports = {
  REPO_SLUG,
  pathNeverExisted,
  GH_TIMEOUT_MS,
  defaultRunGh,
  cleanUrl,
  parseEvidenceUrl,
  commitIsOnMain,
  pullIsOnMain,
  resolveEvidenceUrl,
  pathPredatesCard,
};
