/**
 * Pick the show's poster for the card (design D4, chosen by the owner 2026-10-25).
 *
 * The 2026 social cards were blurry because they stretched 300x450 site posters.
 * This module never upscales: it fetches the ORIGINAL poster (data/image-sources.json,
 * Contentful transform params stripped), measures it, and accepts it only when it
 * is a portrait poster at least MIN_POSTER_WIDTH wide (the card shows it 480 px wide).
 * When that file has none, TodayTix's own 480x720 poster for the show's todaytixId is
 * tried, then the Mezzanine art the site's image pipeline matches to this production
 * (scripts/lib/image-source-match.js), then the site's copy (most London and older
 * shows only have a small one). The minimum width follows how wide the layout shows
 * the poster (minPosterWidth): never more than a 10% stretch.
 * A Gemini vision check (the site's own scripts/lib/verify-image.js) must also
 * confirm it belongs to this production. Otherwise the card uses a typographic poster.
 */

const fs = require('fs');
const path = require('path');
const { loadImageSources } = require('../lib/image-sources-store');
const { foldDiacritics } = require('../lib/title-match');
const { normalizeMezzTitle, buildMezzIndex, pickMezzanineCandidate, buildVenueCityIndex, normalizeVenueName, venuesMatch, isRejectedImage } = require('../lib/image-source-match');

const ROOT = path.resolve(__dirname, '..', '..');
const MIN_POSTER_WIDTH = 440; // score card: shown at 480 px, at most a 9% stretch, invisible
const MAX_STRETCH = 1.1;
/** Narrowest original that a poster shown `displayPx` wide may use (no more than a 10% stretch). */
const minPosterWidth = displayPx => Math.ceil(displayPx / MAX_STRETCH);
const MEZZ_CACHE = path.join(ROOT, 'data', 'mezzanine-image-cache.json');
const POSTER_RATIO = { min: 0.6, max: 0.72 }; // width / height; 2:3 is 0.667
const FETCH_TIMEOUT_MS = 20000;

/** Original-resolution URL: Contentful serves the uploaded master when given no transform params. */
function originalUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname === 'images.ctfassets.net') return `${u.origin}${u.pathname}`;
    return url;
  } catch { return null; }
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
 * Poster candidates, best first: the original source file, TodayTix, Mezzanine (only when
 * asked: brief cards, whose smaller poster slot its art fits), then the site's own copy.
 */
function candidatesFor(show, sources, shows, { mezzanine = false } = {}) {
  const src = sources[show.id] || {};
  const out = [];
  if (src.poster) out.push({ url: originalUrl(src.poster) });
  if (show.todaytixId) out.push({ todaytixId: show.todaytixId, title: show.title });
  const art = mezzanine ? mezzanineArt(show, shows) : null;
  if (art && !out.some(c => c.url === art)) out.push({ url: art });
  const local = show.images && show.images.poster;
  if (local && local.startsWith('/')) out.push({ file: path.join(ROOT, 'public', local) });
  return out;
}

/** TodayTix's poster URL for a show id (public API, the same one scripts/fetch-show-images-auto.js uses). */
/** Loose title match, so a recycled TodayTix id cannot supply another show's poster. */
function sameTitle(a, b) {
  const norm = t => foldDiacritics(String(t || '')).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

async function todaytixPosterUrl(id, title) {
  try {
    const res = await fetch(`https://api.todaytix.com/api/v2/shows/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()).data || {};
    if (!sameTitle(data.name || data.displayName, title)) return null;
    const media = data.posterMedia;
    return media && media.imageUrl ? originalUrl(media.imageUrl) : null;
  } catch { return null; }
}

async function loadBuffer(c) {
  if (c.file) return fs.existsSync(c.file) ? fs.readFileSync(c.file) : null;
  if (c.todaytixId) {
    c.url = await todaytixPosterUrl(c.todaytixId, c.title);
    if (!c.url) return null;
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(c.url, { signal: ctl.signal, headers: { 'User-Agent': 'BroadwayScorecard-social/1.0' } });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; } finally { clearTimeout(t); }
}

/** Pure: is a measured image usable as the card's poster? Exported for tests. */
function isUsablePoster({ width, height }, minWidth = MIN_POSTER_WIDTH) {
  if (!width || !height) return false;
  const r = width / height;
  return width >= minWidth && r >= POSTER_RATIO.min && r <= POSTER_RATIO.max;
}

/** Pure: verifyImage result -> {ok, reason}. Only a positive match passes. Exported for tests. */
function artVerdict(r) {
  if (!r || r.skipped) return { ok: false, reason: 'not verified (no GEMINI_API_KEY)' };
  if (r.match === true) return { ok: true, reason: 'match' };
  return { ok: false, reason: `${r.confidence || 'unknown'}: ${String(r.description || (r.issues || []).join(',')).slice(0, 160)}` };
}

// venue-write-guard-ok: show.venue is only read here (card text / vision-check context), never written back
/** Gemini vision check shared with the site's image pipeline. */
async function checkArt(show, buf) {
  const verify = require('../lib/verify-image');
  const r = await verify.verifyImage(buf, show.title, {
    market: show.category, venue: show.venue, openingDate: show.openingDate,
    creatives: verify.creativesForVerify(show), mimeType: 'image/png',
  });
  return artVerdict(r);
}

/**
 * Resolve the poster. Returns {poster: true, dataUri, width, height, source} or
 * {poster: false, reason}. The image is re-encoded as PNG at native size so the
 * renderer needs no network.
 */
async function resolvePoster(show, { sources = loadImageSources(), check = checkArt, minWidth = MIN_POSTER_WIDTH, shows = loadShows(), mezzanine = false } = {}) {
  const sharp = require('sharp');
  const reasons = [];
  for (const c of candidatesFor(show, sources, shows, { mezzanine })) {
    const buf = await loadBuffer(c);
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
