/**
 * installed-deps-drift (BRO-7492) — detects node_modules that no longer match
 * package-lock.json.
 *
 * 2026-11-14 incident: the main checkout had next 15.5.27 installed while the
 * lockfile pinned 16.4.3. Reset/merge paths advance the checkout without
 * reinstalling, so every local `tsc --noEmit` (and the pre-push tsc hook)
 * failed with TS2554 on the Next 16 `revalidateTag` signature, blocking pushes
 * from every worktree (they resolve node_modules from the main checkout).
 * Nothing named the real cause.
 *
 * Pure core: detectDrift(). I/O wrapper: checkDir(). CLI:
 *   node scripts/lib/installed-deps-drift.js [repoDir]   exit 1 on drift or no install, 0 otherwise
 *   Callers: .claude/hooks/session-start.sh (--session-start, always exit 0), scripts/hooks/pre-push (|| true).
 */
'use strict';

const fs = require('fs');
const path = require('path');

function majorOf(v) {
  const m = /^v?(\d+)\./.exec(String(v || ''));
  return m ? Number(m[1]) : null;
}

/**
 * @param {object} lock parsed package-lock.json (lockfileVersion >= 2)
 * @param {(name:string)=>string|null} readInstalled installed version or null when absent
 * @returns {{drift: Array<{name,locked,installed,kind}>, checked: number}}
 *   kind: 'major' | 'version' | 'missing'. Sorted major first, then missing, then version.
 */
function detectDrift(lock, readInstalled) {
  const pkgs = (lock && lock.packages) || {};
  const root = pkgs[''] || {};
  const optional = new Set(Object.keys(root.optionalDependencies || {}));
  const names = new Set([
    ...Object.keys(root.dependencies || {}),
    ...Object.keys(root.devDependencies || {}),
    ...optional,
  ]);
  const drift = [];
  let checked = 0;
  for (const name of names) {
    const entry = pkgs['node_modules/' + name];
    if (!entry || !entry.version || entry.link) continue;
    const installed = readInstalled(name);
    if (installed === undefined) continue; // present but versionless: cannot compare
    if (installed === null) {
      // Optional deps (platform binaries) are legitimately absent.
      if (!optional.has(name) && !entry.optional && !entry.devOptional) drift.push({ name, locked: entry.version, installed: null, kind: 'missing' });
      continue;
    }
    checked++;
    if (installed === entry.version) continue;
    const kind = majorOf(installed) !== majorOf(entry.version) ? 'major' : 'version';
    drift.push({ name, locked: entry.version, installed, kind });
  }
  const rank = { major: 0, missing: 1, version: 2 };
  drift.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
  return { drift, checked };
}

function formatMessage(result, repoDir) {
  if (!result.drift.length) return '';
  const lines = result.drift.slice(0, 5).map(
    (d) => `     ${d.name}: installed ${d.installed || '(missing)'}, lockfile ${d.locked}${d.kind === 'major' ? '  [MAJOR]' : ''}`
  );
  const more = result.drift.length > 5 ? `\n     …and ${result.drift.length - 5} more` : '';
  return (
    `🔶 NODE_MODULES DRIFT: ${result.drift.length} of ${result.checked} locked deps differ from package-lock.json in ${repoDir}.\n` +
    `   Local tsc/lint/tests can fail with errors that are NOT from your change (e.g. TS2554 on Next's revalidateTag).\n` +
    lines.join('\n') + more + '\n' +
    // `npm ci`, never `npm install`: install rewrites package-lock.json, and in the
    // shared main checkout that churn blocked checkout-sync's fast-forward for
    // hours (BRO-7713). ci installs exactly what the lockfile pins, unchanged.
    `   Fix: cd ${repoDir} && npm ci --no-audit --no-fund`
  );
}

function findNodeModules(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const c = path.join(d, 'node_modules');
    // A real install has .package-lock.json or .bin; a bare node_modules/.cache (eslint, babel) must not shadow the ancestor install.
    if (fs.existsSync(path.join(c, '.package-lock.json')) || fs.existsSync(path.join(c, '.bin'))) return c;
    if (path.dirname(d) === d) return null;
  }
}

/** Reads <dir>/package-lock.json and <dir>/node_modules/*; null when there is nothing to compare. */
function checkDir(dir) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  } catch {
    return null;
  }
  // Worktrees have no node_modules of their own; Node/tsc resolve the nearest
  // ancestor's, so compare the lockfile in `dir` against that one.
  const nm = findNodeModules(dir);
  if (!nm) return null; // never installed: not drift
  const read = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(nm, name, 'package.json'), 'utf8')).version || undefined;
    } catch {
      return null;
    }
  };
  return detectDrift(lock, read);
}

/**
 * A lockfile with no install anywhere above it means every local tsc/lint/test fails
 * on missing packages (2026-11-19: a cloud session started with an empty node_modules,
 * so land-local-check and a worker's tests failed with "Cannot find package 'next'"
 * while this check stayed silent). checkDir keeps returning null there (not drift);
 * this says so instead.
 */
function missingInstallMessage(dir) {
  if (!fs.existsSync(path.join(dir, 'package-lock.json'))) return '';
  if (findNodeModules(dir)) return '';
  return (
    `🔶 NODE_MODULES MISSING: ${dir} has a package-lock.json but no installed packages.\n` +
    `   Local tsc/lint/tests and land-local-check will fail on missing modules, not on your change.\n` +
    `   Fix: cd ${dir} && npm ci --no-audit --no-fund`
  );
}

module.exports = { detectDrift, formatMessage, checkDir, findNodeModules, majorOf, missingInstallMessage };

if (require.main === module) {
  const args = process.argv.slice(2);
  const sessionStart = args.includes('--session-start');
  const dir = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());
  // Session-start hook mode: main checkout only (a worktree's lockfile is its branch's); never fails the hook.
  if (sessionStart && dir.includes('/.claude/worktrees/')) process.exit(0);
  let r = null;
  try { r = checkDir(dir); } catch { /* fail-open */ }
  let msg = r ? formatMessage(r, dir) : '';
  if (!msg) { try { msg = missingInstallMessage(dir); } catch { /* fail-open */ } }
  if (msg) {
    console.log(sessionStart ? `\n${msg}\n` : msg);
    process.exit(sessionStart ? 0 : 1);
  }
  process.exit(0);
}
