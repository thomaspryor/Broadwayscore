'use strict';
/**
 * memo-warm-needed.js (BRO-8148): did a landing change a file that keys the
 * rebuild fingerprint memo?
 *
 * Every rebuild restores .cache/rebuild-fp-cache.json, keyed by hashFiles() over
 * the files fingerprint-memo.js versions (versionedSources). Editing one of them
 * changes the key, so the next rebuild runs cold (0 reused, ~11 min instead of
 * ~6) until some run on main saves a new memo. On 2026-11-22 the first cold run
 * was the Fantasma poller's inline rebuild, so a review went live 34.7 min after
 * first seen (bar 30). land.yml uses this to dispatch rebuild-fast on main right
 * after such a landing, so the cold run happens at landing time and saves the
 * memo (a Land run is on a land/** ref, so it cannot save a main-visible cache).
 *
 * CLI: node scripts/lib/memo-warm-needed.js <baseSha> <headSha>  -> prints true|false
 */
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

/** Repo-relative paths of the files that key the memo (derived, never hand-kept). */
function memoKeyFiles() {
  const { versionedSources } = require('./fingerprint-memo');
  return versionedSources().map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
}

/** True when any changed path is a memo key file. */
function needsWarm(changedFiles, keyFiles = memoKeyFiles()) {
  const keys = new Set(keyFiles);
  return (changedFiles || []).some((f) => keys.has(String(f).trim()));
}

module.exports = { memoKeyFiles, needsWarm };

/**
 * Files a landing changed, from land.js's result file (`files` is the diff of
 * the tree it actually pushed, train riders included). The land job's own
 * checkout is NOT the landed commit (landing happens in a throwaway worktree),
 * so a HEAD-based diff would see nothing.
 */
function filesFromResult(resultPath) {
  const r = JSON.parse(require('fs').readFileSync(resultPath, 'utf8'));
  if (r.landed !== true || r.pushed !== true) return [];
  return Array.isArray(r.files) ? r.files : [];
}

module.exports.filesFromResult = filesFromResult;

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: memo-warm-needed.js <land-result.json>  |  <baseSha> <headSha>'); process.exit(2); }
  let files;
  try {
    files = process.argv[3]
      ? execFileSync('git', ['diff', '--name-only', arg, process.argv[3]], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
      : filesFromResult(arg);
  } catch (e) {
    // Fail closed: a bad input must not turn every landing into a rebuild-fast
    // that holds the depth-1 group on a press night.
    console.error(`memo-warm-needed failed: ${e.message.split('\n')[0]}`);
    console.log('false');
    process.exit(0);
  }
  console.log(needsWarm(files) ? 'true' : 'false');
}
