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
 *
 * MACHINE CONTRACT (2026-07-19): `--json` output is parsed by
 * scripts/lib/should-deploy-gate.js (deploy-gate baseline: deployedSha, ageSec)
 * and scripts/health-check.js checkDeployFreshness(). Do NOT print anything
 * else to stdout in --json mode and do NOT rename those two fields — a silent
 * parse failure makes the deploy gate fail open (deploys every cron tick,
 * Vercel bill climbs with no red run anywhere).
 */

const { execSync } = require('child_process');
const { checkLanded } = require('./lib/landing-verify.js');

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

async function latestProdDeploy() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
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

function fmtAge(sec) {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

async function main() {
  const { commit, json, wait } = parseArgs(process.argv.slice(2));
  const deadline = wait != null ? Date.now() + wait * 1000 : 0;

  for (;;) {
    const dep = await latestProdDeploy();
    const live = commit ? isLive(commit, dep.sha) : null;

    const done = wait == null || live || Date.now() >= deadline;
    if (done) {
      if (json) {
        console.log(JSON.stringify({ deployedSha: dep.sha, url: dep.url, ageSec: dep.ageSec, target: commit, live }, null, 2));
      } else {
        const shortDeployed = dep.sha ? dep.sha.slice(0, 10) : '(unknown)';
        console.log(`Production READY deployment: ${shortDeployed}  (age ${fmtAge(dep.ageSec)})  https://${dep.url}`);
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
    await new Promise((r) => setTimeout(r, 20000));
  }
}

main();
