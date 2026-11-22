#!/usr/bin/env node
'use strict';
/**
 * BRO-8056 phase 1b: postbuild check that the data this build compiled is the
 * data its show-refresh manifest describes (no slice input changed during the
 * build, manifest built from this commit). On a mismatch the manifest is
 * deleted, so show refresh is off for this build instead of trusting a
 * manifest that describes other data. Never fails the build (package.json
 * postbuild runs it with `|| true`, and it exits 0 itself).
 *
 *   node scripts/verify-show-refresh-manifest.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help');
const { verifyManifest, MANIFEST_FILE } = require('./lib/show-refresh/manifest');

const ROOT = path.join(__dirname, '..');

/** Same order as the builder: git HEAD, then CI-provided shas. */
function resolvePublicSha(env = process.env, cwd = ROOT) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  } catch { /* no git */ }
  return env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA || null;
}

function verify({ root = ROOT, env = process.env, log = console } = {}) {
  const manifestPath = path.join(root, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    log.warn('[show-refresh-manifest] no manifest at postbuild (prebuild did not build one); show refresh is off for this build.');
    return { ok: false, problems: ['no manifest'] };
  }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { manifest = null; }
  const dataFiles = {};
  for (const name of Object.keys((manifest && manifest.dataShas) || {})) {
    const file = path.join(root, 'data', name);
    if (fs.existsSync(file)) dataFiles[name] = fs.readFileSync(file);
  }
  const problems = verifyManifest(manifest, { dataFiles, publicSha: resolvePublicSha(env, root) });
  if (problems.length) {
    fs.rmSync(manifestPath, { force: true });
    log.warn(`[show-refresh-manifest] WARNING: manifest does not match this build, removed (show refresh off): ${problems.join('; ')}`);
    return { ok: false, problems };
  }
  log.log(`[show-refresh-manifest] verified: ${manifest.showCount} shows, ${Object.keys(manifest.dataShas).length} data files unchanged`);
  return { ok: true, problems: [] };
}

module.exports = { verify, resolvePublicSha };

if (require.main === module) {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: node scripts/verify-show-refresh-manifest.js\nPostbuild check of data/show-refresh-manifest.json (BRO-8056). Always exits 0.');
    process.exit(0);
  }
  try { verify(); } catch (e) { console.warn(`[show-refresh-manifest] WARNING: verifier failed (${e && e.message})`); }
  process.exit(0);
}
