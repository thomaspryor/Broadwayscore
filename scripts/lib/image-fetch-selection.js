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
 *   next wrong hit within hours. A marker on a running or upcoming row with a TodayTix
 *   id lapses after a week (no-reliable-art.js), so launch art is not hidden for good.
 */

const { partitionNoReliableArt } = require('./no-reliable-art');

function selectShowsToFetch(shows, { onlyMissing = false, includeClosed = false, retryNoArt = false, imageOnDisk, log = () => {}, now = Date.now() } = {}) {
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
    const { kept, skipped } = partitionNoReliableArt(out, now);
    if (skipped.length) {
      log(`Skipping ${skipped.length} show(s) marked noReliableArt (use --retry-no-art to search them again): ${skipped.slice(0, 10).map(s => s.id).join(', ')}${skipped.length > 10 ? ', ...' : ''}`);
    }
    out = kept;
    skippedNoArt = skipped;
  }
  return { shows: out, skippedNoArt };
}

/**
 * May this row take art from the TodayTix catalogue API? The API lists only
 * productions on sale now, so for a row that closed long ago a title match is
 * by definition another production (BRO-5080 sample: Hairspray 2002 got the
 * 2021 London Coliseum art, Bonnie & Clyde 2011 the 2023 Garrick art, Lennon
 * 2005 a tribute concert). Running, upcoming and recently closed rows only.
 */
const TODAYTIX_RECENT_CLOSE_DAYS = 120;
function todaytixApiArtEligible(show, now = Date.now()) {
  if (!show) return false;
  if (show.status !== 'closed') return true;
  const closed = Date.parse(show.closingDate || '');
  if (Number.isNaN(closed)) return false;
  return now - closed <= TODAYTIX_RECENT_CLOSE_DAYS * 86400000;
}

module.exports = { selectShowsToFetch, todaytixApiArtEligible, TODAYTIX_RECENT_CLOSE_DAYS };
