'use strict';

/**
 * Card formats from one piece of regional key art (moved out of
 * fetch-show-images-auto.js for BRO-7265 so the hand-verified path,
 * scripts/apply-verified-key-art.js, writes the same formats).
 *
 * Portrait card (poster/thumbnail) from arbitrary key art. Venue og:images
 * are usually landscape title-art; a straight 2:3 attention-crop amputates
 * the title ("BLACK SWAN" -> "BLAC SWA", user report 2026-07-12). Strategy:
 *   - trim uniform borders (white-background promo shoots read as whitespace
 *     in small cards otherwise);
 *   - source close to the card's shape (cardFit) -> tight cover/attention crop;
 *   - anything else -> CONTAIN the full art over a blurred,
 *     darkened cover of itself (the standard letterbox-poster treatment) so
 *     no text is ever cut.
 */
// BRO-7265: cover-crop only when the crop keeps most of the art. The old rule
// (poster: cover any w/h <= 0.85; hero: always cover) cut a 4:5 poster's sides
// by 17% ("No Exit" -> "o Exit", Kaiju's credits) and turned every portrait
// poster into a hero strip of its middle. Otherwise the whole art is
// letterboxed over a blurred, darkened fill of itself.
const KEEP_WIDER = 0.925; // source wider than the card: keep >= 92.5% of its width
const KEEP_NARROWER = 0.8; // source narrower than the card: keep >= 80% of its height

/** 'cover' (crop to fill) or 'contain' (whole art over a blurred fill) for source ratio w/h into a card of ratio target. */
function cardFit(ratio, target) {
  if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(target) || target <= 0) return 'contain';
  const kept = ratio >= target ? target / ratio : ratio / target;
  return kept >= (ratio >= target ? KEEP_WIDER : KEEP_NARROWER) ? 'cover' : 'contain';
}

async function fitCard(sharpLib, buffer, w, h, quality, { trim = true } = {}) {
  let src = buffer;
  if (trim) {
    try {
      const trimmed = await sharpLib(buffer).trim({ threshold: 25 }).toBuffer({ resolveWithObject: true });
      // Only adopt the trim when it kept a meaningful image (guards against
      // aggressive trims of low-contrast art collapsing to slivers).
      if (trimmed.info.width > 200 && trimmed.info.height > 200) src = trimmed.data;
    } catch { /* keep original */ }
  }
  const meta = await sharpLib(src).metadata();
  const ratio = (meta.width || 1) / (meta.height || 1);
  if (cardFit(ratio, w / h) === 'cover') {
    return sharpLib(src).resize(w, h, { fit: 'cover', position: 'attention' }).webp({ quality }).toBuffer();
  }
  const pad = Math.round(Math.min(w, h) * 0.05);
  const bg = await sharpLib(src).resize(w, h, { fit: 'cover' }).blur(30).modulate({ brightness: 0.5, saturation: 1.15 }).toBuffer();
  const fg = await sharpLib(src).resize(w - pad, h - pad, { fit: 'inside' }).toBuffer();
  return sharpLib(bg).composite([{ input: fg, gravity: 'centre' }]).webp({ quality }).toBuffer();
}

/** Portrait card (poster/thumbnail). */
function portraitCardFromKeyArt(sharpLib, buffer, w, h, quality) {
  return fitCard(sharpLib, buffer, w, h, quality);
}

/** The /images/shows/<id>/ paths the regional formats are written to. */
function regionalLocalPaths(showId) {
  return {
    poster: `/images/shows/${showId}/poster.webp`,
    thumbnail: `/images/shows/${showId}/thumbnail.webp`,
    hero: `/images/shows/${showId}/hero.webp`,
  };
}

/** Write poster (480x720), thumbnail (300x450) and hero (1600x1000) webp files into dir. */
async function writeRegionalFormats(sharpLib, buffer, dir, fsImpl = require('fs'), pathImpl = require('path')) {
  fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.writeFileSync(pathImpl.join(dir, 'poster.webp'), await portraitCardFromKeyArt(sharpLib, buffer, 480, 720, 82));
  fsImpl.writeFileSync(pathImpl.join(dir, 'thumbnail.webp'), await portraitCardFromKeyArt(sharpLib, buffer, 300, 450, 80));
  fsImpl.writeFileSync(pathImpl.join(dir, 'hero.webp'), await fitCard(sharpLib, buffer, 1600, 1000, 82, { trim: false }));
}

module.exports = { cardFit, fitCard, portraitCardFromKeyArt, regionalLocalPaths, writeRegionalFormats };
