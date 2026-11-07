/**
 * land-branch.js — the ONE landing actor: branch → origin/main (BRO-3873, step 2).
 *
 * Extracted from scripts/autonomous-merge.js's approve loop with every
 * Notion/card/email coupling removed. autonomous-merge.js keeps its card
 * wrapper (evidence, oscillation guard, staleness refusal, trailer stamping,
 * card transitions) and calls landBranch() for the git half, so there is
 * still exactly one merge actor; scripts/land.js is the thin hand-landing CLI
 * over the same function.
 *
 * CONTRACT
 *   - Works in an ISOLATED, throwaway `git worktree` (detached HEAD) created
 *     off `repoDir`, never in the shared checkout itself. Nothing here ever
 *     moves the shared checkout's HEAD, touches its index, or runs a
 *     `checkout`/`reset` there (memory: feedback_parallel_worktree_race.md —
 *     ~20 sessions share /Users/tompryor/Broadwayscore). The only writes to
 *     the shared repo are ref-level: `git fetch` (remote-tracking refs and
 *     objects) and `git worktree add/remove` metadata.
 *   - rebase the branch tip onto a PINNED origin/main sha → run the check
 *     gauntlet → ONE fast-forward push of HEAD:main. NEVER rewrites history
 *     and never lets a push layer replay HEAD onto a newer base behind the
 *     checks' back: if origin/main moved during the checks across anything
 *     that could change a verdict, or the push is rejected non-fast-forward,
 *     THIS loop re-fetches, re-rebases and RE-CHECKS, bounded by maxAttempts
 *     (default 3), then refuses. A move across INERT paths only (bot data
 *     churn — see INERT_FOR_VERIFICATION_RE) is rebased over cleanly with
 *     the verdict kept, because on this repo main moves faster than the
 *     gauntlet runs and a strict re-check never converges (measured).
 *   - red check → returns { landed: false, failedCheck } WITHOUT pushing; the
 *     branch ref is never modified on any path (the worktree is detached).
 *   - idempotent: a branch tip that is already an ancestor of origin/main
 *     returns landed:true, pushed:false without pushing; a branch whose
 *     commits rebase to nothing (patches already upstream) likewise. Both
 *     carry a content note when the tip's files have since changed on main
 *     (a later edit or a revert — indistinguishable from here, so it is
 *     surfaced, not refused).
 *
 * SEAMS (all injectable, so scripts/lib/land-branch.test.mjs drives the real
 * git plumbing against throwaway repos while faking the expensive parts):
 *   checks({ cwd, changedFiles, baseSha, repoDir, log }) → [{name, pass, detail}]
 *   pushMain({ cwd, sha, log })                           → throws on failure;
 *                                                            MUST be push-only
 *                                                            (no rebase/merge)
 *   beforePush({ cwd, baseSha, git })                     → optional; may amend
 *                                                            HEAD's MESSAGE
 *                                                            (autonomous-merge
 *                                                            stamps trailers)
 *
 * DEFAULT GAUNTLET — the repo's existing verifiers, tier-3 strength:
 *   scripts/lib/autonomous-checks.js runSafeChecks at tier 3 (the same runner
 *   the nightly loop and the approve tap use, parity by identity): colocated
 *   *.test.mjs per changed file, `node --check` floor for changed scripts,
 *   tsc when .ts/.tsx changed, `next lint` + production `next build` for src/
 *   changes, and a REFUSAL when a substantive diff produced no check at all
 *   (fail closed, never "green because nothing ran"); plus `bash -n` for
 *   changed *.sh, scripts/audit-workflow-concurrency.js as the lint-workflows
 *   proxy, and scripts/lib/merge-post-merge-test-gate.js (the merged-tree
 *   test floor merge-worktree-to-main.sh runs — catches the cross-branch
 *   collision a per-file colocated run cannot, task #1149).
 *
 * DEFAULT PUSH — push-only, under the same cross-session mutex
 * push-with-retry.sh takes (scripts/lib/push-mutex.sh, keyed on the shared
 * git-common-dir), with the repo's pre-push hook running as on any push.
 * Deliberately NOT push-with-retry.sh: on a rejection that script fetches,
 * rebases/merges and pushes AGAIN inside one "attempt" — a replay the checks
 * never saw, which is exactly the unverified-code-on-main this lib exists to
 * prevent (adversarial review, BRO-3873). Retries live here, where a retry
 * re-runs the gauntlet.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { defaultDetail, tapDetail, runSafeChecks, checksEnv, prepareCheckWorkdir, CHECK_TIMEOUT_MS } = require('./autonomous-checks.js');
const { checkLanded } = require('./landing-verify.js');
const { isRunnableTestFile } = require('./merge-post-merge-test-gate.js');
const { segmentHeads } = require('./land-train.js');
const { SITE_PATHS, SITE_DATA_FILES } = require('./should-deploy-gate.js');
const { collectBuildScriptDependencies } = require('./build-script-dependencies.js');

const MAX_ATTEMPTS = 3;
// BRO-6276 deadman: no retry attempt starts once this much wall time has gone. One attempt can take ~50 min
// (merged-tree suite 30 + build 20), and the Land job dies at 125 min with the mutex held (run 40246798624 held it
// 588s on one attempt). Stopping at the attempt boundary hands the lock back cleanly with a result file.
const DEFAULT_LAND_DEADLINE_MS = 55 * 60 * 1000;
// Inert-churn re-rebases allowed per attempt before a full re-check is forced.
const MAX_CHURN_SKIPS = 10;
const REPO_ROOT = path.join(__dirname, '..', '..');
const GIT_NET_TIMEOUT_MS = Number(process.env.GIT_NET_TIMEOUT_SEC || 90) * 1000;
// The merged-tree suite is minutes, not seconds (~4min for scripts/lib, per
// merge-post-merge-test-gate.js) — it gets the build's budget, not a check's.
// 30 min (BRO-6184): the gate's worst case is merged run + unparseable retry + baseline run,
// 3 spawns x TEST_GATE_TIMEOUT_MS (8 min) = 24 min plus checkout setup.
const MERGED_TREE_TIMEOUT_MS = 30 * 60 * 1000;
const CHECK_OUTPUT_MAX_BYTES = 256 * 1024 * 1024;

// Blobless-clone rebase failure (BRO-4141 class, 2026-09-27 our-sinatra land):
// mid-rebase, git lazily fetches missing blobs in batches, and a batch can also
// name a blob THIS rebase just wrote (a 3-way merge result) that its cached
// lookup missed. GitHub answers "not our ref" for that id and the whole batch
// dies, so multi-commit branches failed while squashed ones landed. Two
// defences: prefetch every blob the picks read before any local object exists,
// and retry a rebase that still dies that way (a fresh process sees the blobs
// the failed pass wrote, so each retry gets further).
// The classifier + retry count live in scripts/lib/promisor-fetch-failure.js
// since BRO-4219, because push-with-retry.sh needs the same decision on the
// same checkout shape (its CLI); re-exported below so callers and tests of
// this module are unchanged.
const { isPromisorFetchFailure, PROMISOR_REBASE_RETRIES } = require('./promisor-fetch-failure.js');
const PREFETCH_TIMEOUT_MS = Math.max(GIT_NET_TIMEOUT_MS, 5 * 60 * 1000);
const PREFETCH_MAX_PATHS = 2000;

// ── Pure decision helpers ───────────────────────────────────────────────────

// BRO-6035: generated docs a rebase conflict may be repaired by regenerating (never hand-merged).
const GENERATED_DOC_PATHS = ['.github/workflows/DEPENDENCIES.md'];
/** True when every conflicted path is a generated doc (and at least one is). */
function isGeneratedDocConflict(files) {
  return Array.isArray(files) && files.length > 0 && files.every((f) => GENERATED_DOC_PATHS.includes(f));
}

/**
 * The first check that did not PASS, or null when every check passed (or
 * none ran). Fails closed: a result without `pass: true` — `{name}` alone, a
 * malformed entry — counts as a failure, never as green.
 */
function firstFailedCheck(results) {
  for (const r of results || []) {
    if (!r || r.pass !== true) return r ? { name: r.name || 'malformed-check', ...r, pass: false } : { name: 'malformed-check', pass: false, detail: 'check result was empty' };
  }
  return null;
}

/**
 * Paths whose content cannot change a check verdict: bot-written data and
 * telemetry, generated public data, memory, prose. This repo pushes such
 * commits to main every minute or two (~200 workflows), while the gauntlet
 * takes ~2 minutes — a policy of "re-check on EVERY move" measured 3 moves
 * in 355s and never converged (BRO-3873 landing 1). A clean rebase across
 * commits that touch ONLY these paths keeps the verdict; anything else
 * re-runs the checks. Same judgement scripts/merge-worktree-to-main.sh and
 * memory/feedback_parallel_worktree_race.md already record.
 *
 * public/opening-night-status.json (BRO-4956): rewritten by the status-page
 * workflow ~50 times a day, read by no test or check (only robots.ts names
 * its URL). Counting it as code lost land.js three races in a row on
 * 2026-10-10 and refused a green landing. public/images/shows/ likewise:
 * the image-fetch workflows commit posters/thumbnails in bulk (158 files in
 * one window refused land/bro-4956-email-dup-alert the same day); a test that
 * reads one show's image reads it like data/shows.json, which is already
 * inert, and the delta gate still judges the branch against its base.
 */
const INERT_FOR_VERIFICATION_RE = /^(data\/|public\/data\/|public\/images\/shows\/|cloud-memory\/|memory\/|docs\/)|^public\/opening-night-status\.json$|\.(md|jsonl|log|txt)$/;

// Byte-capped docs (scripts/tests/global-instructions.test.mjs, claude-md integrity):
// a main move that edits one changes what the merged tree's cap test sees, so it
// is never inert even though it is prose (BRO-5732: two lands each editing
// .claude/CLOUD.md passed the cap alone and exceeded it together, BRO-5594/5648).
// Anchored: .github/workflows/CLAUDE.md is not capped and stays inert.
const CAPPED_DOCS_RE = /^(CLAUDE\.md|AGENTS\.md|\.claude\/CLOUD\.md)$/;
const CAPPED_DOCS_TEST = 'scripts/tests/global-instructions.test.mjs';

// BRO-6519: inert bot ledgers that a landing and main both write all the time
// (the Land job's own alert-ledger update, ingest runs' spend rows), so "both
// sides changed it" was the norm, and it sent every such landing to the full
// 10-12 min re-check. The branch is already rebased onto main when the scope is
// chosen (a conflicting rebase never reaches the checks), so a clean merge of
// one of these is not a clash. The .jsonl is merge=union (.gitattributes); the
// keyed-object .json counts only when the merged file still parses (ledgerOk).
// Named one by one: other data/audit ledgers are not covered.
const BOTH_SIDES_LEDGER_RE = /^data\/audit\/(alert-ledger\.json|scraper-spend-ledger\.jsonl)$/;

/** True when `file` changed on both sides may still take the small re-check. ledgerOk(file) checks a .json ledger in the merged tree; null = unknown. */
function isMergeableBothSidesLedger(file, ledgerOk = null) {
  const f = String(file);
  if (!BOTH_SIDES_LEDGER_RE.test(f) || !isInertForVerification(f)) return false;
  if (f.endsWith('.jsonl')) return true;
  return typeof ledgerOk === 'function' && ledgerOk(f) === true;
}

/** True when `file` exists and parses as JSON. */
function jsonFileParses(file) {
  try { JSON.parse(fs.readFileSync(file, 'utf8')); return true; } catch { return false; }
}

function isInertForVerification(file) {
  return !CAPPED_DOCS_RE.test(String(file)) && INERT_FOR_VERIFICATION_RE.test(String(file));
}

/** 'inert' when every intervening file is inert (and there is at least one), else 'substantive'. */
function classifyIntervening(files) {
  const list = (files || []).map(String);
  return list.length && list.every(isInertForVerification) ? 'inert' : 'substantive';
}

/**
 * A push failure is only worth a retry when origin/main actually moved —
 * anything else (a pre-push hook block, auth, a network error) would fail the
 * same way three times and be misreported as a lost race.
 */
function classifyPushFailure({ baseSha, nowBase }) {
  return nowBase && baseSha && nowBase !== baseSha ? 'race' : 'rejected';
}

/**
 * The deadline for starting another attempt, from LAND_DEADLINE_MIN (whole minutes, 5..120) or the default.
 * Anything else falls back to the default rather than switching the deadman off.
 */
function landDeadlineMs(env = process.env) {
  const raw = env.LAND_DEADLINE_MIN;
  const min = /^\d+$/.test(String(raw ?? '').trim()) ? Number(raw) : NaN;
  // 0 = no retries (land.yml's deadman has under one attempt of time left).
  return min >= 0 && min <= 120 ? min * 60 * 1000 : DEFAULT_LAND_DEADLINE_MS;
}

/** Why attempt N must not start (null = go). Attempt 1 always runs: the deadline only stops retries. Pure. */
function deadlineRefusal({ attempt, elapsedMs, deadlineMs }) {
  if (attempt <= 1 || !(elapsedMs >= deadlineMs)) return null;
  return `${Math.round(elapsedMs / 60000)} min spent, past the ${Math.round(deadlineMs / 60000)} min deadline: not starting attempt ${attempt}, handing the landing mutex back`;
}

/** Whether a failed attempt gets another go. Bounded, never unbounded. */
function shouldRetry(attempt, maxAttempts = MAX_ATTEMPTS) {
  return attempt < maxAttempts;
}

// BRO-4379: land.yml's `land` job sits in the `landing` concurrency group,
// which keeps ONE pending run and cancels an older pending one when a newer
// land/** push arrives. A headless job whose Land job was cancelled that way
// used to stop at "re-run this script" and strand its work.
// Same cap as the server-side re-trigger (land-retry-on-cancel.js: a run may
// reach MAX_ATTEMPTS attempts, i.e. MAX_ATTEMPTS-1 re-runs), so the script never
// calls a cancel final while the server would still re-run it.
// BRO-5196: a parked run may be resumed up to PARKED_MAX_ATTEMPTS - 1 times; the
// script cannot tell parked from evicted, and a server that refuses ends it as a
// resumable TIMEOUT, never a false REFUSED.
const MAX_CANCEL_RETRIES = Math.max(require('./land-retry-on-cancel').MAX_ATTEMPTS, require('./land-mutex').PARKED_MAX_ATTEMPTS) - 1;
const CANCEL_RETRY_BACKOFF_SEC = [30, 60, 120];

/**
 * Pure decision: should the landing script re-run a land.yml run whose Land
 * job was cancelled? Yes only when the Checks job verified this tip
 * (success), the Land job itself was cancelled, origin/<land branch> is still
 * at `tip` (a newer push means the newer run owns the landing), and the retry
 * budget is not spent. Fails closed on any missing/unknown input.
 * @returns {{retry:boolean, reason:string, backoffSec:number}}
 */
function decideCancelledLandRetry({ landConclusion, checksConclusion, remoteTip, tip, retriesUsed, maxRetries = MAX_CANCEL_RETRIES } = {}) {
  const no = (reason) => ({ retry: false, reason, backoffSec: 0 });
  if (!Number.isInteger(retriesUsed) || retriesUsed < 0) return no(`invalid retriesUsed ${JSON.stringify(retriesUsed)}`);
  if (landConclusion !== 'cancelled') return no(`Land job conclusion is ${JSON.stringify(landConclusion || null)}, not cancelled`);
  if (checksConclusion !== 'success') return no(`Checks job conclusion is ${JSON.stringify(checksConclusion || null)}, not success`);
  if (!tip || !remoteTip) return no('tip or remote tip unknown');
  if (remoteTip !== tip) return no(`origin branch moved (${String(remoteTip).slice(0, 10)} != ${String(tip).slice(0, 10)}): a newer push owns the landing`);
  if (retriesUsed >= maxRetries) return no(`retry budget spent (${retriesUsed}/${maxRetries})`);
  const backoffSec = CANCEL_RETRY_BACKOFF_SEC[Math.min(retriesUsed, CANCEL_RETRY_BACKOFF_SEC.length - 1)];
  return { retry: true, reason: `Land cancelled while pending, Checks green, tip unchanged — retry ${retriesUsed + 1}/${maxRetries}`, backoffSec };
}

// A retry-eligible cancel is re-run SERVER-side (land-retry-cancelled.yml,
// BRO-4246); the landing script only waits for it. It used to call
// `gh run rerun` itself 30s later, which raced the server: on 2026-09-29 the
// server had already re-run land run 36629730821, the local rerun failed with
// "This workflow is already running", and the script printed REFUSED
// ("nothing reached main") for a run that was live.
// The server re-trigger starts from a workflow_run event and needs a runner
// first; under queue pressure that takes minutes. The sweep re-runs one
// stranded run per Land completion (oldest first), so in a burst the re-run
// can come several landings later.
// BRO-5196: a Land job parked behind a deep queue resumes only as landings
// finish (~2-3 min each, queue held near PARK_DEPTH), so allow a full queue's drain.
const CANCEL_GRACE_SEC = 2700;
const CANCEL_GRACE_POLL_SEC = 15;

// decideCancelledWait lives in land-retry-on-cancel.js (shared with the
// server-side retry script); re-exported below for merge-worktree-to-main.sh.
const { decideCancelledWait } = require('./land-retry-on-cancel');

/**
 * A branch name is passed to git as a positional ref; refuse anything that
 * could read as an option or contain whitespace/control characters. Not a
 * full refname validator — git's own `check-ref-format` does that below.
 */
function isPlausibleBranchName(name) {
  const s = String(name || '');
  return s.length > 0 && !s.startsWith('-') && !/[\s~^:?*[\\]/.test(s) && !s.includes('..');
}

/** The one-line verdict scripts/land.js prints. */
function formatLandLine(branch, result) {
  const secs = (Number(result.wallMs || 0) / 1000).toFixed(1);
  if (result.landed) {
    const notes = [];
    if (!result.pushed) notes.push('already on origin/main, no push');
    if (result.verified === 'UNKNOWN') notes.push('ancestry UNKNOWN — verify remotely');
    if (result.contentNote) notes.push(result.contentNote);
    if (result.riders && result.riders.length) notes.push(`merge train: +${result.riders.length} rider(s) ${result.riders.map((r) => r.branch).join(', ')}`);
    const note = notes.length ? ` (${notes.join('; ')})` : '';
    return `LANDED: ${branch} → ${result.sha} in ${secs}s (attempts ${result.attempts})${note}`;
  }
  if (result.dryRun) return `DRY-RUN OK: ${branch} → ${result.sha} checks green in ${secs}s, push skipped`;
  const why = result.failedCheck ? `${result.failedCheck}: ${result.reason || ''}` : (result.reason || 'unknown');
  return `REFUSED: ${why} (attempts ${result.attempts}, ${secs}s)`;
}

/**
 * Pure decision for a landing whose gauntlet ALREADY ran elsewhere against
 * `verifiedBase` (land.yml's `checks` job, BRO-3873 step 3): may the rebase
 * onto `baseSha` reuse that verdict? Yes when the base is the very sha that
 * was verified, or has moved past it across INERT paths only (the same
 * judgement the in-process loop applies after its own checks). Anything
 * else — a substantive move, a base that does not descend from the verified
 * one (force-moved main, wrong sha), unknown ancestry — is `skip: false`,
 * i.e. run the full gauntlet. Fails closed.
 * @param {{verifiedBase:string, baseSha:string, ancestor:boolean, intervening:string[]}} o
 *   ancestor: is verifiedBase an ancestor of baseSha (false/unknown → no skip)
 *   intervening: files changed verifiedBase..baseSha
 */
function decideVerifiedBaseSkip({ verifiedBase, baseSha, ancestor, intervening }) {
  if (!verifiedBase || !baseSha) return { skip: false, reason: 'no verified base' };
  if (verifiedBase === baseSha) return { skip: true, reason: `base ${baseSha.slice(0, 10)} is the verified base` };
  if (ancestor !== true) return { skip: false, reason: `verified base ${verifiedBase.slice(0, 10)} is not an ancestor of ${baseSha.slice(0, 10)}` };
  const files = (intervening || []).map(String);
  const kind = classifyIntervening(files);
  if (kind === 'inert') return { skip: true, reason: `main moved ${verifiedBase.slice(0, 10)} → ${baseSha.slice(0, 10)} across ${files.length} inert path(s) only` };
  return { skip: false, reason: `main moved ${verifiedBase.slice(0, 10)} → ${baseSha.slice(0, 10)} across ${files.length} file(s), substantive` };
}

/**
 * Site CODE a production build compiles: should-deploy-gate.js's SITE_PATHS
 * (src/ imports scripts/lib, prebuild runs scripts/) minus the data files
 * bots rewrite every few minutes, which would otherwise make every src/
 * landing rebuild. A known merged-tree buildScripts graph narrows scripts/
 * to site/config/prebuild dependencies; an unknown graph stays conservative.
 */
function isBuildCodePath(file, buildScripts = null) {
  const f = String(file);
  if (f.startsWith('public/data/') || SITE_DATA_FILES.includes(f)) return false;
  if (f.startsWith('public/images/shows/') || f === 'public/opening-night-status.json') return false;
  // Only prune script code when the merged tree's dependency graph is known.
  // Non-code inputs (manifests, templates) retain the broad classification.
  if (f.startsWith('scripts/') && /\.(?:[cm]?js|jsx|ts|tsx|sh)$/.test(f) && buildScripts instanceof Set) return buildScripts.has(f);
  return SITE_PATHS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));
}

/**
 * How much of the in-mutex re-check to run once decideVerifiedBaseSkip has
 * said "re-check" (BRO-5700; the owner accepted that a clash between two
 * changes may then be caught by the deploy build or test.yml on main).
 * 'small' only when main's intervening files are positively known, share no
 * file with the branch, and the switch is not set: the merged-tree floor then
 * runs only the listed tests (the branch's, and those main changed since the
 * verified base, BRO-5180) instead of the whole scripts/lib suite, and the
 * production build runs only when the branch changed src/ and main changed
 * build code (isBuildCodePath). Unknown
 * ancestry, a failed diff, an overlap or the switch → 'full', today's
 * re-check. Fails closed. A bot ledger both sides wrote is not an overlap
 * (isMergeableBothSidesLedger, BRO-6519).
 * @param {{ancestor:boolean, intervening:(string[]|null), changedFiles:string[], disabled?:boolean, buildScripts?:(Set<string>|null), ledgerOk?:((file:string)=>boolean)|null}} o
 * @returns {{mode:'full'|'small', build:boolean, reason:string}}
 */
function selectRecheckScope({ ancestor, intervening, changedFiles, disabled = false, buildScripts = null, ledgerOk = null }) {
  if (disabled) return { mode: 'full', build: true, reason: 'small re-check disabled (LAND_SMALL_RECHECK_DISABLED=true)' };
  if (ancestor !== true || !Array.isArray(intervening)) return { mode: 'full', build: true, reason: 'files main changed since the verified base are unknown' };
  if (!Array.isArray(changedFiles)) return { mode: 'full', build: true, reason: 'files the branch changed are unknown' };
  const mine = new Set((changedFiles || []).map(String));
  const shared = intervening.map(String).filter((f) => mine.has(f) && !isMergeableBothSidesLedger(f, ledgerOk));
  if (shared.length) return { mode: 'full', build: true, reason: `branch and main both changed ${shared.length} file(s) (${shared.slice(0, 3).join(', ')})` };
  // runSafeChecks builds only for a src/ change on the branch (hasSrcChange).
  const build = [...mine].some((f) => f.startsWith('src/')) && intervening.some(f => isBuildCodePath(f, buildScripts));
  return { mode: 'small', build, reason: `no file changed on both sides; build ${build ? 'runs (both sides changed build code)' : 'skipped (deploy builds it)'}` };
}

/**
 * selectRecheckScope for a merge train (BRO-6276). To member i, every other
 * member's files are exactly like main changing after i was verified, so
 * member i's intervening set is main's files since ITS verified base plus the
 * other members' files, and each member goes through selectRecheckScope.
 * 'small' only when every member is small; build is the OR. Full when the
 * switch is set, any member lacks a verified base (a rider whose ticket had
 * no Land-Base only has a merge-base, which no gauntlet verified), its base
 * is not an ancestor of main, or any diff failed (null). Fails closed.
 * @param {{members:Array<{name:string, base:(string|null), verified:boolean, ancestor:boolean, mainChanged:(string[]|null), files:(string[]|null)}>, disabled?:boolean, buildScripts?:(Set<string>|null)}} o
 * @returns {{mode:'full'|'small', build:boolean, reason:string}}
 */
function selectTrainRecheckScope({ members, disabled = false, buildScripts = null }) {
  const full = (reason) => ({ mode: 'full', build: true, reason });
  if (disabled) return full('small re-check disabled (LAND_SMALL_RECHECK_DISABLED / LAND_TRAIN_SMALL_RECHECK_DISABLED)');
  if (!Array.isArray(members) || members.length < 2) return full('not a train');
  for (const m of members) {
    if (!m.verified || !/^[0-9a-f]{40}$/.test(String(m.base || ''))) return full(`${m.name} has no verified base`);
    if (!Array.isArray(m.files)) return full(`files ${m.name} changed are unknown`);
  }
  let build = false;
  for (const m of members) {
    const others = members.filter((x) => x !== m).flatMap((x) => x.files);
    const scope = selectRecheckScope({
      ancestor: m.ancestor,
      intervening: Array.isArray(m.mainChanged) ? [...m.mainChanged, ...others] : null,
      changedFiles: m.files,
      buildScripts,
    });
    if (scope.mode !== 'small') return full(`${m.name}: ${scope.reason}`);
    build = build || scope.build;
  }
  return { mode: 'small', build, reason: `no file changed by two of the ${members.length} members or by main since their verified bases; build ${build ? 'runs' : 'skipped (deploy builds it)'}` };
}

/**
 * A checks seam that reuses an upstream verdict when decideVerifiedBaseSkip
 * allows it and otherwise runs `checks` (the full default gauntlet). On the
 * skip path the throwaway worktree is still prepared (node_modules link,
 * core-data copies) because the repo's pre-push hook runs from it on push.
 * `git` is injectable for tests; the default is a null-on-error runner.
 */
function makeVerifiedBaseChecks({ verifiedBase, checks = defaultChecks, git = null, prepare = prepareCheckWorkdir }) {
  if (!/^[0-9a-f]{40}$/.test(String(verifiedBase || ''))) throw new Error(`makeVerifiedBaseChecks: verifiedBase must be a full 40-hex sha (got ${JSON.stringify(verifiedBase)})`);
  const run = git || ((args, cwd) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_NET_TIMEOUT_MS }).trim();
    } catch { return null; }
  });
  return function verifiedBaseChecks(o) {
    const { cwd, baseSha, repoDir, log = () => {} } = o || {};
    const ancestor = run(['merge-base', '--is-ancestor', verifiedBase, baseSha], cwd) !== null;
    // --no-renames: a rename on main must show both names to the overlap test.
    const diffOut = ancestor ? run(['diff', '--name-only', '--no-renames', `${verifiedBase}..${baseSha}`], cwd) : null;
    const intervening = diffOut === null ? [] : diffOut.split('\n').filter(Boolean);
    const decision = decideVerifiedBaseSkip({ verifiedBase, baseSha, ancestor: ancestor && diffOut !== null, intervening });
    if (!decision.skip) {
      // BRO-5180: the re-check selects tests from the BRANCH diff, so a test
      // tightened on main after the upstream gauntlet ran (land run
      // 38256667945: a guard widened to scripts/ subfolders) never met the
      // branch's new file. Feed the test files main changed in that window to
      // the merged-tree floor too. Only test files: a guard tightened through
      // its helper or data file on main is still not selected.
      // A test main deleted is absent here; dropping it keeps it from arming
      // the whole scripts/lib suite for nothing. An intervening scripts/lib
      // test still does arm it (~4 min, within MERGED_TREE_TIMEOUT_MS).
      const interveningTests = intervening.filter(f => isRunnableTestFile(f) && (!cwd || fs.existsSync(path.join(cwd, f))));
      // BRO-5732: a capped doc changed on main selects no test by name, so run the cap test explicitly.
      if (intervening.some(f => CAPPED_DOCS_RE.test(f)) && (!cwd || fs.existsSync(path.join(cwd, CAPPED_DOCS_TEST))) && !interveningTests.includes(CAPPED_DOCS_TEST)) interveningTests.push(CAPPED_DOCS_TEST);
      const extra = ancestor ? `+${interveningTests.length} test file(s) changed on main since the verified base` : 'tests changed on main unknown: verified base is not an ancestor';
      // Overlap needs the branch's files with renames split too: a branch
      // `git mv a b` plus a main edit to a would otherwise read as disjoint.
      const branchOut = run(['diff', '--name-only', '--no-renames', `${baseSha}...HEAD`], cwd);
      const recheckScope = o.forceFullRecheck
        ? { mode: 'full', build: true, reason: 'the holder alone after a red merge train' }
        : selectRecheckScope({
          ancestor,
          intervening: diffOut === null ? null : intervening,
          changedFiles: branchOut === null ? null : branchOut.split('\n').filter(Boolean),
          disabled: process.env.LAND_SMALL_RECHECK_DISABLED === 'true',
          buildScripts: cwd && o.changedFiles?.some(f => f.startsWith('src/')) && intervening.some(f => f.startsWith('scripts/'))
            ? collectBuildScriptDependencies(cwd) : null,
          // cwd holds the branch rebased onto baseSha: the merged ledger.
          ledgerOk: cwd ? (f) => jsonFileParses(path.join(cwd, f)) : null,
        });
      log(`[land] verified-base: ${decision.reason} — re-checking on the merged tree (${extra}); ${recheckScope.mode} re-check: ${recheckScope.reason}`);
      return checks({ ...o, interveningTests, recheckScope });
    }
    if (prepare && repoDir) {
      // repoDir may be a node_modules-less git worktree (BRO-3907) — prepare
      // (prepareCheckWorkdir by default) resolves the real install root
      // itself now, so every caller gets the fix without having to remember
      // to resolve first. See resolveInstallRoot()'s header in
      // autonomous-checks.js.
      const linked = prepare(cwd, repoDir);
      if (linked.length) log(`[land] linked ${linked.length} gitignored path(s) into the worktree (node_modules/core data)`);
      for (const l of linked) if (l.startsWith('node_modules (')) log(`[land] ${l}`);
    }
    log(`[land] verified-base: ${decision.reason} — reusing the upstream verdict, gauntlet skipped`);
    return [{ name: 'verified-upstream', pass: true, detail: decision.reason }];
  };
}

// ── Defaults for the seams ──────────────────────────────────────────────────

/**
 * The merged-tree floor's stdin: the branch's changed files plus any test
 * files main changed since the verified base (BRO-5180), deduped. The floor
 * runs a changed runnable test file directly, so an intervening guard meets
 * the branch's code.
 */
function mergedTreeGateInput(changedFiles, interveningTests) {
  return [...new Set([...(changedFiles || []), ...(interveningTests || [])].map(String))];
}

/** "safe-checks 4m12s, merged-tree-tests 9m3s" for the in-lock re-check log (BRO-6276). */
function checkTimings({ safeMs, extra = [] }) {
  const fmt = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`; };
  return [`safe-checks ${fmt(safeMs)}`, ...extra.filter(r => Number.isFinite(r.ms)).map(r => `${r.name} ${fmt(r.ms)}`)].join(', ');
}

// recheckScope comes from makeVerifiedBaseChecks (selectRecheckScope) or the
// merge train (selectTrainRecheckScope); a plain land passes none and gets the
// full re-check, and the holder-alone retry after a red train forces full.
// A small re-check whose floor selects no test passes: the branch already ran
// the full gauntlet upstream (land.yml Checks), which is the proof tier 3's
// "no runnable check" refusal would otherwise ask for.
function defaultChecks({ cwd, changedFiles, interveningTests = [], recheckScope = null, baseSha, repoDir, log = () => {} }) {
  const small = Boolean(recheckScope && recheckScope.mode === 'small');
  const files = (changedFiles || []).map(String);
  // Fill the worktree's gitignored gaps (node_modules link, core-data copies)
  // up front, unconditionally: runSafeChecks only prepares when its own plan
  // is non-empty, but the merged-tree floor below and the repo's pre-push
  // hook (which runs from this worktree on push) need them regardless.
  // repoDir may itself be a node_modules-less git worktree (BRO-3907) —
  // prepareCheckWorkdir (called here, and again internally by runSafeChecks
  // below via prepareFrom) resolves the real install root itself, so passing
  // the same repoDir to both is safe and never silently drops the fix.
  const linked = prepareCheckWorkdir(cwd, repoDir);
  if (linked.length) log(`[land] linked ${linked.length} gitignored path(s) into the worktree (node_modules/core data)`);
  // The npm ci outcome (own install, or a FAILED fallback naming its log).
  for (const l of linked) if (l.startsWith('node_modules (')) log(`[land] ${l}`);
  const safeStart = Date.now();
  const results = runSafeChecks({
    cwd,
    changedFiles: files,
    checkableDone: null,
    // No card-authored command on this path, so the validator is never
    // consulted; failing closed keeps the dependency rule (node built-ins +
    // sibling libs only — no executor world pulled into a hand landing).
    isSafeCheckCommand: () => false,
    tier: 3,
    buildCheck: process.env.LAND_SKIP_BUILD !== '1' && (!small || recheckScope.build),
    prepareFrom: repoDir,
  });

  const safeEnd = Date.now();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'land-branch-home-'));
  try {
    const env = checksEnv({ home });
    const extra = [];
    const run = (name, argv, opts = {}) => {
      const startedAt = Date.now();
      try {
        execFileSync(argv[0], argv.slice(1), {
          cwd, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
          timeout: opts.timeoutMs || CHECK_TIMEOUT_MS, env: opts.env || env, input: opts.input,
          // The merged-tree floor emits ~50k TAP lines (>1MB). Node's default
          // 1MB maxBuffer kills the child with ENOBUFS mid-stream, which then
          // reads as a failed check — exactly what refused the first real
          // dry-run of this lib (BRO-3873).
          maxBuffer: CHECK_OUTPUT_MAX_BYTES,
        });
        extra.push({ name, pass: true, ms: Date.now() - startedAt });
      } catch (err) {
        if (err && err.code === 'ENOBUFS') err.stderr = `${err.stderr || ''}\ncheck output exceeded CHECK_OUTPUT_MAX_BYTES (${CHECK_OUTPUT_MAX_BYTES}) — the check was killed, this is NOT a verdict on the code`;
        // Keep the full output: the detail string is a summary, and a merged-
        // tree run is ~50k TAP lines that a 600-char detail cannot explain.
        let logPath = null;
        try {
          logPath = path.join(os.tmpdir(), `land-branch-${name.replace(/[^\w.-]+/g, '_')}-${Date.now()}.log`);
          fs.writeFileSync(logPath, `# ${argv.join(' ')}\n# exit ${err.status}${err.signal ? ` signal ${err.signal}` : ''}\n\n${err.stdout || ''}\n--- stderr ---\n${err.stderr || ''}\n`);
        } catch { logPath = null; }
        extra.push({ name, pass: false, ms: Date.now() - startedAt, detail: `${(opts.detail || defaultDetail)(err)}${logPath ? ` [full output: ${logPath}]` : ''}` });
      }
    };
    // Syntax floor for shell — tier 3's node --check has no shell counterpart.
    for (const f of files.filter(f => /\.sh$/.test(f)).sort()) {
      if (fs.existsSync(path.join(cwd, f))) run(`bash -n ${f}`, ['bash', '-n', f]);
    }
    // lint-workflows proxy: the push-to-main cancellation guard test.yml runs.
    if (files.some(f => f.startsWith('.github/workflows/')) && fs.existsSync(path.join(cwd, 'scripts', 'audit-workflow-concurrency.js'))) {
      run('audit-workflow-concurrency', ['node', 'scripts/audit-workflow-concurrency.js']);
    }
    // Merged-tree test floor (task #1149 / BRO-2785 / BRO-3063): the whole
    // scripts/lib suite, workflow guards, and basename-matched tests/unit
    // tests against the REBASED tree, blocking only on failures new since
    // baseSha. Same gate merge-worktree-to-main.sh runs before its push.
    const gate = path.join(cwd, 'scripts', 'lib', 'merge-post-merge-test-gate.js');
    if (process.env.LAND_SKIP_MERGED_TREE_TESTS !== '1' && fs.existsSync(gate)) {
      run('merged-tree-tests', ['node', 'scripts/lib/merge-post-merge-test-gate.js'], {
        input: `${mergedTreeGateInput(files, interveningTests).join('\n')}\n`,
        timeoutMs: MERGED_TREE_TIMEOUT_MS,
        env: { ...env, MERGE_TEST_GATE_BASELINE_SHA: baseSha || '', ...(small ? { MERGE_TEST_GATE_ONLY_LISTED: '1' } : {}) },
        detail: tapDetail,
      });
    }

    // tier 3's "no runnable check" refusal is right when NOTHING proved the
    // diff; an extra check that actually ran (and passed) is that proof.
    const proven = extra.some(r => r.pass) ;
    const merged = results.filter(r => !(r.name === 'no-checks' && proven)).concat(extra);
    log(`[land] checks: ${merged.length ? merged.map(r => `${r.name}=${r.pass ? 'ok' : 'FAIL'}`).join(', ') : 'none applicable'}`);
    // BRO-6276: the in-lock re-check is the landing queue's throughput cap
    // (14-18 min per train on 2026-10-25); say where the time went.
    log(`[land] check timings: ${checkTimings({ safeMs: safeEnd - safeStart, extra })}`);
    return merged;
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ONE push, nothing else: `git push origin HEAD:main` under the cross-session
// push mutex (scripts/lib/push-mutex.sh — the same lock push-with-retry.sh
// and merge-worktree-to-main.sh take, keyed on the shared git-common-dir so a
// worktree and the main checkout contend on one lock). The repo's pre-push
// hook (scripts/hooks/pre-push) runs as on any push: non-fast-forward guard,
// push audits, tsc on .ts changes. A rejection surfaces as a thrown error the
// caller's bounded loop turns into a re-rebase + re-check.
function defaultPushMain({ cwd, log = () => {} }) {
  const mutex = path.join(__dirname, 'push-mutex.sh');
  const script = [
    'set -euo pipefail',
    `source "$1"`,
    'push_mutex_acquire',
    'trap push_mutex_release EXIT',
    'git push origin HEAD:main',
  ].join('\n');
  log('[land] push: git push origin HEAD:main (push-only, under the push mutex)');
  execFileSync('bash', ['-c', script, '_', mutex], {
    cwd,
    stdio: ['ignore', 'inherit', 'pipe'],
    encoding: 'utf8',
    timeout: GIT_NET_TIMEOUT_MS + Number(process.env.PUSH_LOCK_TIMEOUT_SEC || 900) * 1000,
    // No bypass marker on purpose (BRO-3425): outside CI this push is
    // refused by scripts/hooks/pre-push like any other direct push to main
    // (surfaced as failedCheck 'push' with the hook's message). Sessions
    // land through land/** + land.yml; land.yml runs this lib under
    // GITHUB_ACTIONS, which the hook allows. A local landing that wrote no
    // landings.jsonl row would otherwise read as a bypass to the detector.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

// ── The landing ─────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {string} o.branch        branch to land (local ref, or origin/<branch>)
 * @param {string} [o.repoDir]     the checkout whose object store/remote to use (default: this repo)
 * @param {function} [o.checks]    see SEAMS
 * @param {function} [o.pushMain]  see SEAMS
 * @param {function} [o.beforePush]
 * @param {function} [o.log]
 * @param {number} [o.maxAttempts]
 * @param {'auto'|'local'|'origin'} [o.source]  where the branch tip comes from
 * @param {string} [o.expectSha]   refuse unless the resolved tip IS this sha
 *                                 (land.yml: the tip its checks job verified —
 *                                 a newer push to the branch supersedes this
 *                                 landing rather than landing unverified code)
 * @param {boolean} [o.dryRun]     rebase + checks only, never push
 * @param {Array<{branch:string,tip:string,base?:string|null}>} [o.riders]
 *                                 BRO-5282 merge train: branches queued behind
 *                                 this one, each at the tip ITS checks verified.
 *                                 On attempt 1 only they are rebased after this
 *                                 branch, the combined tree gets ONE re-check
 *                                 (o.trainChecks, never the verified-base skip),
 *                                 and one fast-forward lands them all. A red
 *                                 train falls back to this branch alone. Ignored
 *                                 with beforePush (its amend would hit a rider).
 * @param {string[]} [o.trainBases] the bases the branch and riders were verified
 *                                 at: test files main changed since then feed
 *                                 the merged-tree floor (BRO-5180)
 * @param {string} [o.holderBase] the base this branch's checks verified
 *                                 (--verified-base); a train re-checks small
 *                                 only when every member has one (BRO-6276)
 * @param {function} [o.trainChecks] checks seam for a train (default defaultChecks)
 * @returns {{landed:boolean, sha:string|null, attempts:number, wallMs:number, failedCheck:string|null, reason:string|null, pushed:boolean, files:string[], verified:'LANDED'|'UNKNOWN'|null, contentNote:string|null, baseSha:string|null}}
 */
function landBranch(o) {
  const {
    branch, repoDir = REPO_ROOT, checks = defaultChecks, pushMain = defaultPushMain,
    beforePush = null, log = () => {}, maxAttempts = MAX_ATTEMPTS, maxChurnSkips = MAX_CHURN_SKIPS,
    remote = 'origin', target = 'main', source = 'auto', dryRun = false, expectSha = null,
    riders = [], trainBases = [], holderBase = null, trainChecks = defaultChecks, deadlineMs = landDeadlineMs(), now = Date.now, pushMarkerFile = process.env.LAND_PUSH_MARKER || null,
  } = o || {};
  const t0 = now();
  const trainDropped = []; // BRO-5282: riders not landed by this run, and why
  const done = (patch) => ({
    landed: false, sha: null, attempts: 0, wallMs: now() - t0,
    failedCheck: null, reason: null, pushed: false, files: [], verified: null, contentNote: null,
    baseSha: null, verifiedBase: null, churnSkips: 0, riders: [], trainDropped, ...patch,
  });

  if (!isPlausibleBranchName(branch)) return done({ failedCheck: 'args', reason: `not a usable branch name: ${JSON.stringify(branch)}` });
  if (branch === target) return done({ failedCheck: 'args', reason: `branch is ${target} itself — nothing to land` });

  const git = (args, cwd = repoDir, extra = {}) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_NET_TIMEOUT_MS, ...extra }).trim();
  const gitOrNull = (args, cwd) => { try { return git(args, cwd); } catch { return null; } };

  if (gitOrNull(['check-ref-format', '--branch', branch]) === null) return done({ failedCheck: 'args', reason: `git rejects "${branch}" as a branch name` });

  const targetRef = `${remote}/${target}`;
  git(['fetch', remote, target]);

  // Resolve the tip to land. 'local' = refs/heads/<branch> only; 'origin' =
  // the remote's copy; 'auto' = local if it exists, else origin. The remote
  // case pins the sha via ls-remote and fetches THAT sha — never FETCH_HEAD,
  // which is one shared file per repo that any concurrent session's fetch
  // overwrites between our fetch and our read (adversarial review).
  let sha = null;
  let from = null;
  if (source !== 'origin') {
    sha = gitOrNull(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    if (sha) from = `refs/heads/${branch}`;
  }
  if (!sha && source !== 'local') {
    const line = gitOrNull(['ls-remote', '--exit-code', remote, `refs/heads/${branch}`]);
    const remoteSha = line ? line.split(/\s+/)[0] : null;
    if (!remoteSha || !/^[0-9a-f]{40}$/.test(remoteSha)) return done({ failedCheck: 'resolve', reason: `branch "${branch}" is neither a local branch nor on ${remote}` });
    if (gitOrNull(['cat-file', '-e', `${remoteSha}^{commit}`]) === null && gitOrNull(['fetch', remote, remoteSha]) === null) {
      return done({ failedCheck: 'resolve', reason: `could not fetch ${remoteSha.slice(0, 10)} (${remote}/${branch}) from ${remote}` });
    }
    if (gitOrNull(['cat-file', '-e', `${remoteSha}^{commit}`]) === null) return done({ failedCheck: 'resolve', reason: `${remoteSha.slice(0, 10)} (${remote}/${branch}) is not present after fetch` });
    sha = remoteSha;
    from = `${remote}/${branch}`;
  }
  if (!sha) return done({ failedCheck: 'resolve', reason: `branch "${branch}" not found (${source})` });
  if (expectSha && sha !== expectSha) {
    return done({ failedCheck: 'resolve', reason: `${branch} tip is ${sha.slice(0, 10)} (${from}), not the verified tip ${String(expectSha).slice(0, 10)} — a newer push superseded this landing; nothing pushed` });
  }
  log(`[land] ${branch} @ ${sha.slice(0, 10)} (${from}) → ${targetRef} @ ${git(['rev-parse', targetRef]).slice(0, 10)}`);

  // The tip commit's own files vs origin/main NOW. A difference is a later
  // edit or a revert — not distinguishable from here, so it is a note the
  // caller sees, never a silent "landed".
  const contentNoteFor = (tip) => {
    const touched = (gitOrNull(['diff-tree', '--no-commit-id', '--name-only', '-r', tip]) || '').split('\n').filter(Boolean);
    if (!touched.length) return null;
    const changed = (gitOrNull(['diff', '--name-only', tip, targetRef, '--', ...touched]) || '').split('\n').filter(Boolean);
    return changed.length ? `${changed.length} of the tip commit's ${touched.length} file(s) have since changed on ${targetRef}: ${changed.slice(0, 5).join(', ')}` : null;
  };

  // Idempotent: already on main → nothing to do, nothing to push.
  const already = checkLanded({ sha, branch: target, remote, cwd: repoDir, log });
  if (already.verdict === 'LANDED') {
    const contentNote = contentNoteFor(sha);
    log(`[land] ${sha.slice(0, 10)} is already an ancestor of ${targetRef} — nothing to push${contentNote ? ` (${contentNote})` : ''}`);
    return done({ landed: true, sha, attempts: 0, pushed: false, verified: 'LANDED', contentNote, reason: `already an ancestor of ${targetRef}` });
  }

  // Isolated, detached worktree off the same object store. Detached on
  // purpose: the branch ref itself is never checked out here, so no path
  // through this function can move it.
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-branch-'));
  git(['worktree', 'add', '--detach', workdir, sha]);
  const cleanup = () => {
    gitOrNull(['worktree', 'remove', '--force', workdir]);
    gitOrNull(['worktree', 'prune']);
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  try {
    // Checks are allowed to dirty the throwaway tree (a prebuild regenerates
    // tracked files, tests write data/audit/*.json) and a dirty tree makes
    // any later rebase refuse ("You have unstaged changes") — which is how
    // the first two real landings through this lib were lost, once at the
    // retry and once at the churn re-rebase (BRO-3873). Nothing in this
    // worktree is anyone's work: HEAD is the verified commit, everything
    // else is check residue. Discard it, loudly, before EVERY rebase.
    // Ignored files (node_modules link, core-data copies) are kept.
    const discardResidue = (label) => {
      // The git helper trims, so the first line loses its leading status
      // column — strip the XY code by pattern, not by position.
      const dirty = (gitOrNull(['status', '--porcelain'], workdir) || '').split('\n').filter(Boolean)
        .map(l => l.replace(/^[ MADRCUT?!]{1,2}\s+/, ''));
      if (!dirty.length) return;
      log(`[land] ${label}: discarding ${dirty.length} check-residue path(s) in the throwaway worktree: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}`);
      git(['reset', '-q', '--hard', 'HEAD'], workdir);
      git(['clean', '-fdq'], workdir);
    };

    // Best-effort: read (and so lazily fetch) every blob the rebase picks will
    // need, while nothing rebase-created exists locally. Scoped to the ORIGINAL
    // branch range (`sha`), never the rebased HEAD, whose blobs are local-only.
    // --binary so binary/-diff files load too; --no-renames so a renamed file's
    // old path is listed and main's copy of it is fetched for the merge.
    const quiet = (args, timeout = PREFETCH_TIMEOUT_MS) => {
      try {
        execFileSync('git', args, { cwd: workdir, stdio: ['ignore', 'ignore', 'ignore'], timeout });
        return true;
      } catch { return false; }
    };
    const prefetchForRebase = (onto, tip = sha) => {
      const mb = gitOrNull(['merge-base', onto, tip], workdir);
      if (!mb) return;
      quiet(['log', '-p', '--binary', '--no-textconv', '--no-ext-diff', '--format=', `${mb}..${tip}`]);
      const paths = [...new Set((gitOrNull(['log', '--no-renames', '--format=', '--name-only', `${mb}..${tip}`], workdir) || '')
        .split('\n').filter(Boolean))];
      if (paths.length && paths.length <= PREFETCH_MAX_PATHS) {
        quiet(['diff', '--binary', '--no-textconv', '--no-ext-diff', mb, onto, '--', ...paths]);
      }
    };
    // BRO-6035: while a rebase is stopped on a conflict confined to GENERATED_DOC_PATHS, rebuild the doc with its
    // generator, stage it and continue. True when the rebase then finished; false (rebase left stopped, the caller
    // aborts) on any other conflict or a generator failure.
    const resolveGeneratedDocConflicts = () => {
      let lastErr = null;
      for (let step = 0; step < 50; step++) {
        const files = gitOrNull(['diff', '--name-only', '--diff-filter=U'], workdir);
        if (!isGeneratedDocConflict((files || '').split('\n').filter(Boolean))) return { done: false, lastErr };
        try {
          execFileSync('node', ['scripts/generate-workflow-dependencies.js'], { cwd: workdir, stdio: 'pipe', timeout: 120000 });
          git(['add', '--', ...GENERATED_DOC_PATHS], workdir);
        } catch { return { done: false, lastErr }; }
        try {
          git(['rebase', '--continue'], workdir, { env: { ...process.env, GIT_EDITOR: 'true' } });
          log(`[land] rebase conflict in ${GENERATED_DOC_PATHS.join(', ')} only: regenerated it and continued (BRO-6035)`);
          return { done: true };
        } catch (e) { lastErr = e; /* stopped on the next commit's conflict, or failed: look again */ }
      }
      return { done: false, lastErr };
    };
    // rangeFrom/tip: rebase `rangeFrom..tip` onto `onto` instead of HEAD's own
    // commits (a train rider; HEAD becomes the rebased rider).
    const rebaseOnto = (onto, { rangeFrom = null, tip = null } = {}) => {
      prefetchForRebase(onto, tip || sha);
      for (let retry = 0; ; retry++) {
        try {
          git(rangeFrom ? ['rebase', '--onto', onto, rangeFrom, tip] : ['rebase', onto], workdir);
          return;
        } catch (caught) {
          let err = caught;
          // BRO-6035: a conflict in nothing but the generated DEPENDENCIES.md is regenerated, not refused.
          const fixed = resolveGeneratedDocConflicts();
          if (fixed.done) return;
          // After a resolved stop the failure that matters is the LAST one (a later real conflict, a lazy-fetch failure).
          if (fixed.lastErr) { err = fixed.lastErr; }
          const errText2 = String(err.stderr || err.message || '');
          if (retry >= PROMISOR_REBASE_RETRIES || !isPromisorFetchFailure(errText2)) throw err;
          gitOrNull(['rebase', '--abort'], workdir);
          discardResidue(`promisor retry ${retry + 1}`);
          const gitVersion = gitOrNull(['--version'], workdir) || 'git ?';
          log(`[land] rebase onto ${onto.slice(0, 10)} hit a partial-clone lazy-fetch failure (${gitVersion}) — retry ${retry + 1}/${PROMISOR_REBASE_RETRIES}: ${errText2.split('\n').find(l => /fatal|error/.test(l)) || errText2.slice(0, 200)}`);
        }
      }
    };

    // BRO-5282: rebase each rider's verified range after the current HEAD.
    // A conflict, an empty result or an unfetchable tip drops that rider (it
    // lands on its own turn) and HEAD goes back to exactly where it was.
    let train = [];
    let holderHead = null;
    const assembleTrain = (list, baseSha) => {
      const added = [];
      for (const r of list) {
        const drop = (reason) => { trainDropped.push({ branch: r.branch, reason }); log(`[land] train: ${r.branch} not taken — ${reason}`); };
        if (!r || !/^[0-9a-f]{40}$/.test(String(r.tip || '')) || !isPlausibleBranchName(r.branch)) { drop('malformed rider'); continue; }
        if (gitOrNull(['cat-file', '-e', `${r.tip}^{commit}`], workdir) === null) gitOrNull(['fetch', remote, r.tip], workdir);
        if (gitOrNull(['cat-file', '-e', `${r.tip}^{commit}`], workdir) === null) { drop(`could not fetch ${r.tip.slice(0, 10)}`); continue; }
        const prev = git(['rev-parse', 'HEAD'], workdir);
        const mb = gitOrNull(['merge-base', r.tip, baseSha], workdir);
        if (!mb) { drop('no merge-base with main'); continue; }
        // No Land-Base on the ticket: the merge-base is at or before the base
        // its checks rebased onto, so the intervening-test set only grows.
        const verified = /^[0-9a-f]{40}$/.test(String(r.base || ''));
        const base = verified ? r.base : mb;
        try {
          rebaseOnto(prev, { rangeFrom: mb, tip: r.tip });
        } catch (err) {
          gitOrNull(['rebase', '--abort'], workdir);
          // --abort returns to the rider's tip, not to the train: go back.
          git(['checkout', '-q', '--detach', prev], workdir);
          git(['reset', '-q', '--hard', prev], workdir);
          discardResidue(`train rider ${r.branch} dropped`);
          drop(`would not rebase onto the train: ${String(err.stderr || err.message).split('\n').find((l) => /CONFLICT|error|fatal/.test(l)) || 'rebase failed'}`.slice(0, 200));
          continue;
        }
        const now = git(['rev-parse', 'HEAD'], workdir);
        if (now === prev) { drop('nothing left to land after the rebase (already on main or in the train)'); continue; }
        // BRO-6276: the rider's own rebased files, renames split, for the train scope.
        const filesOut = gitOrNull(['diff', '--name-only', '--no-renames', prev, now], workdir);
        added.push({ ...r, base, verified, files: filesOut === null ? null : filesOut.split('\n').filter(Boolean), count: Number(git(['rev-list', '--count', `${prev}..${now}`], workdir)) });
        log(`[land] train: + ${r.branch} @ ${r.tip.slice(0, 10)} (${added[added.length - 1].count} commit(s))`);
      }
      return added;
    };
    // BRO-5180 for a train: test files main changed since ANY member's verified
    // base (a base that is not an ancestor of main adds nothing).
    const trainInterveningTests = (baseSha, bases) => {
      const set = new Set();
      for (const b of new Set((bases || []).filter((x) => /^[0-9a-f]{40}$/.test(String(x || ''))))) {
        if (gitOrNull(['merge-base', '--is-ancestor', b, baseSha], workdir) === null) continue;
        for (const f of (gitOrNull(['diff', '--name-only', `${b}..${baseSha}`], workdir) || '').split('\n').filter(Boolean)) {
          if (isRunnableTestFile(f) && fs.existsSync(path.join(workdir, f))) set.add(f);
          if (CAPPED_DOCS_RE.test(f) && fs.existsSync(path.join(workdir, CAPPED_DOCS_TEST))) set.add(CAPPED_DOCS_TEST); // BRO-5732
        }
      }
      return [...set];
    };

    // BRO-6276: the holder and each rider as train members for
    // selectTrainRecheckScope; every git failure reads as unknown (full).
    const trainRecheckScope = (baseSha) => {
      const disabled = process.env.LAND_SMALL_RECHECK_DISABLED === 'true' || process.env.LAND_TRAIN_SMALL_RECHECK_DISABLED === 'true';
      if (disabled) return selectTrainRecheckScope({ members: [], disabled });
      const filesOf = (out) => (out === null ? null : out.split('\n').filter(Boolean));
      const member = (name, base, verified, files) => {
        const ancestor = verified && gitOrNull(['merge-base', '--is-ancestor', base, baseSha], workdir) !== null;
        const mainChanged = ancestor ? filesOf(gitOrNull(['diff', '--name-only', '--no-renames', `${base}..${baseSha}`], workdir)) : null;
        return { name, base, verified, ancestor, mainChanged, files };
      };
      const holderVerified = /^[0-9a-f]{40}$/.test(String(holderBase || ''));
      const members = [
        member(branch, holderBase, holderVerified, filesOf(gitOrNull(['diff', '--name-only', '--no-renames', baseSha, holderHead], workdir))),
        ...train.map((r) => member(r.branch, r.base, r.verified === true, r.files)),
      ];
      const all = members.flatMap((m) => m.files || []);
      const mains = members.flatMap((m) => m.mainChanged || []);
      const buildScripts = all.some((f) => f.startsWith('src/')) && [...all, ...mains].some((f) => f.startsWith('scripts/'))
        ? collectBuildScriptDependencies(workdir) : null;
      return selectTrainRecheckScope({ members, buildScripts });
    };

    let lastReason = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const lateBy = deadlineRefusal({ attempt, elapsedMs: now() - t0, deadlineMs });
      if (lateBy) {
        log(`[land] ${lateBy}`);
        return done({ attempts: attempt - 1, failedCheck: 'deadline', reason: `${lateBy} (last: ${lastReason || 'n/a'})`.slice(0, 500) });
      }
      discardResidue(`attempt ${attempt}`);
      git(['fetch', remote, target], workdir);
      // Pin the base: every later step (rebase, diff, moved-check, trailer)
      // uses THIS sha, never the tracking ref another session's fetch may
      // have advanced in the meantime.
      const baseSha = git(['rev-parse', targetRef], workdir);

      try {
        rebaseOnto(baseSha);
      } catch (err) {
        gitOrNull(['rebase', '--abort'], workdir);
        return done({ attempts: attempt, baseSha, failedCheck: 'rebase', reason: `branch would not rebase cleanly onto ${targetRef} @ ${baseSha.slice(0, 10)}: ${String(err.stderr || err.message).slice(0, 300)}` });
      }
      let head = git(['rev-parse', 'HEAD'], workdir);
      if (head === baseSha) {
        // Every commit's patch was already upstream — rebase dropped them all.
        const contentNote = contentNoteFor(sha);
        log(`[land] rebase onto ${targetRef} left nothing to land — the branch's changes are already on ${target}${contentNote ? ` (${contentNote})` : ''}`);
        return done({ landed: true, sha: baseSha, attempts: attempt, baseSha, pushed: false, verified: 'LANDED', contentNote, reason: `rebased to empty — changes already on ${targetRef}` });
      }
      // BRO-5282 merge train, attempt 1 only (a restart re-checks the holder
      // alone, keeping the job inside its timeout).
      holderHead = head;
      const holderCount = Number(git(['rev-list', '--count', `${baseSha}..${holderHead}`], workdir));
      train = [];
      if (attempt === 1 && riders.length && !beforePush && !dryRun) {
        train = assembleTrain(riders, baseSha);
        if (!train.length) log('[land] train: no rider could be added — landing this branch alone');
      }
      let files = git(['diff', '--name-only', `${baseSha}...HEAD`], workdir).split('\n').filter(Boolean);
      log(`[land] attempt ${attempt}/${maxAttempts}: rebased onto ${baseSha.slice(0, 10)}, ${files.length} file(s) changed${train.length ? ` (train: ${branch} + ${train.map((r) => r.branch).join(', ')})` : ''} — running checks`);

      let results;
      if (train.length) {
        const interveningTests = trainInterveningTests(baseSha, [...trainBases, ...train.map((r) => r.base)]);
        log(`[land] train: ONE merged-tree re-check for ${train.length + 1} branch(es) (+${interveningTests.length} test file(s) changed on main since their verified bases)`);
        const recheckScope = trainRecheckScope(baseSha);
        log(`[land] train: ${recheckScope.mode} re-check: ${recheckScope.reason}`);
        results = trainChecks({ cwd: workdir, changedFiles: files, baseSha, repoDir, log, interveningTests, recheckScope }) || [];
        const trainFailed = firstFailedCheck(results);
        if (trainFailed) {
          // Degenerate bisect: the holder alone, exactly as without a train.
          // The riders stay queued and land on their own turn.
          log(`[land] train: ${trainFailed.name} failed on the combined tree — dropping ${train.length} rider(s), re-checking ${branch} alone`);
          for (const r of train) trainDropped.push({ branch: r.branch, reason: `train red (${trainFailed.name})` });
          train = [];
          discardResidue('train red');
          git(['reset', '-q', '--hard', holderHead], workdir);
          files = git(['diff', '--name-only', `${baseSha}...HEAD`], workdir).split('\n').filter(Boolean);
          // A combined tree just tested red: never the small re-check here.
          results = checks({ cwd: workdir, changedFiles: files, baseSha, repoDir, log, forceFullRecheck: true }) || [];
        }
      } else {
        results = checks({ cwd: workdir, changedFiles: files, baseSha, repoDir, log }) || [];
      }
      const failed = firstFailedCheck(results);
      if (failed) {
        return done({ attempts: attempt, baseSha, failedCheck: failed.name, reason: String(failed.detail || 'check failed').slice(0, 500), files });
      }

      if (dryRun) {
        head = git(['rev-parse', 'HEAD'], workdir);
        log(`[land] dry-run: checks green at ${head.slice(0, 10)} — push skipped`);
        return done({ landed: false, dryRun: true, sha: head, attempts: attempt, baseSha, verifiedBase: baseSha, pushed: false, reason: 'dry-run: checks green, push skipped', files });
      }

      // Did origin/main move while the checks ran? A move across INERT
      // paths only (bot data churn) keeps the verdict: re-rebase cleanly and
      // carry on. A substantive move means this tree was verified against a
      // stale base — re-rebase and re-check. Bounded so a firehose of churn
      // cannot spin here forever.
      let landBase = baseSha;
      let churnSkips = 0;
      let restart = false;
      // BRO-3945: a push rejected because main moved across INERT paths only
      // (bot data churn during the 20-50s push) re-enters this loop and keeps
      // the verdict, instead of burning a whole attempt on a full re-check.
      // Shares the churn budget, so a firehose still terminates.
      pushLoop: for (;;) {
      for (;;) {
        git(['fetch', remote, target], workdir);
        const nowBase = git(['rev-parse', targetRef], workdir);
        if (nowBase === landBase) break;
        const intervening = git(['diff', '--name-only', `${landBase}..${nowBase}`], workdir).split('\n').filter(Boolean);
        const kind = classifyIntervening(intervening);
        if (kind !== 'inert' || churnSkips >= maxChurnSkips) {
          lastReason = `${targetRef} moved during checks (${landBase.slice(0, 10)} → ${nowBase.slice(0, 10)}, ${intervening.length} file(s), ${kind}${churnSkips >= maxChurnSkips ? `, churn budget ${maxChurnSkips} spent` : ''})`;
          log(`[land] attempt ${attempt}: ${lastReason}${shouldRetry(attempt, maxAttempts) ? ' — re-rebasing and re-checking' : ''}`);
          restart = true;
          break;
        }
        discardResidue(`attempt ${attempt} (churn re-rebase)`);
        try {
          rebaseOnto(nowBase);
        } catch (err) {
          gitOrNull(['rebase', '--abort'], workdir);
          return done({ attempts: attempt, baseSha: nowBase, verifiedBase: baseSha, failedCheck: 'rebase', reason: `branch would not rebase cleanly onto ${targetRef} @ ${nowBase.slice(0, 10)} (inert churn since ${landBase.slice(0, 10)}): ${String(err.stderr || err.message).slice(0, 300)}`, files });
        }
        churnSkips++;
        if (git(['rev-parse', 'HEAD'], workdir) === nowBase) {
          // The rebase dropped every commit: they are already on main (a
          // push the client saw fail but the server accepted). Same exit as
          // the rebased-to-empty path above; never amend main's own commit.
          const contentNote = contentNoteFor(sha);
          log(`[land] re-rebase onto ${targetRef} left nothing to land — the branch's changes are already on ${target}${contentNote ? ` (${contentNote})` : ''}`);
          return done({ landed: true, sha: nowBase, attempts: attempt, baseSha: nowBase, verifiedBase: baseSha, churnSkips, pushed: false, verified: 'LANDED', contentNote, reason: `rebased to empty — changes already on ${targetRef}` });
        }
        log(`[land] attempt ${attempt}: ${targetRef} moved across ${intervening.length} inert path(s) only (${landBase.slice(0, 10)} → ${nowBase.slice(0, 10)}: ${intervening.slice(0, 3).join(', ')}${intervening.length > 3 ? ', …' : ''}) — verdict kept, rebased without re-checking (${churnSkips}/${maxChurnSkips})`);
        landBase = nowBase;
      }
      if (restart) break pushLoop;

      // Trailers/amends go on the commit that will actually be pushed, with
      // the base it actually sits on (autonomous-merge's Auto-merge-base
      // must be the pushed commit's real parent for revert() to be exact).
      if (beforePush) beforePush({ cwd: workdir, baseSha: landBase, verifiedBase: baseSha, git: (args) => git(args, workdir) });
      head = git(['rev-parse', 'HEAD'], workdir);

      // BRO-6276: land.yml's deadman can kill us between this push and the
      // result file; the marker lets it tell "landed" from "refused".
      if (pushMarkerFile) { try { fs.writeFileSync(pushMarkerFile, `${head}\n`); } catch (_) { /* advisory */ } }
      try {
        pushMain({ cwd: workdir, sha: head, log });
      } catch (err) {
        const errText = String(err.stderr || err.message || '');
        // The LAST line of a rejected push is git's generic trailer ("error:
        // failed to push some refs to …"); the reason is the line(s) above it
        // (`! [remote rejected] … (refusing to allow a Personal Access Token
        // to create or update workflow … without `workflow` scope)`, `!
        // [rejected] … (fetch first)`, a hook's own message). Keep the
        // meaningful tail, hints stripped (2026-09-21: a landing was refused
        // with nothing but the trailer in the report).
        const errLines = errText.split('\n').map(l => l.trim()).filter(l => l && !/^remote:\s*$/.test(l) && !/^hint:/.test(l));
        const errLine = errLines.filter(l => !/^error: failed to push some refs/.test(l)).slice(-3).join(' | ') || errLines.slice(-1)[0] || 'push failed';
        gitOrNull(['fetch', remote, target], workdir);
        const kind = classifyPushFailure({ baseSha: landBase, nowBase: gitOrNull(['rev-parse', targetRef], workdir) });
        if (kind !== 'race') {
          // Not a race: origin/main is where we verified it. Retrying would
          // hit the same wall (hook, auth, network) and misreport it.
          const blocked = /PRE-PUSH BLOCKED/.test(errText) ? 'pre-push hook: ' : '';
          return done({ attempts: attempt, baseSha: landBase, verifiedBase: baseSha, failedCheck: 'push', reason: `${blocked}${errText.match(/=== PRE-PUSH BLOCKED: ([^=]+) ===/)?.[1]?.trim() || errLine}`.slice(0, 500), files });
        }
        lastReason = `push rejected after ${targetRef} moved: ${errLine}`.slice(0, 200);
        const movedTo = gitOrNull(['rev-parse', targetRef], workdir);
        const pushIntervening = movedTo ? git(['diff', '--name-only', `${landBase}..${movedTo}`], workdir).split('\n').filter(Boolean) : [];
        if (classifyIntervening(pushIntervening) === 'inert' && churnSkips < maxChurnSkips) {
          log(`[land] attempt ${attempt}: ${lastReason} — inert churn only, re-rebasing without re-checking`);
          continue pushLoop;
        }
        log(`[land] attempt ${attempt}: ${lastReason}${shouldRetry(attempt, maxAttempts) ? ' — re-rebasing and re-checking' : ''}`);
        restart = true;
        break pushLoop;
      }

      // Prove it, don't assume it. The push seam is push-only, so HEAD is
      // still the verified commit; anything else is a contract violation.
      const headAfter = git(['rev-parse', 'HEAD'], workdir);
      if (headAfter !== head) {
        return done({ attempts: attempt, baseSha: landBase, verifiedBase: baseSha, failedCheck: 'push-contract', reason: `the push step moved HEAD (${head.slice(0, 10)} → ${headAfter.slice(0, 10)}) — a push seam must be push-only; whatever is on ${targetRef} was not what the checks verified`, files });
      }
      git(['fetch', remote, target], workdir);
      const verdict = checkLanded({ sha: head, branch: target, remote, cwd: workdir, log });
      if (verdict.verdict === 'NOT_LANDED') {
        return done({ attempts: attempt, baseSha: landBase, verifiedBase: baseSha, failedCheck: 'landing-verify', reason: `push reported success but ${head.slice(0, 10)} is not an ancestor of ${targetRef}`, files });
      }
      log(`[land] LANDED ${head.slice(0, 10)} on ${targetRef} (attempt ${attempt}, verified at ${baseSha.slice(0, 10)}${landBase !== baseSha ? `, fast-forwarded across inert churn to ${landBase.slice(0, 10)}` : ''}, verify=${verdict.verdict}${verdict.reason ? `: ${verdict.reason}` : ''})`);
      // Train: each branch's own landed commit, by position in landBase..head.
      // A re-rebase that changed the commit count leaves the riders unmarked
      // (their own runs land them: rebased-to-empty) and names the pushed head.
      let ownSha = head;
      let landedRiders = [];
      if (train.length) {
        const commits = git(['rev-list', '--reverse', `${landBase}..${head}`], workdir).split('\n').filter(Boolean);
        const heads = segmentHeads(commits, [holderCount, ...train.map((r) => r.count)]);
        if (heads) {
          ownSha = heads[0];
          landedRiders = train.map((r, i) => ({ branch: r.branch, tip: r.tip, base: r.base || null, runId: r.runId || null, sha: heads[i + 1] }));
        } else {
          log(`[land] train: commit count changed in the re-rebase — riders landed in ${head.slice(0, 10)} but left unmarked; their own runs confirm them`);
          landedRiders = train.map((r) => ({ branch: r.branch, tip: r.tip, base: r.base || null, runId: r.runId || null, sha: null }));
        }
        log(`[land] train: landed ${train.length + 1} branch(es) in one push → ${head.slice(0, 10)}: ${[branch, ...train.map((r) => r.branch)].join(', ')}`);
      }
      return done({
        landed: true, sha: ownSha, pushedSha: head, riders: landedRiders, attempts: attempt, baseSha: landBase, verifiedBase: baseSha, churnSkips, pushed: true, files, verified: verdict.verdict,
        reason: verdict.verdict === 'UNKNOWN' ? `push succeeded; local ancestry check UNKNOWN (${verdict.reason}) — confirm via git ls-remote / the GitHub compare API` : null,
      });
      }
      if (restart) {
        if (train.length) {
          // The retry is the holder alone: take the riders' commits back out
          // of HEAD, or attempt 2's rebase would carry them along unmarked.
          for (const r of train) trainDropped.push({ branch: r.branch, reason: 'main moved substantively: the retry re-checks the holder alone' });
          train = [];
          discardResidue('train restart');
          git(['reset', '-q', '--hard', holderHead], workdir);
        }
        continue;
      }
    }
    return done({
      attempts: maxAttempts, failedCheck: 'race',
      reason: `${targetRef} kept moving — ${maxAttempts} rebase+check+push attempt(s) all lost the race (last: ${lastReason}); refusing rather than rewriting history`,
    });
  } finally {
    cleanup();
  }
}

module.exports = {
  DEFAULT_LAND_DEADLINE_MS, landDeadlineMs, deadlineRefusal,
  checkTimings,
  isPromisorFetchFailure,
  isGeneratedDocConflict, GENERATED_DOC_PATHS,
  PROMISOR_REBASE_RETRIES,
  MAX_ATTEMPTS,
  MAX_CHURN_SKIPS,
  INERT_FOR_VERIFICATION_RE,
  CAPPED_DOCS_RE,
  CAPPED_DOCS_TEST,
  isInertForVerification,
  isBuildCodePath,
  selectRecheckScope,
  selectTrainRecheckScope,
  classifyIntervening,
  isMergeableBothSidesLedger,
  jsonFileParses,
  landBranch,
  defaultChecks,
  decideVerifiedBaseSkip,
  makeVerifiedBaseChecks,
  mergedTreeGateInput,
  defaultPushMain,
  firstFailedCheck,
  classifyPushFailure,
  shouldRetry,
  decideCancelledLandRetry,
  MAX_CANCEL_RETRIES,
  decideCancelledWait,
  CANCEL_GRACE_SEC,
  CANCEL_GRACE_POLL_SEC,
  isPlausibleBranchName,
  formatLandLine,
};
