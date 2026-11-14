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
 *   node scripts/lib/installed-deps-drift.js [repoDir]   exit 1 on drift, 0 otherwise
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
    checked++;
    const installed = readInstalled(name);
    if (installed == null) {
      // Optional deps (platform binaries) are legitimately absent.
      if (!optional.has(name) && !entry.optional) drift.push({ name, locked: entry.version, installed: null, kind: 'missing' });
      continue;
    }
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
    `   Fix: cd ${repoDir} && npm install --no-audit --no-fund`
  );
}

/** Reads <dir>/package-lock.json and <dir>/node_modules/*; null when there is nothing to compare. */
function checkDir(dir) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  } catch {
    return null;
  }
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm)) return null; // never installed here: not drift
  const read = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(nm, name, 'package.json'), 'utf8')).version || null;
    } catch {
      return null;
    }
  };
  return detectDrift(lock, read);
}

module.exports = { detectDrift, formatMessage, checkDir, majorOf };

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || process.cwd());
  const r = checkDir(dir);
  const msg = r ? formatMessage(r, dir) : '';
  if (msg) {
    console.log(msg);
    process.exit(1);
  }
  process.exit(0);
}
