/**
 * Ratchet logic for BRO-5885: scripts that list show directories with
 * `fs.statSync(...).isDirectory()` over readdir results crash on a dangling
 * symlink (ENOENT). scripts/lib/list-show-dirs.js is the safe replacement;
 * this module counts the remaining unsafe uses per file so a gate can fail
 * when a file gains one (or a new file adds one) beyond the committed baseline.
 */
const fs = require('fs');
const path = require('path');

const UNSAFE_RE = /\bstatSync\b[^\n]*\.isDirectory\s*\(/;
const SKIP_DIRS = new Set(['node_modules', '.git']);
// The helper itself legitimately stats inside a try/catch.
const ALLOWED = new Set(['scripts/lib/list-show-dirs.js']);

function countUnsafeLines(source) {
  return source.split('\n').filter((l) => UNSAFE_RE.test(l) && !/^\s*(\/\/|\*)/.test(l)).length;
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|cjs|mjs)$/.test(e.name) && !/\.test\.(js|cjs|mjs)$/.test(e.name)) out.push(full);
  }
}

/** @returns {Record<string, number>} repo-relative path -> unsafe line count */
function scanScripts(repoRoot) {
  let files = [];
  try {
    // Tracked files only, so local scratch files cannot trip the ratchet.
    files = require('child_process')
      .execFileSync('git', ['ls-files', '-z', 'scripts'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
      .toString().split('\0').filter((f) => /\.(js|cjs|mjs)$/.test(f) && !/\.test\.(js|cjs|mjs)$/.test(f))
      .map((f) => path.join(repoRoot, f));
  } catch { files = []; }
  if (!files.length) walk(path.join(repoRoot, 'scripts'), files);
  const counts = {};
  for (const f of files) {
    const rel = path.relative(repoRoot, f).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    const n = countUnsafeLines(fs.readFileSync(f, 'utf8'));
    if (n > 0) counts[rel] = n;
  }
  return counts;
}

/**
 * @returns {{regressions: Array<{file:string, baseline:number, actual:number}>,
 *            improvements: Array<{file:string, baseline:number, actual:number}>}}
 */
function compareToBaseline(counts, baseline) {
  const regressions = [];
  const improvements = [];
  for (const file of new Set([...Object.keys(counts), ...Object.keys(baseline)])) {
    const actual = counts[file] || 0;
    const base = baseline[file] || 0;
    if (actual > base) regressions.push({ file, baseline: base, actual });
    else if (actual < base) improvements.push({ file, baseline: base, actual });
  }
  return { regressions, improvements };
}

module.exports = { UNSAFE_RE, countUnsafeLines, scanScripts, compareToBaseline };
