/**
 * Detects data/*.json files that are BOTH git-tracked in the public repo AND
 * shipped by checkout-core-data's private-repo copy (task #1759).
 *
 * A file in that intersection gets the worst of both worlds: git keeps
 * tracking it, so checkout-core-data's `cp -f /tmp/core-data-checkout/*.json
 * data/` dirties a tracked path on every run, and the next `git checkout
 * <branch>` in that job aborts (confirmed root cause of the 2026-08-17
 * autonomous-merge outage — see scripts/autonomous-merge-core-data-guard.test.mjs
 * for the tactical force-checkout fix that stops the outage without fixing
 * this). Untracked core-data files (shows.json, reviews.json, ...) never hit
 * this because git doesn't care what an untracked-and-ignored file's content
 * does on disk.
 *
 * CORE_FILES is read out of push-core-data/action.yml's source text rather
 * than duplicated here, so this guard can never silently drift from the list
 * checkout-core-data/push-core-data actually ship.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PUSH_CORE_DATA_ACTION = path.join(__dirname, '..', '..', '.github', 'actions', 'push-core-data', 'action.yml');

/** @returns {string[]} the CORE_FILES list declared in push-core-data/action.yml */
function getShippedCoreFiles({ actionPath = PUSH_CORE_DATA_ACTION } = {}) {
  const src = fs.readFileSync(actionPath, 'utf8');
  const m = src.match(/CORE_FILES="([^"]+)"/);
  if (!m) throw new Error(`could not find CORE_FILES="..." in ${actionPath}`);
  return m[1].split(/\s+/).filter(Boolean);
}

/** @returns {string[]} repo-relative data/*.json paths that are both tracked and ignored */
function getTrackedAndIgnored({ cwd = process.cwd() } = {}) {
  const out = execFileSync('git', ['ls-files', '-i', '-c', '--exclude-standard', '--', 'data'], {
    cwd,
    encoding: 'utf8',
  });
  return out.split('\n').filter((l) => /^data\/[^/]+\.json$/.test(l));
}

/**
 * @param {object} [opts]
 * @param {string} [opts.cwd] repo root to inspect
 * @param {string} [opts.actionPath] override for push-core-data/action.yml
 * @returns {string[]} repo-relative paths that are tracked-and-ignored AND shipped by checkout-core-data
 */
function findTrackedAndShipped({ cwd = process.cwd(), actionPath = PUSH_CORE_DATA_ACTION } = {}) {
  const shipped = new Set(getShippedCoreFiles({ actionPath }));
  return getTrackedAndIgnored({ cwd }).filter((p) => shipped.has(path.basename(p)));
}

module.exports = { getShippedCoreFiles, getTrackedAndIgnored, findTrackedAndShipped };

if (require.main === module) {
  for (const p of findTrackedAndShipped()) {
    console.log(p);
  }
}
