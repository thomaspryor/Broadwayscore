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
 * 2026-10-05). This checks the ref AND the latest push-triggered land.yml run
 * for it on every poll, one REST call per ~60-90s.
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
 * A cancelled run (Land cancelled before it did any work) is not a refusal:
 * land-retry-cancelled.yml re-runs it after the next Land completes, so this
 * keeps waiting. Since BRO-5112 queued landings wait in the landing mutex
 * instead of being evicted, so this is rare. A run dispatched by hand (`land.yml` with branch=land/<name>)
 * is listed under head_branch=main and is invisible here; for those the ref
 * check still reports the landing, and a refusal surfaces only at the timeout.
 */

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const { runGhWithFallback } = require('./land-retry-on-cancel');
const { SITE_PATHS } = require('./should-deploy-gate');
const { repoDepthArgs } = require('./shallow-fetch-args');

const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
const USAGE = 'usage: node scripts/lib/wait-for-land.js land/<name> [timeout-min] [--prod[=min]]';
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);

const RECENT_LANDING_MS = 6 * 3600_000;
const STALE_EVICTION_MS = 30 * 60_000;
const PROD_DEFAULT_MIN = 40;
const PROD_MAX_ERRORS = 3;

/**
 * Decide what one poll means. refSha is the ref's current tip (null when the
 * ref is gone); lastSha the tip an earlier poll saw (null if none did); run
 * the latest push-triggered land.yml run for the ref, or null; nowMs the
 * clock. A run whose head_sha is not the current tip belongs to an older push
 * (the new push's run has not registered yet), so it says nothing about it.
 * "Gone" only counts as landed when nothing contradicts it: a ref deleted
 * after a red run was not landed, and a ref missing from the first poll needs
 * a recent green run (a typo'd or never-pushed name may share an old run).
 */
function landVerdict({ refSha, lastSha = null, run, nowMs }) {
  const ageMs = run && run.updated_at ? nowMs - Date.parse(run.updated_at) : Infinity;
  if (!refSha) {
    if (lastSha) {
      if (run && run.head_sha === lastSha && run.status === 'completed' && RED_CONCLUSIONS.has(run.conclusion)) {
        return { verdict: 'unknown', why: `ref deleted but its run ${run.id} was ${run.conclusion}: deleted by hand, not landed` };
      }
      return { verdict: 'landed' };
    }
    if (run && run.conclusion === 'success' && ageMs < RECENT_LANDING_MS) return { verdict: 'landed', before: true };
    return { verdict: 'unknown', why: 'not on origin and no recent green land run for it (typo, or the push never reached origin?)' };
  }
  if (!run) return { verdict: 'waiting', why: 'no push-triggered land run for this ref yet (a [skip ci] tip or a hand-dispatched run never shows here)' };
  if (run.head_sha !== refSha) {
    return { verdict: 'waiting', why: `latest run ${run.id} is for an older tip; the run for ${refSha.slice(0, 9)} has not registered yet` };
  }
  if (run.status !== 'completed') return { verdict: 'waiting', why: `run ${run.id} ${run.status}` };
  if (run.conclusion === 'cancelled') {
    const retry = `node scripts/land-retry-cancelled.js --run=${run.id}`;
    if (ageMs > STALE_EVICTION_MS) return { verdict: 'waiting', why: `run ${run.id} cancelled 30+ min ago and not re-run (retries spent?): ${retry}` };
    return { verdict: 'waiting', why: `run ${run.id} cancelled (cancelled before landing; the sweep re-runs it, or: ${retry})` };
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
  return out.trim().split(/\s+/)[0] || null;
}

function readLatestRun(ref) {
  const raw = runGhWithFallback(
    [`repos/${repo}/actions/workflows/land.yml/runs?branch=${encodeURIComponent(ref)}&event=push&per_page=1`],
    { exec: execFileSync, fallbackToken: process.env.GH_FALLBACK_TOKEN },
  );
  const r = JSON.parse(raw).workflow_runs?.[0];
  return r ? { id: r.id, head_sha: r.head_sha, status: r.status, conclusion: r.conclusion, updated_at: r.updated_at, url: r.html_url } : null;
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
    console.error(`${stamp()} could not fetch origin/main: ${String(err.message || err).split('\n')[0]}`);
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
    console.error(`${stamp()} could not list the branch's changes: ${String(err.message || err).split('\n')[0]}`);
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
  let lastLine = '';
  for (;;) {
    const res = spawnSync(process.execPath, [CHECK_PROD, postSha], { encoding: 'utf8', timeout: 180_000 });
    const checkExit = res.status === null ? -1 : res.status;
    errors = checkExit === 0 || checkExit === 1 ? 0 : errors + 1;
    const v = prodVerdict({ checkExit, errors, nowMs: Date.now(), deadlineMs });
    const detail = String(res.stdout || '').trim().split('\n').pop() || String(res.stderr || '').trim().split('\n').pop() || '';
    if (v.verdict === 'live') {
      console.log(`${stamp()} LIVE: ${detail}`);
      return 0;
    }
    if (v.verdict === 'gave-up') {
      console.log(`${stamp()} LANDED, NOT LIVE YET: ${v.why} (${detail}). The landing stands, do not push the ref again. Re-check: ${recheck}`);
      return 4;
    }
    const line = `prod: ${v.why}: ${detail}`;
    if (line !== lastLine) console.log(`${stamp()} ${line}`);
    lastLine = line;
    // ~5 min apart: each no-token check costs ~25 GitHub REST calls.
    await sleep(Math.min(270_000 + Math.floor(Math.random() * 60_000), Math.max(0, deadlineMs - Date.now())));
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const stamp = () => new Date().toISOString().slice(11, 19) + 'Z';

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
      console.error(`${stamp()} poll failed (${errors}/5): ${String(err.message || err).split('\n')[0]}`);
      if (errors >= 5) return 3;
    }
    if (v) {
      if (v.verdict === 'landed') {
        const before = v.before ? ` before this wait started; its last land run ${run.id} ${run.conclusion}` : '';
        console.log(`${stamp()} LANDED: ${args.ref} is gone from origin${before} (land.yml deletes it after the fast-forward)`);
        return args.prodMin ? waitForProd({ siteFiles: v.before ? null : siteFiles, prodMin: args.prodMin }) : 0;
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

module.exports = { landVerdict, prodPlan, prodVerdict, parseArgs, sitePathsIn, RED_CONCLUSIONS };
