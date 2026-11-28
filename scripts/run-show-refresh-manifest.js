#!/usr/bin/env node
'use strict';
/**
 * BRO-8056 phase 1b: prebuild entry for the show-refresh manifest. Fail-soft.
 *
 * Runs `node --import tsx <builder>` with a hard time limit. Whatever happens
 * (builder throws, hangs, tsx missing) this exits 0 so the site build goes on;
 * a failed run leaves NO manifest (the stale one is removed first), which
 * means show refresh is off for this build rather than working from a manifest
 * that describes some other build.
 *
 *   node scripts/run-show-refresh-manifest.js scripts/build-show-refresh-manifest.ts
 *
 * SHOW_REFRESH_MANIFEST_TIMEOUT_MS overrides the 180s limit (tests use it).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help');

const ROOT = path.join(__dirname, '..');
const { MANIFEST_FILE } = require('./lib/show-refresh/manifest');
const DEFAULT_TIMEOUT_MS = 180000;

function run({ builder, root = ROOT, env = process.env, log = console } = {}) {
  const manifestPath = path.join(root, MANIFEST_FILE);
  fs.rmSync(manifestPath, { force: true });
  if (!builder) {
    log.warn('[show-refresh-manifest] no builder given; skipping (show refresh off for this build)');
    return { ok: false, reason: 'no-builder' };
  }
  const timeout = Number(env.SHOW_REFRESH_MANIFEST_TIMEOUT_MS) > 0 ? Number(env.SHOW_REFRESH_MANIFEST_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const res = spawnSync(process.execPath, ['--import', 'tsx', path.resolve(root, builder)], {
    cwd: root, env, stdio: 'inherit', timeout, killSignal: 'SIGKILL',
  });
  let reason = null;
  if (res.error) reason = res.error.code === 'ETIMEDOUT' ? `timed out after ${timeout}ms` : res.error.message;
  else if (res.signal) reason = `killed by ${res.signal}`;
  else if (res.status !== 0) reason = `exit ${res.status}`;
  else if (!fs.existsSync(manifestPath)) reason = 'builder exited 0 but wrote no manifest';
  if (reason) {
    fs.rmSync(manifestPath, { force: true });
    log.warn(`[show-refresh-manifest] WARNING: manifest not built (${reason}); show refresh is off for this build. The site build continues.`);
    return { ok: false, reason };
  }
  return { ok: true };
}

module.exports = { run, DEFAULT_TIMEOUT_MS };

if (require.main === module) {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: node scripts/run-show-refresh-manifest.js <builder.ts>\nBuilds data/show-refresh-manifest.json fail-soft (BRO-8056). Always exits 0.');
    process.exit(0);
  }
  try {
    // Same .env* files next build loads (production mode), so feature flags set
    // in .env.local reach getRecentShowSlugs() in the builder too.
    try { require('@next/env').loadEnvConfig(ROOT, false); } catch (e) {
      console.warn(`[show-refresh-manifest] WARNING: could not load .env files (${e && e.message})`);
    }
    run({ builder: process.argv[2] });
  } catch (e) {
    console.warn(`[show-refresh-manifest] WARNING: runner failed (${e && e.message}); show refresh is off for this build.`);
  }
  process.exit(0);
}
