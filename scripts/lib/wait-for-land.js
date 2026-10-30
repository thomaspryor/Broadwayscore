#!/usr/bin/env node
/**
 * wait-for-land.js — wait for a land/<name> ref to land or be refused (BRO-4671).
 *
 *   node scripts/lib/wait-for-land.js land/<name> [timeout-min] [--prod[=min]]
 *     timeout-min defaults to 60; --prod (default 40 more minutes) also waits
 *     for the landed change to go live on production (BRO-5836).
 *
 * Why: CLOUD.md's landing step used to wait on `git ls-remote` alone. The ref
 * disappears when land.yml lands it, but it STAYS when the run is refused (red
 * Checks, rebase gate), so a ref-only loop noticed a refusal only at its ~60
 * min cap. That cost ~1h twice (BRO-4236 on 2026-09-28, BRO-4619 on
 * 2026-10-05). This checks the ref AND the latest land.yml run for it on every
 * poll, including hand dispatches resolved from Checks logs. A completed
 * cancelled attempt also reads its jobs and Land check annotations once, to distinguish
 * an execution deadline from a queue cancellation (BRO-5131).
 *
 * --prod: main deploys on a 5-min cron behind a content gate, so prod lags a
 * landing by 20-30 min, and a session that stopped at LANDED idled NOT SAFE
 * TO EXIT for two days (BRO-5663). With --prod, the first poll that sees the
 * ref also reads the files the branch itself changes (GitHub's compare API,
 * main...ref, one call: fetching an old ref from a shallow clone can take
 * minutes). If
 * none is a deploy-gate path (should-deploy-gate.js SITE_PATHS), nothing
 * deploys and it stops at LANDED. Otherwise it runs `check-prod-deploy.js
 * <main tip after landing>` every ~5 min (that tip is the landed commit or a
 * descendant, so live means live). It judges the branch's own diff, never a
 * range of main, so another landing in between can't hide or fake a change.
 *
 * Exit codes:
 *   0  landed (the ref is gone); with --prod, landed AND live (or no site change)
 *   1  refused (the land run for the ref's current tip completed red)
 *   2  timed out, still waiting
 *   3  usage error, 5 API/git failures in a row, or a ref that is gone
 *      without a landing (missing with no recent green run: a typo; or
 *      deleted after a red run)
 *   4  --prod only: LANDED, but not live on production by the --prod timeout,
 *      or 3 prod checks in a row could not tell, or main's tip could not be
 *      read. The landing stands: do not push the ref again; re-check with the
 *      command it prints.
 *
 * A queue cancellation (Land cancelled before it did any work) is not a refusal:
 * land-retry-cancelled.yml re-runs it after the next Land completes, so this
 * keeps waiting. Since BRO-5112 queued landings wait in the landing mutex
 * instead of being evicted, so this is rare. Hand dispatches list under main;
 * once Checks completes, its log identifies the land branch and checked tip.
 */

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const { runGhWithFallback, decideLandRetry, MAX_ATTEMPTS } = require('./land-retry-on-cancel');
const { readLatestLandRun } = require('./land-run-identity');
const { SITE_PATHS } = require('./should-deploy-gate');
const { repoDepthArgs } = require('./shallow-fetch-args');

const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
// BRO-6015: past this, a parked run likely means the sweep itself is down.
const PARKED_STUCK_MS = 3 * 60 * 60 * 1000;
const USAGE = 'usage: node scripts/lib/wait-for-land.js land/<name> [timeout-min] [--prod[=min]]';
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);

const RECENT_LANDING_MS = 6 * 3600_000;
const STALE_EVICTION_MS = 30 * 60_000;
const PROD_DEFAULT_MIN = 40;
const PROD_MAX_ERRORS = 3;

// Error messages can contain entire API responses: firstLine bounds them
// (shared with check-prod-deploy.js since BRO-6257).
const { firstLine } = require('./log-lines');
const { LANDINGS_REL, parseLandings, landedShaForTip } = require('./landings-ledger');

// check-prod-deploy prints its verdict last. Preserve that line without
// splitting all of stdout/stderr, and bound unusually long verdicts too.
function lastLine(value) {
  const text = String(value || '').trim();
  const start = text.lastIndexOf('\n') + 1;
  return text.slice(start, start + 500);
}

/**
 * Decide what one poll means. refSha is the ref's current tip (null when the
 * ref is gone); lastSha the tip an earlier poll saw (null if none did); run
 * the latest push or resolved hand-dispatched land.yml run for the ref, or
 * null; nowMs the clock. A run whose head_sha is not the current tip belongs to an older push
 * (the new push's run has not registered yet), so it says nothing about it.
 * "Gone" only counts as landed when nothing contradicts it: a ref deleted
 * after a red run was not landed, and a ref missing from the first poll needs
 * a recent green run (a typo'd or never-pushed name may share an old run).
 */
function landVerdict({ refSha, lastSha = null, run, nowMs }) {
  const ageMs = run && run.updated_at ? nowMs - Date.parse(run.updated_at) : Infinity;
  const cancelledFailure = run && run.conclusion === 'cancelled'
    && ['timeout', 'other'].includes(run.cancellation?.kind);
  if (!refSha) {
    if (lastSha) {
      if (run && run.head_sha === lastSha && run.status === 'completed' && (RED_CONCLUSIONS.has(run.conclusion) || cancelledFailure)) {
        return { verdict: 'unknown', why: `ref deleted but its run ${run.id} was ${run.conclusion}: deleted by hand, not landed` };
      }
      return { verdict: 'landed' };
    }
    if (run && run.conclusion === 'success' && ageMs < RECENT_LANDING_MS) return { verdict: 'landed', before: true };
    return { verdict: 'unknown', why: 'not on origin and no recent green land run for it (typo, or the push never reached origin?)' };
  }
  if (!run) return { verdict: 'waiting', why: 'no land run identified for this ref yet (hand dispatches become identifiable when Checks logs are available)' };
  if (run.identityPending && run.status !== 'completed') return { verdict: 'waiting', why: `run ${run.id} (hand dispatch) ${run.status}, verified tip not readable yet` };
  if (run.head_sha !== refSha) {
    return { verdict: 'waiting', why: `latest run ${run.id} is for an older tip; the run for ${refSha.slice(0, 9)} has not registered yet` };
  }
  if (run.status !== 'completed') return { verdict: 'waiting', why: `run ${run.id} ${run.status}` };
  if (run.conclusion === 'cancelled') {
    if (cancelledFailure) {
      return { verdict: 'refused', why: `run ${run.id} ${run.cancellation.kind === 'timeout' ? 'timed out' : 'cancelled'}: ${run.cancellation.why}` };
    }
    if (run.cancellation?.kind !== 'eviction') return { verdict: 'waiting', why: `run ${run.id} cancelled; retry eligibility unknown` };
    // BRO-6015: a parked run resumes in order when the queue has room. A new
    // land ref or a hand retry only puts the change at the back of the line.
    if (run.cancellation.why === 'land-parked-behind-deep-queue') {
      if (ageMs > PARKED_STUCK_MS) return { verdict: 'waiting', why: `run ${run.id} parked 3+ h; if the Land retry sweep is not running, resume it with node scripts/land-retry-cancelled.js --run=${run.id} (it waits for queue room). Do not push a new land ref` };
      return { verdict: 'waiting', why: `run ${run.id} parked in the landing line (queue full); the sweep resumes it in order. Keep waiting: do not push a new land ref or retry by hand` };
    }
    const retry = `node scripts/land-retry-cancelled.js --run=${run.id}`;
    // BRO-6031: say which case this is instead of guessing. The sweep stops
    // re-running a run once its attempt count reaches MAX_ATTEMPTS.
    const attempt = run.run_attempt || 1;
    if (attempt >= MAX_ATTEMPTS) return { verdict: 'waiting', why: `run ${run.id} cancelled on attempt ${attempt} of ${MAX_ATTEMPTS}: retries spent, neither the sweep nor a hand retry will re-run it. Push a new commit to the land ref (merge origin/main) to start a fresh run` };
    if (ageMs > STALE_EVICTION_MS) return { verdict: 'waiting', why: `run ${run.id} cancelled 30+ min ago and not re-run yet (attempt ${attempt} of ${MAX_ATTEMPTS}; is the Land retry sweep running?): ${retry}` };
    return { verdict: 'waiting', why: `run ${run.id} cancelled before landing (attempt ${attempt} of ${MAX_ATTEMPTS}); the sweep will re-run it, or: ${retry}` };
  }
  if (RED_CONCLUSIONS.has(run.conclusion)) return { verdict: 'refused', why: `run ${run.id} ${run.conclusion}` };
  return { verdict: 'waiting', why: `run ${run.id} ${run.conclusion}, ref not deleted yet` };
}

/**
 * Decide whether --prod has to watch production at all. mainSha is
 * origin/main's tip after LANDED (null when it could not be read); siteFiles
 * the deploy-gate paths the land branch itself changes, or null when unknown
 * (the ref was never seen, or its diff failed). Unknown waits: a wasted wait
 * beats a false "nothing to deploy".
 */
function prodPlan({ mainSha, siteFiles }) {
  if (!mainSha) return { watch: false, why: 'could not read origin/main after landing' };
  if (!Array.isArray(siteFiles)) return { watch: true, why: "the branch's own changes are unknown" };
  if (siteFiles.length === 0) return { watch: false, nothingToDeploy: true, why: 'the branch changes no deploy-gate path, so nothing deploys' };
  return { watch: true, why: `${siteFiles.length} deploy-gate path(s) changed, e.g. ${siteFiles[0]}` };
}

/**
 * One check-prod-deploy.js poll: exit 0 live, 1 not yet, anything else could
 * not tell. errors counts the can't-tell results in a row, this one included.
 */
function prodVerdict({ checkExit, errors, nowMs, deadlineMs }) {
  if (checkExit === 0) return { verdict: 'live' };
  if (checkExit !== 1 && errors >= PROD_MAX_ERRORS) return { verdict: 'gave-up', why: `${errors} prod checks in a row could not tell (exit ${checkExit})` };
  if (nowMs >= deadlineMs) return { verdict: 'gave-up', why: 'not live by the --prod timeout' };
  return { verdict: 'waiting', why: checkExit === 1 ? 'not live yet' : `prod check could not tell (exit ${checkExit})` };
}

function parseArgs(argv) {
  let prodMin = null;
  const rest = [];
  for (const a of argv) {
    if (a === '--prod') prodMin = PROD_DEFAULT_MIN;
    else if (a.startsWith('--prod=')) {
      if (!/^[1-9]\d*$/.test(a.slice(7))) return null;
      prodMin = Number(a.slice(7));
    } else rest.push(a);
  }
  const [ref, timeoutArg = '60', extra] = rest;
  if (extra !== undefined) return null;
  if (!ref || !/^land\/[\w./-]+$/.test(ref)) return null;
  if (!/^[1-9]\d*$/.test(timeoutArg)) return null;
  return { ref, timeoutMin: Number(timeoutArg), prodMin };
}

function readRefSha(ref) {
  const out = execFileSync('git', ['ls-remote', 'origin', `refs/heads/${ref}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return /^\S+/.exec(out.trim())?.[0] || null;
}

const cancellationCache = new Map();
const readGhJson = (endpoint) => JSON.parse(runGhWithFallback(
  [endpoint], { exec: execFileSync, fallbackToken: process.env.GH_FALLBACK_TOKEN },
));

const readGhText = (endpoint) => runGhWithFallback(
  [endpoint], { exec: execFileSync, fallbackToken: process.env.GH_FALLBACK_TOKEN },
);

function readLatestRun(ref, { read = readGhJson, readText = readGhText, cache = cancellationCache } = {}) {
  const r = readLatestLandRun(ref, { repo, read, readText, cache });
  if (!r) return null;
  let cancellation;
  if (r.status === 'completed' && r.conclusion === 'cancelled') {
    const key = `${r.id}:${r.run_attempt}:${r.updated_at}`;
    cancellation = cache.get(key);
    if (!cancellation) {
      // Use this attempt's jobs: a re-run must not inherit a prior timeout.
      const jobs = read(`repos/${repo}/actions/runs/${r.id}/attempts/${r.run_attempt}/jobs?per_page=50`).jobs;
      if (!Array.isArray(jobs)) throw new Error(`run ${r.id}: unreadable jobs`);
      const land = jobs.find((j) => j.name === 'Land');
      let timedOut = land?.conclusion === 'timed_out';
      if (land?.conclusion === 'cancelled') {
        // GitHub reports a job deadline as "cancelled", even at job level.
        // The runner's annotation is definitive; duration alone is not.
        const annotations = read(`repos/${repo}/check-runs/${land.id}/annotations?per_page=100`);
        if (!Array.isArray(annotations)) throw new Error(`run ${r.id}: unreadable Land annotations`);
        timedOut = annotations.some((a) => /^The job has exceeded the maximum execution time of /.test(a.message || ''));
      }
      const retry = decideLandRetry({ run: r, jobs, branchExists: true, branchTip: r.head_sha });
      cancellation = timedOut
        ? { kind: 'timeout', why: 'Land job exceeded its execution time limit; inspect the run before retrying' }
        : { kind: retry.retry ? 'eviction' : 'other', why: retry.reason };
      cache.set(key, cancellation);
    }
  }
  return { id: r.id, head_sha: r.head_sha, identityPending: r.identityPending, status: r.status, conclusion: r.conclusion, updated_at: r.updated_at, url: r.html_url, cancellation };
}

function remoteSha(ref) {
  try {
    return readRefSha(ref);
  } catch {
    return null;
  }
}

// Fetch main (depth-bounded) so its tip is local: a shallow clone needs the
// object for check-prod-deploy.js's `git rev-parse`.
function fetchMain() {
  try {
    const depthArgs = repoDepthArgs({ repoRoot: process.cwd() });
    // unbounded-fetch-ok: depthArgs IS the bound; the lint can't evaluate a spread.
    execFileSync('git', ['fetch', '-q', ...depthArgs, 'origin', 'main'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
    return true;
  } catch (err) {
    console.error(`${stamp()} could not fetch origin/main: ${firstLine(err.message || err)}`);
    return false;
  }
}

// The compare API lists at most 300 files; a list that long may be cut.
const COMPARE_FILE_CAP = 300;

/**
 * Which of a branch's changed files are deploy-gate paths, or null when the
 * list may be incomplete. SITE_PATHS entries ending in / are directories,
 * the rest exact files, as git pathspecs read them in should-deploy-gate.js.
 */
function sitePathsIn(files) {
  if (!Array.isArray(files) || files.length >= COMPARE_FILE_CAP) return null;
  return files.filter((f) => SITE_PATHS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
}

// Deploy-gate paths the land branch at refSha changes against main, or null.
function branchSiteFiles(refSha) {
  try {
    const raw = runGhWithFallback([`repos/${repo}/compare/main...${refSha}`], { exec: execFileSync, fallbackToken: process.env.GH_FALLBACK_TOKEN });
    const files = JSON.parse(raw).files;
    return sitePathsIn(Array.isArray(files) ? files.map((f) => f.filename) : null);
  } catch (err) {
    console.error(`${stamp()} could not list the branch's changes: ${firstLine(err.message || err)}`);
    return null;
  }
}

const CHECK_PROD = path.join(__dirname, '..', 'check-prod-deploy.js');

async function waitForProd({ siteFiles, prodMin }) {
  const postSha = remoteSha('main');
  const plan = prodPlan({ mainSha: postSha && fetchMain() ? postSha : null, siteFiles });
  if (!plan.watch) {
    if (plan.nothingToDeploy) {
      console.log(`${stamp()} PROD: nothing to deploy (${plan.why}); done once landed`);
      return 0;
    }
    console.log(`${stamp()} PROD UNCHECKED: ${plan.why}. The landing stands; check by hand: node scripts/check-prod-deploy.js origin/main`);
    return 4;
  }
  const recheck = `node scripts/check-prod-deploy.js ${postSha}`;
  console.log(`${stamp()} PROD: waiting up to ${prodMin} min for ${postSha.slice(0, 9)} to go live (${plan.why})`);
  const deadlineMs = Date.now() + prodMin * 60_000;
  let errors = 0;
  let lastStatusLine = '';
  for (;;) {
    const res = spawnSync(process.execPath, [CHECK_PROD, postSha], { encoding: 'utf8', timeout: 180_000 });
    const checkExit = res.status === null ? -1 : res.status;
    errors = checkExit === 0 || checkExit === 1 ? 0 : errors + 1;
    const v = prodVerdict({ checkExit, errors, nowMs: Date.now(), deadlineMs });
    const detail = lastLine(res.stdout) || lastLine(res.stderr);
    if (v.verdict === 'live') {
      console.log(`${stamp()} LIVE: ${detail}`);
      return 0;
    }
    if (v.verdict === 'gave-up') {
      console.log(`${stamp()} LANDED, NOT LIVE YET: ${v.why} (${detail}). The landing stands, do not push the ref again. Re-check: ${recheck}`);
      return 4;
    }
    const line = `prod: ${v.why}: ${detail}`;
    if (line !== lastStatusLine) console.log(`${stamp()} ${line}`);
    lastStatusLine = line;
    // ~5 min apart: each no-token check costs ~25 GitHub REST calls.
    await sleep(Math.min(270_000 + Math.floor(Math.random() * 60_000), Math.max(0, deadlineMs - Date.now())));
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const stamp = () => new Date().toISOString().slice(11, 19) + 'Z';

const COMMIT_URL = 'https://github.com/thomaspryor/Broadwayscore/commit/';

// origin/main's landings.jsonl is over 1 MiB (execFileSync's default buffer).
function mainLandingsRows() {
  const text = execFileSync('git', ['show', `origin/main:${LANDINGS_REL}`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
  return parseLandings(text);
}

// BRO-6638: print the sha the tip became on main. Read-only and never fatal:
// a landing's exit code does not depend on it. The row rides land.yml's
// ledger commit, which follows the ref delete, so the first look often
// misses it; retry 60s apart within budgetMs (default 150s; a wrapper such as
// the Codex runner reserves only minutes for wrap-up), then say where to look.
// io is injectable for tests.
async function reportLandedSha(tip, { budgetMs = 150_000, io = {} } = {}) {
  if (!tip) return null;
  const { fetch = fetchMain, rows = mainLandingsRows, wait = sleep, now = Date.now } = io;
  const endMs = now() + budgetMs;
  for (;;) {
    try {
      if (!fetch()) break;
      const sha = landedShaForTip(rows(), tip);
      if (sha) {
        console.log(`${stamp()} ON MAIN AS: ${sha} (${COMMIT_URL}${sha}). land.yml rebases, so branch tip ${tip.slice(0, 9)} never becomes an ancestor of main; check ${sha.slice(0, 9)}.`);
        return sha;
      }
    } catch (err) {
      console.error(`${stamp()} could not read ${LANDINGS_REL} on main (${firstLine(err.message || err)}); find the landed sha by "tip":"${tip}" there.`);
      return null;
    }
    if (now() + 60_000 > endMs) break;
    await wait(60_000);
  }
  console.log(`${stamp()} ON MAIN AS: not recorded yet. land.yml rebases, so branch tip ${tip.slice(0, 9)} is never on main; find the landed sha later by "tip":"${tip}" in ${LANDINGS_REL} (train riders get no row).`);
  return null;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    console.error(USAGE);
    return 3;
  }
  const deadline = Date.now() + args.timeoutMin * 60_000;
  let siteFiles = null;
  let errors = 0;
  let lastLine = '';
  let lastSha = null;
  for (;;) {
    let v;
    let run = null;
    try {
      const refSha = readRefSha(args.ref);
      // Remember the tip before the API call: if that call fails and the ref
      // lands before the next good poll, it must still read as landed.
      if (refSha) {
        if (args.prodMin && refSha !== lastSha) siteFiles = branchSiteFiles(refSha);
        lastSha = refSha;
      }
      run = readLatestRun(args.ref);
      v = landVerdict({ refSha, lastSha, run, nowMs: Date.now() });
      errors = 0;
    } catch (err) {
      errors += 1;
      console.error(`${stamp()} poll failed (${errors}/5): ${firstLine(err.message || err)}`);
      if (errors >= 5) return 3;
    }
    if (v) {
      if (v.verdict === 'landed') {
        const before = v.before ? ` before this wait started; its last land run ${run.id} ${run.conclusion}` : '';
        console.log(`${stamp()} LANDED: ${args.ref} is gone from origin${before} (land.yml deletes it after the fast-forward)`);
        const tip = v.before ? (run && run.head_sha) || null : lastSha;
        if (!args.prodMin) {
          await reportLandedSha(tip);
          return 0;
        }
        // After the prod wait the ledger row has usually landed, so the
        // first look (after a fresh fetch) tends to hit.
        const code = await waitForProd({ siteFiles: v.before ? null : siteFiles, prodMin: args.prodMin });
        await reportLandedSha(tip);
        return code;
      }
      if (v.verdict === 'unknown') {
        console.error(`${stamp()} UNKNOWN: ${args.ref} ${v.why}`);
        return 3;
      }
      if (v.verdict === 'refused') {
        console.log(`${stamp()} REFUSED: ${args.ref} ${v.why}${run && run.url ? ` ${run.url}` : ''}`);
        return 1;
      }
      const line = `waiting: ${v.why}`;
      if (line !== lastLine) console.log(`${stamp()} ${line}`);
      lastLine = line;
    }
    if (Date.now() >= deadline) {
      console.log(`${stamp()} TIMEOUT after ${args.timeoutMin} min: ${args.ref} still on origin (${lastLine || 'no successful poll'})`);
      return 2;
    }
    await sleep(60_000 + Math.floor(Math.random() * 30_000));
  }
}

if (require.main === module) {
  // Exit 1 means "refused", so an unexpected crash must not reuse it.
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`wait-for-land crashed: ${err && err.stack ? err.stack : err}`);
      process.exit(3);
    },
  );
}

module.exports = { reportLandedSha, landVerdict, readLatestRun, waitForProd, prodPlan, prodVerdict, parseArgs, sitePathsIn, firstLine, lastLine, RED_CONCLUSIONS };
