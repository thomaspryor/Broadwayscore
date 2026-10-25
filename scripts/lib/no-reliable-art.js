/**
 * "No reliable art" marker for shows.json rows (BRO-5022).
 *
 * The title-only Google Images search for a closed show returns same-title
 * films, other companies' stagings and later revivals. When every candidate
 * fails the strict work/production check, the right answer is no art. Before
 * this marker, a blanked row went straight back into the --missing sweep and
 * the imageless self-heal, which re-ran the same search within hours and
 * filled the row with the next wrong hit (endgame-west-end-2020,
 * noises-off-west-end-2019, the-greatest-play-...-west-end-2019).
 * rejectedImageUrls only blocks exact sources, so it could not stop that.
 *
 * Shape on the show row:
 *   noReliableArt: { at: "2026-10-11", reason: "...", key: "<fingerprint>" }
 *
 * The marker holds while the fields the search is built from (title, venue,
 * opening date) are unchanged. Change any of them, delete the marker, or run
 * fetch-show-images-auto.js with --retry-no-art, and the row is searched again.
 */

function norm(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// What a new search would be built from. A corrected title/venue/date means
// the old rejections no longer say anything about the new search.
function noArtFingerprint(show) {
  const s = show || {};
  return [norm(s.title), norm(s.venue), String(s.openingDate || '').slice(0, 10)].join('|');
}

function buildNoReliableArtMarker(show, { reason, now = new Date() } = {}) {
  return {
    at: new Date(now).toISOString().slice(0, 10),
    reason: String(reason || 'every candidate failed the work/production check').slice(0, 300),
    key: noArtFingerprint(show),
  };
}

// True when the row carries a marker that still applies to its current fields.
function hasActiveNoArtMarker(show) {
  const m = show && show.noReliableArt;
  if (!m || typeof m !== 'object') return false;
  if (typeof m.key !== 'string' || !m.key) return false;
  return m.key === noArtFingerprint(show);
}

// Which tier runs in strict mode: the title-only Google Images search for a
// show that has closed. Open shows have current, findable art and their own
// structured sources; the closed historical rows are where same-title noise wins.
function isStrictGoogleShow(show) {
  return !!show && show.status === 'closed';
}

/**
 * Should this run write the marker? Only on positive evidence that the search
 * finds nothing reliable: the strict tier ran, rejected at least one candidate
 * on its merits, never failed for verifier/search reasons, and nothing at all
 * was accepted from any tier.
 */
function shouldMarkNoReliableArt({ strict, strictRejected = 0, strictErrored = 0, searchErrored = false, accepted = false } = {}) {
  if (!strict || accepted || searchErrored) return false;
  if (strictErrored > 0) return false;
  return strictRejected > 0;
}

// What one fetch run means for the row's marker: 'clear' (art found, old
// marker), 'mark' (strict tier rejected everything and the row has no art at
// all), or null. A row still holding art from before (one slot being filled)
// is never marked.
function noArtOutcome(show, images, tally) {
  if (images && (images.thumbnail || images.poster)) return show.noReliableArt ? 'clear' : null;
  const cur = show.images || {};
  if (cur.poster || cur.thumbnail) return null;
  if (!tally) return null;
  return shouldMarkNoReliableArt({
    strict: isStrictGoogleShow(show),
    strictRejected: tally.rejected,
    strictErrored: tally.errored,
    searchErrored: tally.searchErrored,
    accepted: tally.accepted > 0,
  }) ? 'mark' : null;
}

// Selection filter for every fetch mode: marked rows are not searched again.
function partitionNoReliableArt(shows) {
  const kept = [];
  const skipped = [];
  for (const s of shows || []) (hasActiveNoArtMarker(s) ? skipped : kept).push(s);
  return { kept, skipped };
}

// Shape check for a hand-written marker (execute-approved-fix data-edit).
function validateNoReliableArtValue(value, show) {
  if (value === null) return null; // clearing is always allowed
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'noReliableArt must be an object or null';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value.at || ''))) return 'noReliableArt.at must be YYYY-MM-DD';
  if (!value.reason || typeof value.reason !== 'string') return 'noReliableArt.reason is required';
  if (show && value.key !== noArtFingerprint(show)) return `noReliableArt.key must be "${noArtFingerprint(show)}" for this row`;
  return null;
}

module.exports = {
  noArtFingerprint,
  buildNoReliableArtMarker,
  hasActiveNoArtMarker,
  isStrictGoogleShow,
  shouldMarkNoReliableArt,
  noArtOutcome,
  partitionNoReliableArt,
  validateNoReliableArtValue,
};
