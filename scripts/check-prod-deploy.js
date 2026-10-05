#!/usr/bin/env node
'use strict';

/**
 * Authoritative "what is actually live on production" check.
 *
 * WHY THIS EXISTS (2026-06-26 incident): the GitHub "Deploy to Vercel" run
 * reporting `success` is NOT proof the build is serving. During a cancel-cascade
 * (a burst of triggers each cancelling the previous production build via Vercel's
 * auto-cancellation of superseded deploys), the GitHub run is green while its
 * Vercel deployment ends up CANCELED. So `gh run list --workflow="Deploy to
 * Vercel" --json headSha` reports a commit that was never served — a false
 * "it's deployed". The ONLY source of truth is Vercel's latest *production*
 * deployment in state READY. This script reads exactly that, via the Vercel API.
 *
 * Usage:
 *   node scripts/check-prod-deploy.js
 *       → prints the commit SHA currently live on production, its age, and URL.
 *
 *   node scripts/check-prod-deploy.js <commit-ish>
 *       → also checks whether <commit-ish> is live (i.e. an ancestor of, or equal
 *         to, the deployed commit). Exits 0 if live, 1 if not yet live. Use this
 *         to gate any "deployed/live on production" claim:
 *           node scripts/check-prod-deploy.js HEAD && echo "HEAD is live"
 *
 * Flags:
 *   --json   machine-readable output
 *   --wait[=SECONDS]  poll until the target commit is live or the timeout
 *                     elapses (default 900s). Requires a <commit-ish> arg.
 *
 * Requires: VERCEL_TOKEN in the environment (already used by check-secrets-health).
 * Without it (cloud sessions), the human-readable mode falls back to the
 * newest vercel-deploy.yml run whose deploy job log proves the production
 * alias (scripts/lib/deploy-log-proof.js), via `gh api`. --json never falls
 * back: it exits 2 as before, so the deploy gate keeps failing closed.
 *
 * MACHINE CONTRACT (2026-07-19, extended 2026-09-16 BRO-3149): `--json` output
 * is parsed by scripts/lib/should-deploy-gate.js (deploy-gate baseline:
 * deployedSha, ageSec, reviewsBlobSha, showsBlobSha)
 * and scripts/health-check.js checkDeployFreshness(). Do NOT print anything
 * else to stdout in --json mode and do NOT rename those two fields — a silent
 * parse failure makes the deploy gate fail open (deploys every cron tick,
 * Vercel bill climbs with no red run anywhere).
 */

const { execSync, execFileSync } = require('child_process');
const { checkLanded } = require('./lib/landing-verify.js');
const { prodAliasFromLog } = require('./lib/deploy-log-proof.js');

const REPO = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
const ghText = (path) => execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const ghJson = (path) => JSON.parse(ghText(path));
// Overlapping deploys can alias out of run order, so read a few proven runs
// and keep the one aliased last.
const GITHUB_PROOFS = 3;

const PROJECT_ID = 'prj_wmBnDUrCQCwabIAYPbnMiIP3wg15'; // Broadway Scorecard (see vercel-deploy.yml)
const API = `https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&target=production&state=READY&limit=1`;

function parseArgs(argv) {
  const out = { commit: null, json: false, wait: null };
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a === '--wait') out.wait = 900;
    else if (a.startsWith('--wait=')) out.wait = Math.max(0, parseInt(a.slice(7), 10) || 0);
    else if (!a.startsWith('--')) out.commit = a;
  }
  return out;
}

function githubProdDeploy() {
  // Unfiltered listing, filtered here: the status= filter is served from an
  // index that lagged by weeks on its first live call (2026-10-05). A stale
  // pick only errs toward "not live yet", never toward a false "live".
  const runs = (ghJson(`repos/${REPO}/actions/workflows/vercel-deploy.yml/runs?branch=main&per_page=20`).workflow_runs || [])
    .filter((r) => r.status === 'completed' && r.conclusion === 'success');
  let best = null;
  let proofs = 0;
  for (const run of runs) {
    const job = (ghJson(`repos/${REPO}/actions/runs/${run.id}/jobs?per_page=50`).jobs || [])
      .find((j) => j.name === 'deploy' && j.conclusion === 'success');
    if (!job) continue; // gate said skip: no deploy happened in this run
    const proof = prodAliasFromLog(ghText(`repos/${REPO}/actions/jobs/${job.id}/logs`));
    if (!proof) continue;
    if (!best || proof.aliasedAtMs > best.createdMs) {
      best = { sha: run.head_sha, reviewsBlobSha: null, showsBlobSha: null, url: proof.url, createdMs: proof.aliasedAtMs, via: `deploy run ${run.id}` };
    }
    if (++proofs >= GITHUB_PROOFS) break;
  }
  if (best) best.ageSec = Math.round((Date.now() - best.createdMs) / 1000);
  return best;
}

async function latestProdDeploy({ json } = {}) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    if (!json) {
      let dep = null;
      try { dep = githubProdDeploy(); } catch (e) { console.error(`❌ GitHub fallback failed: ${String(e.stderr || e.message).trim()}`); }
      if (dep) return dep;
    }
    console.error('❌ VERCEL_TOKEN not set — cannot query the Vercel API. (echo ${VERCEL_TOKEN:+SET})');
    process.exit(2);
  }
  let res;
  try {
    res = await fetch(API, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    console.error(`❌ Vercel API request failed: ${e.message}`);
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`❌ Vercel API returned ${res.status} ${res.statusText}`);
    process.exit(2);
  }
  const body = await res.json();
  const dep = body.deployments && body.deployments[0];
  if (!dep) {
    console.error('❌ No READY production deployment found.');
    process.exit(2);
  }
  return {
    sha: (dep.meta && dep.meta.githubCommitSha) || null,
    // BRO-3149: git blob SHAs of data/reviews.json + data/shows.json as of
    // THIS deployment's build, stamped by the Deploy step (`vercel deploy
    // --meta reviewsBlobSha=... --meta showsBlobSha=...`) — lets
    // should-deploy-gate.js detect core-data-only changes that never touch
    // this repo's git tree.
    reviewsBlobSha: (dep.meta && dep.meta.reviewsBlobSha) || null,
    showsBlobSha: (dep.meta && dep.meta.showsBlobSha) || null,
    url: dep.url,
    createdMs: dep.created,
    ageSec: Math.round((Date.now() - dep.created) / 1000),
  };
}

// Is `commit` live — i.e. equal to or an ancestor of the deployed `sha`?
// Uses local git so it works for any commit-ish (HEAD, a branch, a short sha).
// Shallow- and error-aware (task #1497, same false-negative class as #1489):
// a shallow checkout or a transient git error must not silently read as
// "not live yet" — checkLanded restores full history first and reports
// UNKNOWN (logged, never silently swallowed) instead of a false NOT_LANDED.
function isLive(commit, deployedSha) {
  if (!deployedSha) return false;
  const result = checkLanded({ sha: commit, ref: deployedSha, cwd: process.cwd(), log: (m) => console.error(m) });
  if (result.verdict === 'UNKNOWN') {
    console.error(`⚠️  Could not determine whether ${commit} is live (reason=${result.reason}) — treating as not-yet-live; this may be a false negative, verify via VERCEL_TOKEN dashboard or 'git ls-remote origin main'.`);
  }
  return result.landed === true;
}

// GitHub-fallback liveness: the compare API, since cloud clones are shallow
// and checkLanded's unshallow is slow there. Unknown reads as not live.
function isLiveViaGithub(commit, deployedSha) {
  if (!deployedSha) return false;
  try {
    const full = execFileSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const { status } = ghJson(`repos/${REPO}/compare/${full}...${deployedSha}`);
    return status === 'ahead' || status === 'identical';
  } catch (e) {
    console.error(`⚠️  Could not determine whether ${commit} is live (${String(e.stderr || e.message).trim().split('\n')[0]}) — treating as not-yet-live.`);
    return false;
  }
}

function fmtAge(sec) {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

async function main() {
  const { commit, json, wait } = parseArgs(process.argv.slice(2));
  const deadline = wait != null ? Date.now() + wait * 1000 : 0;

  for (;;) {
    const dep = await latestProdDeploy({ json });
    const live = commit ? (dep.via ? isLiveViaGithub(commit, dep.sha) : isLive(commit, dep.sha)) : null;

    const done = wait == null || live || Date.now() >= deadline;
    if (done) {
      if (json) {
        console.log(JSON.stringify({ deployedSha: dep.sha, reviewsBlobSha: dep.reviewsBlobSha, showsBlobSha: dep.showsBlobSha, url: dep.url, ageSec: dep.ageSec, target: commit, live }, null, 2));
      } else {
        const shortDeployed = dep.sha ? dep.sha.slice(0, 10) : '(unknown)';
        const source = dep.via ? `, from ${dep.via}'s log: no VERCEL_TOKEN` : '';
        console.log(`Production READY deployment: ${shortDeployed}  (age ${fmtAge(dep.ageSec)}${source})  https://${dep.url}`);
        if (commit) {
          let shortTarget = commit;
          // stderr silenced: a bogus commit-ish makes git print "fatal: Needed a
          // single revision" — harmless here (we fall back to the raw arg), so
          // don't leak it to the user.
          try { shortTarget = execSync(`git rev-parse --short ${commit}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
          console.log(live ? `✅ ${shortTarget} is LIVE on production.` : `⏳ ${shortTarget} is NOT live yet (production is at ${shortDeployed}).`);
        }
      }
      process.exit(commit && !live ? 1 : 0);
    }

    const remaining = Math.round((deadline - Date.now()) / 1000);
    process.stderr.write(`⏳ not live yet (prod at ${dep.sha ? dep.sha.slice(0, 10) : '?'}); ${remaining}s left…\n`);
    await new Promise((r) => setTimeout(r, dep.via ? 60000 : 20000)); // GitHub fallback downloads logs: poll gently
  }
}

main();
