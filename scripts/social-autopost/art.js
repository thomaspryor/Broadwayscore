/**
 * Pick the sharpest artwork for a show and decide how the card may use it.
 *
 * The 2026 social cards were blurry because they stretched 300x450 site
 * posters. This module never upscales: it fetches the ORIGINAL source file
 * (data/image-sources.json, Contentful query params stripped) and measures it.
 *
 *   layout 'keyart'  square key art >= MIN_KEYART_PX, shown full-bleed 1080x1080
 *   layout 'inset'   smaller art shown at native size over a blurred copy of itself
 *   layout 'type'    no usable art: typographic card
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MIN_KEYART_PX = 1000; // the card shows key art 1080 CSS px wide; 1000+ looks sharp
const MIN_INSET_PX = 400;
const FETCH_TIMEOUT_MS = 20000;

function loadImageSources() {
  const p = path.join(ROOT, 'data', 'image-sources.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

/** Original-resolution URL: Contentful serves the uploaded master when given no transform params. */
function originalUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname === 'images.ctfassets.net') return `${u.origin}${u.pathname}`;
    return url;
  } catch { return null; }
}

/** Candidate sources in preference order. Local files are the site's resized copies (last resort). */
function candidatesFor(show, sources) {
  const src = sources[show.id] || {};
  const out = [];
  if (src.thumbnail) out.push({ role: 'square', url: originalUrl(src.thumbnail) });
  if (src.poster) out.push({ role: 'poster', url: originalUrl(src.poster) });
  if (src.hero) out.push({ role: 'hero', url: originalUrl(src.hero) });
  const imgs = show.images || {};
  for (const role of ['thumbnail', 'poster', 'hero']) {
    if (imgs[role] && imgs[role].startsWith('/')) out.push({ role: role === 'thumbnail' ? 'square' : role, file: path.join(ROOT, 'public', imgs[role]) });
  }
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

/**
 * Pure layout decision from measured candidates ({role, width, height}).
 * Exported for tests.
 */
function chooseLayout(measured) {
  const square = measured.find(m => m.role === 'square' && Math.abs(m.width - m.height) <= m.width * 0.02 && Math.min(m.width, m.height) >= MIN_KEYART_PX);
  if (square) return { layout: 'keyart', pick: square };
  // Largest remaining art by short side, shown at no more than its native size.
  const usable = measured.filter(m => Math.min(m.width, m.height) >= MIN_INSET_PX)
    .sort((a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height));
  if (usable.length) return { layout: 'inset', pick: usable[0] };
  return { layout: 'type', pick: null };
}

/**
 * Resolve artwork for a show. Returns {layout, dataUri, width, height, role, source}.
 * Images are re-encoded as high-quality JPEG/PNG data URIs so the renderer needs no network.
 */
async function resolveArt(show, { sources = loadImageSources(), checkArt: check = checkArt } = {}) {
  const sharp = require('sharp');
  const measured = [];
  const seenRoles = new Set();
  for (const c of candidatesFor(show, sources)) {
    // One remote try per role; the local copy is only a fallback for a failed fetch.
    if (c.file && seenRoles.has(c.role)) continue;
    const buf = await loadBuffer(c);
    if (!buf) continue;
    try {
      const meta = await sharp(buf).metadata();
      if (!meta.width || !meta.height) continue;
      measured.push({ role: c.role, width: meta.width, height: meta.height, buf, source: c.url || path.relative(ROOT, c.file) });
      seenRoles.add(c.role);
    } catch { /* not an image */ }
  }
  const { layout, pick } = chooseLayout(measured);
  if (!pick) return { layout, dataUri: null };
  // Title-matched sources sometimes carry another production's poster (the 2026
  // West End Cherry Orchard had the 2016 Broadway one). A wrong poster on five
  // networks is worse than none: only art the vision check confirms is used.
  const verdict = await check(show, pick.buf);
  if (!verdict.ok) {
    console.log(`  [art] ${show.id}: ${pick.role} art not confirmed (${verdict.reason}); using the typographic card`);
    return { layout: 'type', dataUri: null, rejected: { source: pick.source, reason: verdict.reason } };
  }
  // Re-encode to PNG at native size: lossless, and Chromium decodes it everywhere.
  const png = await require('sharp')(pick.buf).rotate().png().toBuffer();
  return {
    layout,
    role: pick.role,
    width: pick.width,
    height: pick.height,
    source: pick.source,
    dataUri: `data:image/png;base64,${png.toString('base64')}`,
  };
}

/**
 * Gemini vision check shared with the site's image pipeline (scripts/lib/verify-image.js).
 * Only a positive match passes: a low-confidence "no", an API error or a missing
 * GEMINI_API_KEY all fall back to the typographic card.
 */
async function checkArt(show, buf, { verify = require('../lib/verify-image') } = {}) {
  const r = await verify.verifyImage(buf, show.title, {
    market: show.category, venue: show.venue, openingDate: show.openingDate,
    creatives: verify.creativesForVerify(show), mimeType: 'image/png',
  });
  return artVerdict(r);
}

/** Pure: verifyImage result -> {ok, reason}. Exported for tests. */
function artVerdict(r) {
  if (!r || r.skipped) return { ok: false, reason: 'not verified (no GEMINI_API_KEY)' };
  if (r.match === true) return { ok: true, reason: 'match' };
  return { ok: false, reason: `${r.confidence || 'unknown'}: ${String(r.description || (r.issues || []).join(',')).slice(0, 160)}` };
}

module.exports = { resolveArt, artVerdict, chooseLayout, originalUrl, MIN_KEYART_PX, MIN_INSET_PX };
