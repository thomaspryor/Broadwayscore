/**
 * Pick the show's poster for the card (design D4, chosen by the owner 2026-10-25).
 *
 * The 2026 social cards were blurry because they stretched 300x450 site posters.
 * This module never upscales: it fetches the ORIGINAL poster (a full-size original from
 * data/full-size-posters.json first, then data/image-sources.json, Contentful transform
 * params stripped; size rules live in scripts/lib/full-size-poster.js), measures it, and accepts it only when it
 * is a portrait poster at least MIN_POSTER_WIDTH wide (the card shows it 480 px wide).
 * When that file has none, TodayTix's own 480x720 poster for the show's todaytixId is
 * tried, then the Mezzanine art the site's image pipeline matches to this production
 * (scripts/lib/image-source-match.js), then the site's copy (most London and older
 * shows only have a small one). The minimum width follows how wide the layout shows
 * the poster (minPosterWidth): never more than a 10% stretch.
 * A Gemini vision check (the site's own scripts/lib/verify-image.js) must also
 * confirm it belongs to this production. Otherwise the card uses a typographic poster.
 */

const path = require('path');
const { loadImageSources } = require('../lib/image-sources-store');
const fs = require('fs');
const { normalizeMezzTitle, buildMezzIndex, pickMezzanineCandidate, buildVenueCityIndex, normalizeVenueName, venuesMatch, isRejectedImage } = require('../lib/image-source-match');
const {
  MIN_POSTER_WIDTH, originalUrl, isUsablePoster, artVerdict, verifyPosterArt,
  posterCandidates, loadPosterBuffer, loadFullSizePostersSafe, sameTitle,
} = require('../lib/full-size-poster');

const ROOT = path.resolve(__dirname, '..', '..');
const MAX_STRETCH = 1.1;
/** Narrowest original that a poster shown `displayPx` wide may use (no more than a 10% stretch). */
const minPosterWidth = displayPx => Math.ceil(displayPx / MAX_STRETCH);
const MEZZ_CACHE = path.join(ROOT, 'data', 'mezzanine-image-cache.json');

function loadTodaytixIds() {
  try { return require('../../data/todaytix-ids.json').shows || {}; } catch { return {}; }
}

let mezz = null;
/** Mezzanine art for this production, chosen exactly as the site's image pipeline chooses it, or null. */
function mezzanineArt(show, shows) {
  if (!mezz) {
    let records = [];
    try { records = JSON.parse(fs.readFileSync(MEZZ_CACHE, 'utf8')).records || []; } catch { /* no cache: no candidate */ }
    mezz = { byTitle: buildMezzIndex(records), venueCity: buildVenueCityIndex(shows || []) };
  }
  const { candidate } = pickMezzanineCandidate(show, mezz.byTitle.get(normalizeMezzTitle(show.title || '')), mezz.venueCity);
  if (!candidate || isRejectedImage({ poster: candidate.artUrl }, show)) return null;
  // A compare card sets both cities' art side by side and the two posters often look alike,
  // so the art must come from this show's own theatre or a theatre known to be in its city.
  const city = /west-end/.test(show.category) ? 'london' : 'nyc';
  if (!venuesMatch(candidate.theater, show.venue) && mezz.venueCity.get(normalizeVenueName(candidate.theater)) !== city) return null;
  return candidate.artUrl;
}

/**
 * Poster candidates, best first: a full-size original found by
 * `fetch-show-images-auto.js --full-size-posters` (BRO-6393), the original
 * source file, TodayTix, Mezzanine (only when asked: brief cards, whose smaller
 * poster slot its art fits), then the site's own copy.
 */
function candidatesFor(show, sources, shows, { mezzanine = false, fullSize = {}, todaytixIds = {} } = {}) {
  const out = posterCandidates(show, { sources, fullSize, todaytixIds });
  const art = mezzanine ? mezzanineArt(show, shows) : null;
  if (art && !out.some(c => c.url === art)) {
    const local = out.findIndex(c => c.file);
    out.splice(local === -1 ? out.length : local, 0, { url: art });
  }
  return out;
}

/** Gemini vision check shared with the site's image pipeline. */
const checkArt = (show, buf) => verifyPosterArt(show, buf);

/**
 * Resolve the poster. Returns {poster: true, dataUri, width, height, source} or
 * {poster: false, reason}. The image is re-encoded as PNG at native size so the
 * renderer needs no network.
 */
async function resolvePoster(show, { sources = loadImageSources(), fullSize = loadFullSizePostersSafe(), todaytixIds = loadTodaytixIds(), check = checkArt, minWidth = MIN_POSTER_WIDTH, shows = loadShows(), mezzanine = false } = {}) {
  const sharp = require('sharp');
  const reasons = [];
  for (const c of candidatesFor(show, sources, shows, { mezzanine, fullSize, todaytixIds })) {
    const buf = await loadPosterBuffer(c);
    const where = c.url || (c.file ? path.relative(ROOT, c.file) : `todaytix show ${c.todaytixId}`);
    if (!buf) { reasons.push(`${where}: not fetched`); continue; }
    let meta;
    try { meta = await sharp(buf).metadata(); } catch { reasons.push(`${where}: not an image`); continue; }
    if (!isUsablePoster(meta, minWidth)) { reasons.push(`${where}: ${meta.width}x${meta.height} too small or not a poster`); continue; }
    const png = await sharp(buf).rotate().png().toBuffer();
    const verdict = await check(show, png);
    if (!verdict.ok) { reasons.push(`${where}: art not confirmed (${verdict.reason})`); continue; }
    return { poster: true, width: meta.width, height: meta.height, source: where, dataUri: `data:image/png;base64,${png.toString('base64')}` };
  }
  return { poster: false, reason: reasons.join(' | ') || 'no poster on file' };
}

let showsCache = null;
function loadShows() {
  if (!showsCache) {
    try { const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8')); showsCache = raw.shows || raw; } catch { showsCache = []; }
  }
  return showsCache;
}

module.exports = { resolvePoster, isUsablePoster, artVerdict, originalUrl, candidatesFor, sameTitle, minPosterWidth, MIN_POSTER_WIDTH };
