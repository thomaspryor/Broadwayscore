'use strict';

// Shared by the catalogue and scrape phases of fetch-show-images-auto.js.
// Keep expected discovery misses separate from operational failures, without
// changing which candidates the image safety checks accept.
function recordImageFetchOutcome(results, show, settled, log = () => {}) {
  const result = settled.status === 'fulfilled' ? settled.value : null;
  const title = show.title;
  if (settled.status === 'fulfilled' && result?.images) {
    results.success.push(title);
  } else if (settled.status === 'fulfilled' && result === null) {
    // processOneShow returns null only for a pinned image that it preserves.
    results.skipped.push(title);
  } else if (settled.status === 'fulfilled' && result && !result.searchErrored
      && (show.status === 'announced' || show.status === 'upcoming')) {
    // Future productions often have no published key art yet. A completed
    // search with no safe candidate is expected, including placeholder and
    // wrong-production rejections. A failed search is still a failure.
    results.unavailable.push(title);
  } else {
    results.failed.push(title);
    if (settled.status === 'rejected') log(`   ✗ ${title}: ${settled.reason?.message || settled.reason}`);
  }
}

function imageFetchRunHealth(results) {
  const attempted = results.success.length + results.failed.length + results.unavailable.length;
  const failures = results.failed.length;
  const measured = results.success.length + failures;
  if (attempted >= 10 && (results.success.length === 0 || failures / measured > 0.5)) {
    return { exitCode: 1, message: `Image discovery failed: ${failures} failures, ${results.success.length} successes, ${results.unavailable.length} future shows without art` };
  }
  return { exitCode: 0, message: '' };
}

module.exports = { recordImageFetchOutcome, imageFetchRunHealth };
