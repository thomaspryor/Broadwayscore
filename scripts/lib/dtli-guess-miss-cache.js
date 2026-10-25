/**
 * Short-TTL negative cache for searchDTLI's URL-guessing loop (BRO-5526).
 *
 * didtheylikeit.com 403s every direct fetch, so each guessed slug is a paid
 * Bright Data unlocker call. For an open show DTLI simply doesn't list, the
 * poller re-ran the whole guess ladder (~10-20 probes) on every tick, ~50-100
 * BD calls/show/day (2026-10-17/18: didtheylikeit.com was 1236 of the poller's
 * ~2160 daily BD calls). The cheap discovery paths (slug map, homepage scan,
 * live sitemap) still run every tick, so a newly published page is found by
 * them; only the brittle guess ladder is skipped for GUESS_MISS_TTL_MS (1h: opening-night press can land any hour) after
 * a full miss. DTLI_GUESS_CACHE_DISABLED=1 bypasses.
 */
const { createTtlCache } = require('./ttl-cache');

const GUESS_MISS_TTL_MS = 60 * 60 * 1000;
const CACHE_DIR = process.env.DTLI_GUESS_MISS_CACHE_DIR || '/tmp/dtli-guess-miss-cache';

const _cache = createTtlCache({
  dir: CACHE_DIR,
  ttlMs: GUESS_MISS_TTL_MS,
  disabled: process.env.DTLI_GUESS_CACHE_DISABLED === '1',
});

function guessedRecently(showId) {
  return !!_cache.get(`dtli-guess:${showId}`);
}

function recordGuessMiss(showId) {
  _cache.set(`dtli-guess:${showId}`, {}, { missAt: new Date().toISOString() });
}

/** A miss only counts when most probes got a real response; all-error runs (BD outage, credit cap, timeouts) must retry. */
function isDefinitiveMiss(answered, total) {
  return total > 0 && answered / total >= 0.5;
}

module.exports = { isDefinitiveMiss, guessedRecently, recordGuessMiss, GUESS_MISS_TTL_MS, createCache: createTtlCache };
