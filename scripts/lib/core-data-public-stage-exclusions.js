/**
 * Computes which dual-tracked core-data files should be EXCLUDED from the
 * broad `git add data/` in stage-data-changes.sh (the PUBLIC repo commit
 * step used by most workflows).
 *
 * Root cause (task #989): a handful of core-data files are private-repo-
 * owned (gitignored, listed in .gitignore under "Core data files") but are
 * ALSO stray-tracked in the public repo's git index (never `git rm --cached`
 * after being gitignored). checkout-core-data's "Copy core data to data/"
 * step unconditionally overwrites data/$f with the private repo's checkout-
 * time copy, regardless of whether the running workflow ever touches that
 * file. If that copy differs from whatever's in the public repo's tracked
 * git index — which happens any time a fix lands in only one of the two
 * repos — a blind `git add data/` stages the private repo's (possibly
 * stale) copy as a "change" and commits it, silently reverting the public
 * fix. Confirmed live: two same-day multiAuthor:true corrections to
 * data/outlet-registry.json were each reverted ~20 min later by an
 * unrelated commercial-rss-poll.yml run that never touches the registry.
 *
 * Fix: reuse the exact snapshot-identity check push-core-data already
 * applies in the OPPOSITE direction (scripts/lib/core-data-sync-decision.js)
 * — a file identical to /tmp/core-data-snapshot/$f (written by checkout-
 * core-data at job start) was NOT modified by this workflow run and must be
 * excluded from the public commit too. A file that DIFFERS was genuinely
 * written by this run and stages normally.
 */
const fs = require('fs');
const path = require('path');
const { syncDecision } = require('./core-data-sync-decision');

// Files known to be BOTH core-data (private-repo-owned, gitignored) AND
// stray-tracked in the public repo's git index. Verify with:
//   git ls-files data/*.json | while read f; do grep -qxF "data/$(basename "$f")" .gitignore && echo "$f"; done
// data/opening-night-sent.json is deliberately NOT here — it's force-added
// (git add --force) as an INTENTIONAL public-repo dedup tracker across cron
// runs (see opening-night-broadcast.yml), not a stray leftover.
const DUAL_TRACKED_FILES = [
  'outlet-registry.json',
  'audience-reviews-lbo.json',
  'awards.json',
];

/**
 * @param {object} [opts]
 * @param {string} [opts.dataDir='data']
 * @param {string} [opts.snapshotDir='/tmp/core-data-snapshot']
 * @returns {string[]} repo-relative paths (e.g. "data/outlet-registry.json")
 *   that should be excluded from this run's public-repo `git add data/`.
 */
function computeExclusions({ dataDir = 'data', snapshotDir = '/tmp/core-data-snapshot' } = {}) {
  const exclusions = [];
  if (!fs.existsSync(snapshotDir)) return exclusions; // fail-open: no checkout-core-data this run

  for (const f of DUAL_TRACKED_FILES) {
    const workingPath = path.join(dataDir, f);
    const snapshotPath = path.join(snapshotDir, f);
    const workingExists = fs.existsSync(workingPath);
    const snapshotExists = fs.existsSync(snapshotPath);
    let identical = false;
    if (workingExists && snapshotExists) {
      identical = fs.readFileSync(workingPath).equals(fs.readFileSync(snapshotPath));
    }
    const decision = syncDecision({ workingExists, snapshotExists, identical });
    if (decision === 'skip-unchanged') {
      exclusions.push(`${dataDir}/${f}`);
    }
  }
  return exclusions;
}

module.exports = { computeExclusions, DUAL_TRACKED_FILES };

if (require.main === module) {
  for (const p of computeExclusions()) {
    console.log(p);
  }
}
