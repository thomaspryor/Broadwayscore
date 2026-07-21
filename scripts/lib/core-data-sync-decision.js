/**
 * Decision table for push-core-data's "Sync core data files to checkout" step.
 *
 * The composite action .github/actions/push-core-data/action.yml decides, per
 * core data file, whether to copy data/$f (the workflow's working copy) into
 * /tmp/core-data-checkout (the private-repo clone that gets committed+pushed).
 *
 * Baseline: /tmp/core-data-snapshot/$f — written by checkout-core-data at
 * workflow START. A file identical to its snapshot was NOT modified by this
 * workflow, so it must NOT be copied: copying it would push back content that
 * is stale by the workflow's entire runtime, silently reverting any concurrent
 * push that landed mid-run (incident 2026-07-13: fetch-guardian-reviews
 * reverted a just-pushed commercial.json fix it never touched).
 *
 * The action implements this table in bash (cmp -s); this module is the
 * canonical, tested mirror of that logic (CLAUDE.md §15). If you change one,
 * change both — tests/unit/core-data-sync-decision.test.mjs pins the table.
 *
 * Downstream consumer (card #268): the action also writes a
 * /tmp/.core-data-changed-files manifest listing every file that resolved to
 * 'copy-changed' or 'copy-new' here. The post-rebase reconciliation merge for
 * commercial.json/diary-shows.json only runs for files in that manifest —
 * merging a workflow's untouched (and possibly stale) "ours" copy against
 * remote can silently revert a concurrent fix. If you add a new branch here,
 * make sure the bash mirror's manifest-append still lines up with it.
 *
 * Note: the action-level failsafe (whole /tmp/core-data-snapshot directory
 * missing → copy-all with ::warning::) is deliberately NOT part of this
 * per-file table; it bypasses it entirely.
 *
 * @param {object} input
 * @param {boolean} input.workingExists  data/$f exists in the workflow workspace
 * @param {boolean} input.snapshotExists /tmp/core-data-snapshot/$f exists
 * @param {boolean} input.identical     working copy is byte-identical to snapshot
 *                                      (only meaningful when both exist)
 * @returns {'copy-changed'|'copy-new'|'skip-unchanged'|'skip-missing'}
 */
function syncDecision({ workingExists, snapshotExists, identical }) {
  if (!workingExists) {
    // File absent from data/ (e.g. reverted by `git checkout -- .`). Never
    // fall back to copying the snapshot: it is a point-in-time copy that can
    // also revert concurrent pushes, and is a content no-op at best.
    return 'skip-missing';
  }
  if (!snapshotExists) {
    // New file created during this run — nothing to diff against, ship it.
    return 'copy-new';
  }
  if (identical) {
    // Workflow never touched it — copying would revert concurrent pushes.
    return 'skip-unchanged';
  }
  return 'copy-changed';
}

module.exports = { syncDecision };
