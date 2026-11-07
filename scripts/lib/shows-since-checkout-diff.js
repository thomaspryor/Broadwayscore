/**
 * Diff data/shows.json's current (post-mutation) state against the pre-run
 * baseline, to answer two questions for update-show-status.yml's discovery
 * gate (task #1439):
 *
 *   1. Which show IDs did THIS run touch at all? (candidateIds for
 *      evaluatePerShowCommitDecision, scripts/lib/validation-setdiff.js)
 *   2. Given a set of blocked IDs, what should shows.json look like with
 *      just those IDs' changes undone?
 *
 * update-show-status.yml runs ~8 separate node processes across separate
 * workflow steps (discover-new-shows.js, update-show-status.js, and half a
 * dozen continue-on-error enrichment scripts) that each mutate shows.json
 * independently — unlike scripts/enrich-ibdb-dates.js, which does its own
 * snapshot-before-mutate in a single process (see its preChangeSnapshots
 * Map). There is no single process here to hold a snapshot, but the
 * workflow already has one on disk: `.github/actions/checkout-core-data`
 * copies shows.json from the private core-data repo into data/ at job
 * start AND saves an untouched copy at /tmp/core-data-snapshot/shows.json
 * specifically so later steps can tell what THIS run changed (the same
 * snapshot push-core-data's sync-decision table diffs against — see
 * scripts/lib/core-data-sync-decision.js). data/shows.json itself is
 * gitignored in this repo (checked: `git ls-files data/shows.json` returns
 * nothing) — it is NEVER committed to this repo's git history, so `git show
 * HEAD:data/shows.json` is not a usable baseline here.
 */

const fs = require('fs');

const DEFAULT_SNAPSHOT_PATH = '/tmp/core-data-snapshot/shows.json';

function loadBaselineShows(snapshotPath = DEFAULT_SNAPSHOT_PATH) {
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).shows;
}

// Every show ID that differs between the pre-run baseline and the current
// working-tree state — added, removed, or field-level changed. Order-
// independent; used as candidateIds so ANY step's mutation (not just
// discovery/status-transition) is eligible for per-show attribution.
function computeChangedShowIds(baselineShows, currentShows) {
  const baselineById = new Map(baselineShows.map((s) => [s.id, s]));
  const currentById = new Map(currentShows.map((s) => [s.id, s]));
  const changed = new Set();

  for (const [id, show] of currentById) {
    const before = baselineById.get(id);
    if (!before || JSON.stringify(before) !== JSON.stringify(show)) changed.add(id);
  }
  for (const id of baselineById.keys()) {
    if (!currentById.has(id)) changed.add(id);
  }
  return [...changed];
}

// Undo this run's changes for exactly the blocked IDs, leaving every other
// show's changes intact. A blocked ID present in the baseline reverts to its
// baseline object (whatever this run did to it — enrichment, status flip,
// etc. — is discarded). A blocked ID absent from the baseline was created
// fresh this run (discover-new-shows.js) — there is nothing to revert to,
// so it is removed entirely.
function revertOrRemoveShows(currentShows, baselineShows, idsToRevert) {
  const baselineById = new Map(baselineShows.map((s) => [s.id, s]));
  const revertSet = new Set(idsToRevert);
  const next = [];
  for (const show of currentShows) {
    if (!revertSet.has(show.id)) {
      next.push(show);
      continue;
    }
    const baseline = baselineById.get(show.id);
    if (baseline) next.push(JSON.parse(JSON.stringify(baseline)));
    // else: new-this-run show being held back — drop it.
  }
  return next;
}

module.exports = {
  DEFAULT_SNAPSHOT_PATH,
  loadBaselineShows,
  computeChangedShowIds,
  revertOrRemoveShows,
};
