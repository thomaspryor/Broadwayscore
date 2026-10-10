#!/usr/bin/env node
'use strict';

/**
 * Hold test.yml's E2E job until the site code it tests is live (BRO-4668).
 *
 * E2E runs Playwright against production. A commit that lands a feature and
 * its E2E test together used to run that test before Vercel had deployed the
 * feature, and main went red for ~10 minutes with nothing wrong (run
 * 37255760139 on 193732a0352: new sign-in copy "not found", live 9 min later).
 *
 * Decision (pure, exported for the test), from compare/{deployedSha}...{GITHUB_SHA}
 * — i.e. everything in this checkout that production does not have yet, not
 * just this push. (A data-bot push one minute after a feature push inherits
 * the feature's E2E test; judging by its own diff would run that test early.)
 *   - GITHUB_SHA is the deployed commit or an ancestor of it → live, run now.
 *   - the undeployed diff touches no E2E_SITE_PATHS → run now. Bot data churn
 *     in public/data/** and scripts/** never triggers a wait.
 *   - otherwise poll until it is live, up to --max-wait seconds.
 *
 * Liveness uses GitHub's compare API, not local git: CI checkouts are shallow,
 * and `merge-base --is-ancestor` false-negatives there (landing-verify.js).
 *
 * Fail-open by design: a missing token, an error that persists to the
 * deadline, or a timeout exits 0 with a ::warning:: annotation, so E2E still
 * runs. Kill switch: repo variable E2E_AWAIT_DEPLOY_DISABLED=true (test.yml).
 *
 * Env: GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_TOKEN, VERCEL_TOKEN.
 * Usage: node scripts/lib/e2e-await-deploy.js [--max-wait=1500] [--interval=60]
 */

const { SITE_PATHS } = require('./should-deploy-gate.js');

// The deploy gate's list minus what doesn't change what Playwright sees:
// scripts/ (scrapers; prebuild output is data) and public/data/ (bot churn).
const E2E_SITE_PATHS = SITE_PATHS.filter((p) => p !== 'scripts/');
const E2E_EXCLUDED_PREFIXES = ['public/data/'];

// GitHub's compare API returns at most 300 files; a full page may hide some.
const COMPARE_FILES_CAP = 300;

function touchesSiteCode(files) {
  return files.some(
    (f) =>
      !E2E_EXCLUDED_PREFIXES.some((x) => f.startsWith(x)) &&
      E2E_SITE_PATHS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p))
  );
}

// cmp = compare/{deployed}...{target}. "identical" = same commit, "behind" =
// deployed descends from target. Both mean the target is live.
function decide(cmp) {
  if (cmp.status === 'identical' || cmp.status === 'behind') return 'live';
  const entries = cmp.files || [];
  if (entries.length >= COMPARE_FILES_CAP) return 'wait';
  const files = entries.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
  return touchesSiteCode(files) ? 'wait' : 'no-site-code';
}

async function compare(repo, base, head, token) {
  const res = await fetch(`https://api.github.com/repos/${repo}/compare/${base}...${head}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`compare ${base.slice(0, 10)}...${head.slice(0, 10)} → HTTP ${res.status}`);
  return res.json();
}

function arg(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? parseInt(a.split('=')[1], 10) : dflt;
}

async function main() {
  const { GITHUB_SHA: sha, GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token } = process.env;
  const maxWait = arg('max-wait', 1500);
  const interval = arg('interval', 60);
  const say = (m) => console.log(`[e2e-await-deploy] ${m}`);

  if (!sha || !repo || !token) return say('::warning::GITHUB_SHA/GITHUB_REPOSITORY/GITHUB_TOKEN missing — not waiting.');
  if (!process.env.VERCEL_TOKEN) return say('::warning::VERCEL_TOKEN not set — cannot see prod, not waiting (E2E may race the deploy).');

  const { fetchLatestProdDeploy } = require('../check-prod-deploy.js');
  const short = (s) => (s || '?').slice(0, 10);
  const start = Date.now();
  const waited = () => `${Math.round((Date.now() - start) / 1000)}s`;
  let lastDepSha = null;
  let decision = null;
  let state = 'no answer yet';
  for (;;) {
    try {
      const dep = await fetchLatestProdDeploy();
      if (!dep.sha) throw new Error('latest READY production deploy has no githubCommitSha');
      // Only re-compare when prod moved: compare calls share the repo's API quota.
      if (dep.sha !== lastDepSha) {
        const cmp = await compare(repo, dep.sha, sha, token);
        decision = decide(cmp);
        lastDepSha = dep.sha;
        state = `prod at ${short(dep.sha)}, ${cmp.status}, ${(cmp.files || []).length} undeployed files`;
      }
    } catch (e) {
      state = `check failed: ${e.message}`;
    }
    if (decision === 'live') return say(`${short(sha)} is live (${state}) after ${waited()} — running E2E.`);
    if (decision === 'no-site-code') return say(`undeployed changes touch no site code (${state}) — running E2E now.`);
    if (Date.now() - start + interval * 1000 > maxWait * 1000) {
      return say(`::warning::${short(sha)} still not live after ${waited()} (${state}) — running E2E anyway.`);
    }
    say(`waiting for site code to go live (${state}); next check in ${interval}s`);
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

module.exports = { touchesSiteCode, decide, E2E_SITE_PATHS };

if (require.main === module) {
  main().catch((e) => {
    console.log(`[e2e-await-deploy] ::warning::${e.message} — not waiting (fail-open).`);
  });
}
