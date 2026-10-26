/**
 * Pick the show's poster for the card (design D4, chosen by the owner 2026-10-25).
 *
 * The 2026 social cards were blurry because they stretched 300x450 site posters.
 * This module never upscales: it fetches the ORIGINAL poster (data/image-sources.json,
 * Contentful transform params stripped), measures it, and accepts it only when it
 * is a portrait poster at least MIN_POSTER_WIDTH wide (the card shows it 480 px wide).
 * A Gemini vision check (the site's own scripts/lib/verify-image.js) must also
 * confirm it belongs to this production. Otherwise the card uses a typographic poster.
 */

const fs = require('fs');
const path = require('path');
const { loadImageSources } = require('../lib/image-sources-store');

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

/** Poster candidates, best first: the original source file, then the site's own copy. */
function candidatesFor(show, sources) {
  const src = sources[show.id] || {};
  const out = [];
  if (src.poster) out.push({ url: originalUrl(src.poster) });
  const local = show.images && show.images.poster;
  if (local && local.startsWith('/')) out.push({ file: path.join(ROOT, 'public', local) });
  return out;
}

async function loadBuffer(c) {
  if (c.file) return fs.existsSync(c.file) ? fs.readFileSync(c.file) : null;
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
async function resolvePoster(show, { sources = loadImageSources(), check = checkArt } = {}) {
  const sharp = require('sharp');
  const reasons = [];
  for (const c of candidatesFor(show, sources)) {
    const buf = await loadBuffer(c);
    const where = c.url || path.relative(ROOT, c.file);
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

module.exports = { resolvePoster, isUsablePoster, artVerdict, originalUrl, MIN_POSTER_WIDTH };
