#!/usr/bin/env node
/**
 * Local production deploy bypassing GitHub Actions.
 *
 * Mirrors what .github/workflows/vercel-deploy.yml does (pull → build → deploy)
 * but runs from your Mac. Use when GitHub's cron scheduler is lagging and you
 * want a specific change live in ~90s instead of waiting 5-30min for the cron
 * to fire.
 *
 * Trade-offs vs the cron deploy:
 *   - No CI gate (tsc/lint/tests don't run) — verify locally first
 *   - No audit trail in GitHub Actions (only this script's local log)
 *   - Doesn't dedupe with parallel sessions — if another push lands during
 *     your build, the cron will redeploy. That's fine; Vercel handles it.
 *
 * Safety rails:
 *   - Requires clean working tree (no uncommitted changes)
 *   - Must be on main branch
 *   - Pulls latest origin/main first (catches unpushed/missing commits)
 *   - Loads VERCEL_TOKEN from .env (same secret CI uses)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', cwd: REPO_ROOT, ...opts }).trim();
}

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

function loadVercelToken() {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    fail(`.env not found at ${envPath} — VERCEL_TOKEN required.`);
  }
  const envContent = fs.readFileSync(envPath, 'utf8');
  const match = envContent.match(/^VERCEL_TOKEN=(.+)$/m);
  if (!match) {
    fail('VERCEL_TOKEN not found in .env');
  }
  return match[1].trim().replace(/^["']|["']$/g, '');
}

function preflight() {
  const branch = sh('git branch --show-current');
  if (branch !== 'main') {
    fail(`Must be on main branch (currently on "${branch}"). Merge your work to main first.`);
  }

  const status = sh('git status --porcelain');
  if (status.trim()) {
    fail(`Working tree is not clean. Commit or stash changes first:\n${status}`);
  }

  console.log('→ Fetching origin/main to check for unpushed commits...');
  sh('git fetch origin main --quiet');
  const ahead = sh('git rev-list --count origin/main..HEAD');
  const behind = sh('git rev-list --count HEAD..origin/main');
  if (parseInt(ahead, 10) > 0) {
    fail(`Local main is ${ahead} commit(s) ahead of origin/main. Push first so the deploy reflects what's in the repo.`);
  }
  if (parseInt(behind, 10) > 0) {
    fail(`Local main is ${behind} commit(s) behind origin/main. Run 'git pull origin main' first.`);
  }

  const sha = sh('git rev-parse --short HEAD');
  const msg = sh('git log -1 --pretty=%s');
  console.log(`→ Deploying main @ ${sha}: ${msg}\n`);
  return { sha, msg };
}

function deploy() {
  const { sha, msg } = preflight();
  const token = loadVercelToken();

  const env = { ...process.env, VERCEL_TOKEN: token };
  const t0 = Date.now();

  console.log('→ vercel pull (fetching production env)...');
  execSync(`npx --yes vercel pull --yes --environment=production --token="${token}"`, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env,
  });

  console.log('\n→ vercel build --prod (this is the slow step, ~60-90s)...');
  execSync(`npx --yes vercel build --prod --token="${token}"`, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env,
  });

  console.log('\n→ vercel deploy --prebuilt --prod (uploading)...');
  const url = execSync(`npx --yes vercel deploy --prebuilt --prod --archive=tgz --token="${token}"`, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  }).trim();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✅ Deployed ${sha} in ${elapsed}s`);
  console.log(`   ${url}`);
  console.log(`   https://broadwayscorecard.com (alias auto-promotes)\n`);
}

deploy();
