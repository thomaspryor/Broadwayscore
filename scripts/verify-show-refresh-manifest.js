#!/usr/bin/env node
'use strict';
/**
 * BRO-8056 phase 1b: postbuild check that the data this build compiled is the
 * data its show-refresh manifest describes (no slice input changed during the
 * build, manifest built from this commit). On a mismatch, or if verifying
 * throws, the manifest is overwritten with an invalid marker (deleted only if
 * the marker cannot be written:
 * next build already traced it into functions and Vercel packages after
 * postbuild), so show refresh is off for this build. Never fails the build (package.json
 * postbuild runs it with `|| true`, and it exits 0 itself).
 *
 *   node scripts/verify-show-refresh-manifest.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help');
const { verifyManifest, invalidManifest, MANIFEST_FILE, SLICE_REQUIRED_FILES, SLICE_OPTIONAL_FILES } = require('./lib/show-refresh/manifest');

const ROOT = path.join(__dirname, '..');

/** Same order as the builder: git HEAD, then CI-provided shas. */
function resolvePublicSha(env = process.env, cwd = ROOT) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  } catch { /* no git */ }
  return env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA || null;
}

function invalidate(manifestPath, problems) {
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(invalidManifest(problems)));
  fs.renameSync(tmp, manifestPath);
}

/**
 * Turn show refresh off for this build when verifying threw. Prefer the
 * invalid marker; if even that cannot be written, delete the manifest (a
 * missing manifest is also "refresh off") rather than leave one that may
 * describe some other data. Logs what actually happened.
 */
function disable(manifestPath, problem, log) {
  try {
    invalidate(manifestPath, [problem]);
    log.warn(`[show-refresh-manifest] WARNING: ${problem}; manifest marked invalid (show refresh off).`);
    return [];
  } catch (e1) {
    try {
      fs.rmSync(manifestPath, { force: true });
      log.warn(`[show-refresh-manifest] WARNING: ${problem}; could not write the invalid marker (${e1 && e1.message}), manifest deleted (show refresh off).`);
      return [`invalid marker failed: ${e1 && e1.message}`];
    } catch (e2) {
      log.error(`[show-refresh-manifest] ERROR: ${problem}; could neither mark invalid nor delete ${manifestPath} (${e2 && e2.message}). This build's manifest may be wrong.`);
      return [`invalid marker failed: ${e1 && e1.message}`, `delete failed: ${e2 && e2.message}`];
    }
  }
}

function verify({ root = ROOT, env = process.env, log = console } = {}) {
  const manifestPath = path.join(root, MANIFEST_FILE);
  try {
    return verifyOrThrow({ root, env, log, manifestPath });
  } catch (e) {
    const problem = `verifier failed: ${e && e.message}`;
    return { ok: false, problems: [problem, ...disable(manifestPath, problem, log)] };
  }
}

function verifyOrThrow({ root, env, log, manifestPath }) {
  if (!fs.existsSync(manifestPath)) {
    log.warn('[show-refresh-manifest] no manifest at postbuild (prebuild did not build one); show refresh is off for this build.');
    return { ok: false, problems: ['no manifest'] };
  }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { manifest = null; }
  const dataFiles = {};
  for (const name of [...Object.keys((manifest && manifest.dataShas) || {}), ...((manifest && manifest.absentFiles) || [])]) {
    const file = path.join(root, 'data', name);
    if (fs.existsSync(file)) dataFiles[name] = fs.readFileSync(file);
  }
  const problems = verifyManifest(manifest, {
    dataFiles, publicSha: resolvePublicSha(env, root),
    expectedInputs: { required: SLICE_REQUIRED_FILES, optional: SLICE_OPTIONAL_FILES },
  });
  if (problems.length) {
    invalidate(manifestPath, problems);
    log.warn(`[show-refresh-manifest] WARNING: manifest does not match this build, marked invalid (show refresh off): ${problems.join('; ')}`);
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
