'use strict';

/**
 * headless-unlanded-detection — BRO-3424: a headless job whose claude-cli
 * process exits 0 gets journaled job-done (success) by bsc-runner.js
 * regardless of whether its work actually reached origin/main. A session
 * that ends its turn with "THIS SESSION: KEEP OPEN — waiting on CI" (or is
 * killed/crashes right after its own merge step) leaves commits sitting on
 * its job worktree branch forever, invisible to every supervisor that reads
 * job-done as "handled" — audit-headless-outcome-rate.js's success rate,
 * dispatch-watchdog's open-task tracking. reconcile-landed-but-open.js
 * catches the OPPOSITE case (landed, but the Linear card is still open);
 * nothing caught "reported done but never landed" until this.
 *
 * Reuses checkLanded()/isAncestor() from landing-verify.js — already the
 * canonical "did it land" ancestry check this repo uses for
 * merge-worktree-to-main.sh, check-prod-deploy.js and the pre-push hook —
 * rather than inventing a second landed-detection heuristic. merge-worktree-
 * to-main.sh always integrates with `git merge` (never squash/rebase —
 * verified against the script 2026-09-15), so a landed job's original commit
 * SHAs remain real ancestors of origin/main, which is what an ancestry check
 * needs to be trustworthy here.
 *
 * WHY job.cwd, NOT a branch name derived from jobId: a resumed job
 * (bsc-reconcile.js / resume-headless-job.js call runJob with isolate:false
 * and the ORIGINAL job's worktree as cwd) mints a brand-new jobId but reuses
 * the OLD job's worktree/branch. Deriving the branch name from the CURRENT
 * jobId would silently miss every resumed job — exactly the highest-risk
 * case (a job that already needed a resume once). dispatch-ledger.js's
 * foldJobs() spreads job-spawned's `cwd` forward into the folded record
 * (job-done carries no cwd of its own), so reading HEAD out of THAT cwd is
 * correct for both a fresh isolated worktree and a reused resume worktree —
 * no branch-name convention to keep in sync with bsc-runner.js at all.
 *
 * The pure classifier (classifyJobDoneLanding) is kept separate from the git
 * I/O (detectJobLanding/findUnlandedJobDoneEntries) per CLAUDE.md rule 15.
 * Never claims 'unlanded' on an inconclusive check (missing worktree,
 * unresolvable HEAD, shallow-graft UNKNOWN) — same fail-safe-toward-
 * not-unlanded direction as checkLanded's own UNKNOWN verdict and
 * reconcile-landed-but-open.js's "absence of evidence is not additive"
 * doctrine.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { checkLanded } = require('./landing-verify.js');
const { JOB_EVENTS, foldJobs } = require('./dispatch-ledger.js');
const { parseLandings, findLanding } = require('./landings-ledger.js');

/**
 * BRO-3873 step 4: sessions now land via land/** + land.yml, which REBASES
 * the branch before its fast-forward push — the job worktree's HEAD sha is
 * then NOT an ancestor of origin/main even though every patch is. Ancestry
 * alone would call every such landing 'unlanded'. Two rebase-proof signals
 * override a NOT_LANDED ancestry verdict, in this order:
 *   1. a data/audit/landings.jsonl row whose `tip` is the job's HEAD (land.yml
 *      writes it after verifying ancestry of the REBASED sha),
 *   2. `git cherry origin/main <sha>` listing no `+` line (every commit's
 *      patch-id is already upstream).
 * Pure; the git/ledger reads happen in detectJobLanding().
 * @param {object} o
 * @param {'LANDED'|'NOT_LANDED'|'UNKNOWN'|null} o.ancestryVerdict
 * @param {string|null} o.sha
 * @param {object[]} [o.landings]   parsed landings.jsonl rows
 * @param {boolean|null} [o.cherryPlus]  true = some patch missing upstream, false = none missing, null = check unavailable
 * @returns {{verdict:'LANDED'|'NOT_LANDED'|'UNKNOWN'|null, reason:string|null}}
 */
function resolveLandedVerdict({ ancestryVerdict, sha, landings = [], cherryPlus = null }) {
  if (ancestryVerdict !== 'NOT_LANDED') return { verdict: ancestryVerdict, reason: null };
  if (sha && findLanding(landings, { tip: sha })) return { verdict: 'LANDED', reason: 'landings.jsonl:tip' };
  if (cherryPlus === false) return { verdict: 'LANDED', reason: 'patch-equivalent' };
  return { verdict: 'NOT_LANDED', reason: null };
}

function readOriginLandings(cwd) {
  // origin/main's copy first (fresh after the fetch the caller did), then the
  // canonical checkout's working copy as a fallback.
  try {
    return parseLandings(execFileSync('git', ['-C', cwd, 'show', 'origin/main:data/audit/landings.jsonl'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { /* fall through */ }
  try {
    const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const root = path.isAbsolute(common) ? path.dirname(common) : path.resolve(cwd, common, '..');
    return parseLandings(fs.readFileSync(path.join(root, 'data', 'audit', 'landings.jsonl'), 'utf8'));
  } catch { return []; }
}

function cherryPlusFor(cwd, sha) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'cherry', 'origin/main', sha], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // EMPTY output is no evidence, not equivalence: `git cherry` skips merge
    // commits, so a merge-only branch (conflict resolutions live in the
    // merge itself) lists nothing whether or not it landed (Codex finding).
    if (!out.trim()) return null;
    return /^\+/m.test(out);
  } catch { return null; }
}

/**
 * Pure: given what we know about a job-done job's worktree, decide whether
 * its work landed.
 * @param {object} opts
 * @param {boolean} opts.cwdExists
 * @param {'LANDED'|'NOT_LANDED'|'UNKNOWN'|null} opts.landedVerdict
 * @param {boolean} [opts.dirty] uncommitted changes sitting in the worktree
 * @returns {'landed'|'unlanded'|'unknown'}
 */
function classifyJobDoneLanding({ cwdExists, landedVerdict, dirty = false }) {
  if (!cwdExists) return 'unknown'; // worktree already gone — cannot check, never claim unlanded on nothing
  // A dirty worktree means real, uncommitted work is sitting there — that is
  // never "landed" regardless of what HEAD's own ancestry says (ship-check
  // catch: a "THIS SESSION: KEEP OPEN" job that edited files but committed
  // nothing would otherwise read as trivially landed, since HEAD never moved
  // off origin/main). bsc-runner.js's teardownJobWorktree already treats
  // `dirty` as reason enough to keep the worktree around — same signal here.
  if (dirty) return 'unlanded';
  if (landedVerdict === 'LANDED') return 'landed';
  if (landedVerdict === 'NOT_LANDED') return 'unlanded';
  return 'unknown'; // UNKNOWN (shallow/ancestor-check-error/no HEAD) — never a definitive unlanded verdict
}

/**
 * I/O: resolve a job's worktree HEAD and check its ancestry against
 * origin/main. `cwd` should be the job's OWN folded-ledger cwd (see header —
 * this is what makes resumed jobs resolve correctly).
 * @param {object} opts
 * @param {string} opts.cwd
 * @returns {{status:'landed'|'unlanded'|'unknown', sha:string|null, verdict:string|null, dirty:boolean}}
 */
function detectJobLanding({ cwd } = {}) {
  if (!cwd || !fs.existsSync(cwd)) {
    return { status: classifyJobDoneLanding({ cwdExists: false, landedVerdict: null }), sha: null, verdict: null, dirty: false };
  }
  let dirty = false;
  try {
    const porcelain = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    dirty = porcelain.trim().length > 0;
  } catch { dirty = false; }
  let sha = null;
  try {
    sha = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { sha = null; }
  if (!sha) {
    return { status: classifyJobDoneLanding({ cwdExists: true, landedVerdict: null, dirty }), sha: null, verdict: null, dirty };
  }
  const ancestry = checkLanded({ sha, cwd, ref: 'origin/main' });
  const { verdict } = ancestry.verdict === 'NOT_LANDED'
    ? resolveLandedVerdict({ ancestryVerdict: ancestry.verdict, sha, landings: readOriginLandings(cwd), cherryPlus: cherryPlusFor(cwd, sha) })
    : ancestry;
  return { status: classifyJobDoneLanding({ cwdExists: true, landedVerdict: verdict, dirty }), sha, verdict, dirty };
}

/**
 * Scan the dispatch ledger for jobs whose LATEST event is job-done but whose
 * work never reached origin/main. One git check per distinct job-done job
 * (not per ledger row) — foldJobs collapses each jobId to its latest event
 * first.
 * @param {object[]} entries dispatch-ledger rows
 * @param {object} [opts]
 * @param {number} [opts.sinceMs] only consider job-done jobs whose own event
 *   ts is at/after this epoch ms. Unbounded by default. A live caller that
 *   re-runs this every sweep should pass a recent cutoff — the ledger
 *   accumulates every job-done ever recorded, and most of their worktrees
 *   are long gone (fast fs.existsSync-false, but still O(all-time jobs)
 *   without a window).
 * @param {string} [opts.mainRepoCwd] never run an ancestry check against this
 *   path. bsc-runner.js's runJob() only records `cwd: REPO` (the shared main
 *   checkout, not a per-job worktree) when isolate:false AND the caller omits
 *   its own `cwd` — today's two isolate:false callers (bsc-reconcile.js,
 *   resume-headless-job.js) always pass one, so this path is currently dead,
 *   but a future caller regressing it must never turn into live git ancestry
 *   checks against the machine's shared checkout, nor a narrative line
 *   telling the owner to "check git log" in their own main repo (ship-check
 *   catch).
 * @returns {Array<{taskId:string, jobId:string, cwd:string, sessionId:string|null, sha:string|null, verdict:string|null}>}
 */
function findUnlandedJobDoneEntries(entries, { sinceMs = null, mainRepoCwd = null } = {}) {
  const out = [];
  for (const job of foldJobs(entries || []).values()) {
    if (!job || job.event !== JOB_EVENTS.DONE || job.taskId == null) continue;
    if (sinceMs != null) {
      const ms = Date.parse(job.ts || '');
      if (!Number.isFinite(ms) || ms < sinceMs) continue;
    }
    if (!job.cwd) continue; // no recorded cwd — cannot check, never false-positive
    if (mainRepoCwd && job.cwd === mainRepoCwd) continue; // never the shared checkout
    const landing = detectJobLanding({ cwd: job.cwd });
    if (landing.status === 'unlanded') {
      out.push({
        taskId: String(job.taskId), jobId: job.jobId, cwd: job.cwd,
        sessionId: job.sessionId || null, sha: landing.sha, verdict: landing.verdict,
      });
    }
  }
  return out;
}

module.exports = {
  classifyJobDoneLanding,
  resolveLandedVerdict,
  detectJobLanding,
  findUnlandedJobDoneEntries,
};
