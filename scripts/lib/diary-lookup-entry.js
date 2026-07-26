/**
 * Build-time mirror of the pure helpers in src/lib/stats/ that
 * scripts/generate-diary-data.js needs.
 *
 * WHY A MIRROR: the canonical implementations are TypeScript
 * (src/lib/stats/venue-match.ts, src/lib/stats/parse.ts) and the generator is
 * a plain CommonJS script in the `prebuild` chain, which has no TS loader.
 * This is the same shape as scripts/lib/compute-critic-score.js mirroring
 * engine.ts.
 *
 * KEEP IT THIN. Every function here is a line-for-line port, and
 * tests/unit/stats-diary-lookup-entry.test.mjs diffs this file against the
 * TypeScript originals over the whole real venue corpus — if they drift, that
 * test fails. Add logic to the TS side first, then port it here.
 */

/** Port of src/lib/stats/venue-match.ts::normalizeVenueKey (FROZEN behavior). */
function normalizeVenueKey(venue) {
  if (!venue) return '';
  return venue
    .trim()
    .toLowerCase()
    .replace(/\s*\(.*\)$/, '')
    .replace(/ theatre$| theater$/, '');
}

/** Port of src/lib/stats/venue-match.ts::normalizeForMatch. */
function normalizeForMatch(venue) {
  const base = normalizeVenueKey(venue);
  if (!base) return '';
  return base
    .replace(/[‘’ʼʹ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/,.*$/, '')
    .replace(/ theatre$| theater$/, '')
    .replace(/\./g, '')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Port of src/lib/stats/parse.ts::parseRuntimeMinutes. */
function parseRuntimeMinutes(runtime) {
  if (runtime === null || runtime === undefined) return null;
  if (typeof runtime === 'number') {
    return Number.isFinite(runtime) && runtime > 0 ? Math.round(runtime) : null;
  }
  const s = String(runtime).trim().toLowerCase();
  if (!s) return null;

  const hours = s.match(/(\d+(?:\.\d+)?)\s*(?:h\b|hr\b|hrs\b|hour|hours)/);
  const mins = s.match(/(\d+)\s*(?:m\b|min\b|mins\b|minute|minutes)/);
  if (hours || mins) {
    const total =
      (hours ? parseFloat(hours[1]) * 60 : 0) + (mins ? parseInt(mins[1], 10) : 0);
    return total > 0 ? Math.round(total) : null;
  }

  const bare = s.match(/^\d+(?:\.\d+)?$/);
  if (bare) {
    const n = parseFloat(bare[0]);
    return n > 0 ? Math.round(n) : null;
  }
  return null;
}

/**
 * Additive stats fields for one diary-lookup.json entry.
 *
 * `rtm` — runtime in MINUTES (parsed integer), omitted when unknown. Named
 *        rtm, not rt: mobile-shows.json already uses `rt` for the RAW runtime
 *        value (a display string), and reusing the key with a new type would
 *        mislead shared compact-artifact consumers. Consumers apply the
 *        2h30m-musical / 2h-play fallback themselves (see resolveRuntimeMinutes)
 *        rather than baking a guess into the artifact.
 * `vk` — normalized venue match key, omitted when the show has no venue. This
 *        is what src/lib/stats matches against data/theater-metadata.json, so
 *        shipping it precomputed keeps the client off the normalizer.
 */
function statsFieldsFor(show) {
  const fields = {};
  const rt = parseRuntimeMinutes(show.runtime != null ? show.runtime : show.runtimeMinutes);
  if (rt !== null) fields.rtm = rt;
  const vk = normalizeForMatch(show.venue);
  if (vk) fields.vk = vk;
  return fields;
}

module.exports = {
  normalizeVenueKey,
  normalizeForMatch,
  parseRuntimeMinutes,
  statsFieldsFor,
};
