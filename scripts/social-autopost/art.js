/**
 * Pick the show's poster for the card (design D4, chosen by the owner 2026-10-25).
 *
 * The 2026 social cards were blurry because they stretched 300x450 site posters.
 * This module never upscales: it fetches the ORIGINAL poster (data/image-sources.json,
 * Contentful transform params stripped), measures it, and accepts it only when it
 * is a portrait poster at least MIN_POSTER_WIDTH wide (the card shows it 480 px wide).
 * When that file has none, TodayTix's own 480x720 poster for the show's todaytixId is
 * tried before the site's copy (many London and recent shows only have a small one).
 * A Gemini vision check (the site's own scripts/lib/verify-image.js) must also
 * confirm it belongs to this production. Otherwise the card uses a typographic poster.
 */

const fs = require('fs');
const path = require('path');
const { loadImageSources } = require('../lib/image-sources-store');
const { foldDiacritics } = require('../lib/title-match');

const ROOT = path.resolve(__dirname, '..', '..');
const MIN_POSTER_WIDTH = 440; // shown at 480 px: at most a 9% stretch, invisible
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

/**
 * The larger originals a resized image URL usually points at, best first, the
 * recorded URL last (BRO-6393): Show Score's "medium_"/"small_"/"thumb_" file
 * prefixes (147 recorded posters were 400x600 "medium_" copies of 480x720
 * originals), WordPress "-300x450" suffixes and resizer query strings removed,
 * Contentful transforms stripped.
 */
function originalVariants(url) {
  const out = [];
  const add = u => { if (u && !out.includes(u)) out.push(u); };
  let u;
  try { u = new URL(url); } catch { return out; }
  if (u.hostname === 'images.ctfassets.net') { add(originalUrl(url)); return out; }
  const pathname = u.pathname
    .replace(/\/(?:medium|small|thumb|large)_([^/]+)$/i, '/$1')
    .replace(/-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|webp))$/i, '$1');
  const resized = u.search && /[?&](w|h|width|height|resize|fit|size|crop)=/i.test(u.search);
  if (pathname !== u.pathname) add(`${u.origin}${pathname}${resized ? '' : u.search}`);
  if (resized) add(`${u.origin}${pathname}`);
  add(url);
  return out;
}

/** Poster candidates, best first: the original source file, TodayTix, then the site's own copy. */
function candidatesFor(show, sources) {
  const src = sources[show.id] || {};
  const out = [];
  if (src.poster) for (const url of originalVariants(src.poster)) out.push({ url });
  if (show.todaytixId) out.push({ todaytixId: show.todaytixId, title: show.title });
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
function isUsablePoster({ width, height }) {
  if (!width || !height) return false;
  const r = width / height;
  return width >= MIN_POSTER_WIDTH && r >= POSTER_RATIO.min && r <= POSTER_RATIO.max;
}

/** Pure: verifyImage result -> {ok, reason}. Only a positive match passes. Exported for tests. */
const VERIFIER_ERRORS = ['api_error', 'download_error', 'parse_error', 'invalid_input'];
function artVerdict(r, { strict = false } = {}) {
  if (!r || r.skipped) return { ok: false, reason: 'not verified (no GEMINI_API_KEY)' };
  // verifyImage fails OPEN on a Gemini outage (match: true + issues: ['api_error']):
  // that is no confirmation, so the card waits (BRO-6393).
  if ((r.issues || []).some(i => VERIFIER_ERRORS.includes(i))) return { ok: false, reason: `verifier error (${String(r.description || '').slice(0, 120)})` };
  if (strict) {
    const v = require('../lib/verify-image').applyStrictVerdict(r, { strict: true });
    return v.accept ? { ok: true, reason: 'confirmed' } : { ok: false, reason: `${v.reason}: ${String(r.description || '').slice(0, 140)}` };
  }
  if (r.match === true) return { ok: true, reason: 'match' };
  return { ok: false, reason: `${r.confidence || 'unknown'}: ${String(r.description || (r.issues || []).join(',')).slice(0, 160)}` };
}

// venue-write-guard-ok: show.venue is only read here (card text / vision-check context), never written back
/**
 * Gemini vision check shared with the site's image pipeline. strict: art found by
 * title search (scripts/upgrade-social-posters.js) needs positive evidence of this
 * production, the pipeline's BRO-5022 rule for title-only hits.
 */
async function checkArt(show, buf, { strict = false } = {}) {
  const verify = require('../lib/verify-image');
  const r = await verify.verifyImage(buf, show.title, {
    market: show.category, venue: show.venue, openingDate: show.openingDate,
    creatives: verify.creativesForVerify(show), mimeType: 'image/png', strict,
  });
  return artVerdict(r, { strict });
}

/**
 * Resolve the poster. Returns {poster: true, dataUri, width, height, source} or
 * {poster: false, reason}. The image is re-encoded as PNG at native size so the
 * renderer needs no network.
 */
async function resolvePoster(show, { sources = loadImageSources(), check = checkArt } = {}) {
  const sharp = require('sharp');
  const reasons = [];
  for (const c of candidatesFor(show, sources)) {
    const buf = await loadBuffer(c);
    const where = c.url || (c.file ? path.relative(ROOT, c.file) : `todaytix show ${c.todaytixId}`);
    if (!buf) { reasons.push(`${where}: not fetched`); continue; }
    let meta;
    try { meta = await sharp(buf).metadata(); } catch { reasons.push(`${where}: not an image`); continue; }
    if (!isUsablePoster(meta)) { reasons.push(`${where}: ${meta.width}x${meta.height} too small or not a poster`); continue; }
    const png = await sharp(buf).rotate().png().toBuffer();
    const verdict = await check(show, png);
    if (!verdict.ok) { reasons.push(`${where}: art not confirmed (${verdict.reason})`); continue; }
    return { poster: true, width: meta.width, height: meta.height, source: where, dataUri: `data:image/png;base64,${png.toString('base64')}` };
  }
  return { poster: false, reason: reasons.join(' | ') || 'no poster on file' };
}

module.exports = { resolvePoster, isUsablePoster, artVerdict, originalUrl, originalVariants, candidatesFor, loadBuffer, checkArt, sameTitle, MIN_POSTER_WIDTH, POSTER_RATIO };
