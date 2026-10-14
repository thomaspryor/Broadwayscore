#!/usr/bin/env node
/**
 * generate-locks-index.js
 *
 * Scans data/review-texts/*\/*.json for human-locked review scores and writes
 * public/data/admin/locks.json. Driven from rebuild-all-reviews.js (end of
 * rebuild) and runnable standalone for local debugging.
 *
 * Local: `node scripts/generate-locks-index.js`
 * CI:    invoked indirectly via rebuild-all-reviews.js post-write step.
 */

const path = require('path');
const { writeLocksIndex } = require('./lib/locks-index');

// Prefer __dirname-relative paths (the path the rebuild workflow uses), but
// fall back to cwd when running from a worktree whose data/review-texts isn't
// symlinked. Local smoke testing from any directory works. Hard-fails when
// neither exists — silent fall-through to cwd-without-data wrote an empty
// locks.json which would have wiped the audit page (ship-check 2026-04-27 P1).
const fs = require('fs');
function resolveDir(rel, label) {
  const fromDirname = path.join(__dirname, '..', rel);
  if (fs.existsSync(fromDirname)) return fromDirname;
  const fromCwd = path.resolve(process.cwd(), rel);
  if (fs.existsSync(fromCwd)) return fromCwd;
  console.error(`✕ generate-locks-index: ${label || rel} not found at either ${fromDirname} or ${fromCwd}`);
  console.error(`  Run from a checkout where data/review-texts is populated, or pass an absolute path env override.`);
  process.exit(2);
}
const reviewTextsDir = resolveDir(path.join('data', 'review-texts'), 'review-texts');
const publicDir = resolveDir('public', 'public/');
const outputPath = path.join(publicDir, 'data', 'admin', 'locks.json');

const { count, withRationale, withoutRationale } = writeLocksIndex({
  reviewTextsDir,
  outputPath,
});

console.log(`🔒 locks.json written: ${count} locks (${withRationale} with rationale, ${withoutRationale} without)`);
console.log(`   → ${path.relative(process.cwd(), outputPath)}`);
