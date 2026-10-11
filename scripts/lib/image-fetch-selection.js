/**
 * Row selection for fetch-show-images-auto.js after the mode filters
 * (--show=, open/previews default) have run. Lives here so tests can
 * require() it: the fetcher runs main() at load.
 *
 * - --missing: drop closed rows unless includeClosed, then keep rows missing
 *   a poster or thumbnail on disk.
 * - every mode: skip rows marked noReliableArt (BRO-5022) unless retryNoArt.
 *   That includes --show= batches, which is how the imageless self-heal
 *   dispatches; without this the self-heal refilled a blanked row with the
 *   next wrong hit within hours.
 */

const { partitionNoReliableArt } = require('./no-reliable-art');

function selectShowsToFetch(shows, { onlyMissing = false, includeClosed = false, retryNoArt = false, imageOnDisk, log = () => {} } = {}) {
  let out = shows || [];
  if (onlyMissing) {
    // Closed shows are excluded by default: there are 2000+ and most will
    // never have images online (3+ hours instead of ~25 min). --include-closed
    // is for explicit historical backfill runs.
    if (!includeClosed) {
      const before = out.length;
      out = out.filter(s => s.status !== 'closed');
      log(`Excluding ${before - out.length} closed shows (use --include-closed to override)`);
    }
    // imageOnDisk() is the shared predicate (scripts/lib/show-images.js): a path
    // in shows.json counts only when the file exists AND is not a known
    // placeholder (the-gin-game-2026 phantom-path class, 2026-07-31).
    out = out.filter(s => !imageOnDisk(s.images?.poster) || !imageOnDisk(s.images?.thumbnail));
    log(`Processing only shows with missing images: ${out.length}`);
  }
  let skippedNoArt = [];
  if (!retryNoArt) {
    const { kept, skipped } = partitionNoReliableArt(out);
    if (skipped.length) {
      log(`Skipping ${skipped.length} show(s) marked noReliableArt (use --retry-no-art to search them again): ${skipped.slice(0, 10).map(s => s.id).join(', ')}${skipped.length > 10 ? ', ...' : ''}`);
    }
    out = kept;
    skippedNoArt = skipped;
  }
  return { shows: out, skippedNoArt };
}

module.exports = { selectShowsToFetch };
