/**
 * Decides whether a gather-reviews.js run should trigger a full
 * rebuild-all-reviews.js pass. A no-op run (bad --shows= id, zero files
 * collected/updated) has nothing new for the rebuild to fold in, so skipping
 * it avoids an unnecessary write to the private data repo and the stale-clone
 * rebuild hazard (memory/feedback_local_rebuild_stale_clone_hazard.md).
 *
 * @param {Array<{filesCreated?: number}>} results - per-show results from gather-reviews.js main()
 * @returns {boolean} true if at least one show produced/updated a review file
 */
function shouldTriggerRebuild(results) {
  if (!Array.isArray(results)) return false;
  return results.some(r => (r && r.filesCreated) > 0);
}

module.exports = { shouldTriggerRebuild };
