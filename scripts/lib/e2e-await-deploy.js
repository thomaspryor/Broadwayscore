#!/usr/bin/env node
'use strict';

/**
 * Hold test.yml's E2E job until this push's site changes are live (BRO-4668).
 *
 * E2E runs Playwright against production. A commit that lands a feature and
 * its E2E test together used to run that test before Vercel had deployed the
 * feature, and main went red for ~10 minutes with nothing wrong (run
 * 37255760139 on 193732a0352: new sign-in copy "not found", live 9 min later).
 *
 * Decision (pure, exported for the test):
 *   - this push changed nothing under SITE_CODE_PATHS → run E2E now. Data churn
 *     in public/data/** is committed by bots constantly and is not what E2E
 *     asserts on, so it never triggers a wait.
 *   - otherwise poll until GITHUB_SHA is an ancestor of (or equal to) the live
 *     production commit, up to --max-wait seconds.
 *
 * Liveness uses GitHub's compare API, not local git: CI checkouts are shallow,
 * and `merge-base --is-ancestor` false-negatives there (landing-verify.js).
 *
 * Fail-open by design: any error or timeout exits 0 with a logged reason, so
 * E2E still runs and goes red honestly if the deploy never landed.
 *
 * Env: GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_TOKEN, VERCEL_TOKEN,
 *      PUSH_BEFORE (github.event.before).
 * Usage: node scripts/lib/e2e-await-deploy.js [--max-wait=1500] [--interval=60]
 */

const SITE_CODE_PATHS = ['src/', 'next.config.js', 'tailwind.config.ts', 'tailwind.config.js', 'postcss.config.js'];

function touchesSiteCode(files) {
  return files.some((f) => SITE_CODE_PATHS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
}

// compare/{target}...{deployed}: "ahead" = deployed descends from target,
// "identical" = same commit. "behind"/"diverged" = target not live yet.
function isLiveStatus(status) {
  return status === 'ahead' || status === 'identical';
}

function isNullSha(sha) {
  return !sha || /^0+$/.test(sha);
}

async function compare(repo, base, head, token) {
  const res = await fetch(`https://api.github.com/repos/${repo}/compare/${base}...${head}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`compare ${base.slice(0, 10)}...${head.slice(0, 10)} → HTTP ${res.status}`);
  return res.json();
}

function arg(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? parseInt(a.split('=')[1], 10) : dflt;
}

async function main() {
  const { GITHUB_SHA: sha, GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token, PUSH_BEFORE: before } = process.env;
  const maxWait = arg('max-wait', 1500);
  const interval = arg('interval', 60);
  const say = (m) => console.log(`[e2e-await-deploy] ${m}`);

  if (!sha || !repo || !token) return say('GITHUB_SHA/GITHUB_REPOSITORY/GITHUB_TOKEN missing — not waiting.');
  if (!process.env.VERCEL_TOKEN) return say('::warning::VERCEL_TOKEN not set — cannot see prod, not waiting (E2E may race the deploy).');
  if (isNullSha(before)) return say('no push base (new branch or dispatch) — not waiting.');

  const pushed = await compare(repo, before, sha, token);
  const files = (pushed.files || []).map((f) => f.filename);
  if (!touchesSiteCode(files)) return say(`this push changed no site code (${files.length} files) — running E2E now.`);

  const { latestProdDeploy } = require('../check-prod-deploy.js');
  const deadline = Date.now() + maxWait * 1000;
  for (;;) {
    const dep = await latestProdDeploy();
    const status = dep.sha ? (await compare(repo, sha, dep.sha, token)).status : 'unknown';
    if (isLiveStatus(status)) return say(`${sha.slice(0, 10)} is live (prod at ${dep.sha.slice(0, 10)}) — running E2E.`);
    if (Date.now() >= deadline) {
      return say(`::warning::${sha.slice(0, 10)} still not live after ${maxWait}s (prod at ${(dep.sha || '?').slice(0, 10)}, ${status}) — running E2E anyway.`);
    }
    say(`site code not live yet (prod at ${(dep.sha || '?').slice(0, 10)}, ${status}); next check in ${interval}s`);
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

module.exports = { touchesSiteCode, isLiveStatus, isNullSha, SITE_CODE_PATHS };

if (require.main === module) {
  main().catch((e) => {
    console.log(`[e2e-await-deploy] ::warning::${e.message} — not waiting (fail-open).`);
  });
}
