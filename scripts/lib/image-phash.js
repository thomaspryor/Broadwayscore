'use strict';

/**
 * Perceptual signatures for show art (BRO-6995).
 *
 * Why this exists: Rope (St. Clement's) served The Lost Boys' poster. The
 * source was a Theater Diary upload under a different URL, re-encoded as a
 * small JPEG, so neither guard we had fired: scripts/lib/shared-image-source.js
 * compares source URLs and scripts/lib/duplicate-images.js compares file bytes.
 * Same art, different URL, different bytes. This module compares what the
 * picture LOOKS like.
 *
 * A signature is built per centred crop at three fixed aspects (square, 4:5,
 * 2:3). Thumbnails, posters and heroes are cover crops of one source at
 * different shapes, so two files of one source agree on the crop whose aspect
 * they share. Each crop is reduced to a 16x16 greyscale grid and stored two
 * ways:
 *   - bits: a 64-bit average hash (8x8 cells above/below the median), a cheap
 *     shortlist key;
 *   - vec: the 256 cell values, mean-centred and unit-length, so the dot
 *     product of two vecs is their Pearson correlation (1.0 = same picture,
 *     whatever the brightness, contrast, size or JPEG noise).
 * Different artwork correlates near 0.0 to 0.5; the same artwork 0.9+.
 *
 * Pure functions (CLAUDE.md §15) work on a greyscale raster
 * { data, width, height }; only grayRaster / signatureOf touch sharp.
 * Test: scripts/lib/image-phash.test.mjs.
 */

/** Centred-crop aspects (width / height) a signature is taken at. */
const ASPECTS = { sq: 1, p45: 4 / 5, p23: 2 / 3 };
const ASPECT_KEYS = Object.keys(ASPECTS);
const GRID = 16;
/** Longest edge the raster is shrunk to before measuring (sharp shrinks on load). */
const GRAY_EDGE = 128;
/** A crop whose grid cells have a standard deviation below this is flat or blank. */
const MIN_STDDEV = 6;

/** Centred crop box of aspect ar inside a w x h raster. */
function cropBox(w, h, ar) {
  let cw = w;
  let ch = h;
  if (w / h > ar) cw = Math.max(1, Math.round(h * ar));
  else ch = Math.max(1, Math.round(w / ar));
  return { x: Math.floor((w - cw) / 2), y: Math.floor((h - ch) / 2), w: cw, h: ch };
}

/** Mean grey of each GRID x GRID cell of the crop box (area average, row-major). */
function gridMeans(gray, width, box) {
  const cells = new Float64Array(GRID * GRID);
  for (let cy = 0; cy < GRID; cy++) {
    const y0 = box.y + Math.floor((cy * box.h) / GRID);
    const y1 = box.y + Math.max(Math.floor(((cy + 1) * box.h) / GRID), Math.floor((cy * box.h) / GRID) + 1);
    for (let cx = 0; cx < GRID; cx++) {
      const x0 = box.x + Math.floor((cx * box.w) / GRID);
      const x1 = box.x + Math.max(Math.floor(((cx + 1) * box.w) / GRID), Math.floor((cx * box.w) / GRID) + 1);
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) { sum += gray[y * width + x]; n++; }
      }
      cells[cy * GRID + cx] = n ? sum / n : 0;
    }
  }
  return cells;
}

const popcount32 = (x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/**
 * Signature of one centred crop, { bits: 16 hex chars, hi, lo, vec: Float32Array(256) },
 * or null when the crop carries no picture (flat colour, blank): that cannot be
 * "another show's art".
 */
function cropSignature(raster, aspect) {
  const { data, width, height } = raster;
  if (!data || !width || !height) return null;
  const cells = gridMeans(data, width, cropBox(width, height, aspect));
  const n = cells.length;
  let mean = 0;
  for (const c of cells) mean += c;
  mean /= n;
  let ss = 0;
  for (const c of cells) ss += (c - mean) * (c - mean);
  const sd = Math.sqrt(ss / n);
  if (sd < MIN_STDDEV) return null;
  const vec = new Float32Array(n);
  const norm = Math.sqrt(ss);
  for (let i = 0; i < n; i++) vec[i] = (cells[i] - mean) / norm;
  // Average hash on the 8x8 downsample (each cell the mean of a 2x2 block of the grid).
  const small = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      small[y * 8 + x] = (cells[2 * y * GRID + 2 * x] + cells[2 * y * GRID + 2 * x + 1]
        + cells[(2 * y + 1) * GRID + 2 * x] + cells[(2 * y + 1) * GRID + 2 * x + 1]) / 4;
    }
  }
  const sorted = Array.from(small).sort((p, q) => p - q);
  const median = (sorted[31] + sorted[32]) / 2;
  let a = 0;
  let b = 0;
  for (let i = 0; i < 64; i++) {
    const on = small[i] > median ? 1 : 0;
    if (i < 32) a = ((a << 1) | on) >>> 0; else b = ((b << 1) | on) >>> 0;
  }
  // hi/lo are the same 64 bits as numbers, so the all-pairs loop needs no parsing.
  return { bits: a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'), hi: a, lo: b, vec };
}

/** { sq, p45, p23 } crop signatures (each an object or null), or null when none is usable. */
function signatureFromGray(raster) {
  const out = {};
  let any = false;
  for (const k of ASPECT_KEYS) {
    out[k] = cropSignature(raster, ASPECTS[k]);
    if (out[k]) any = true;
  }
  return any ? out : null;
}

/** Number of differing bits between two crop signatures' bit hashes. */
function hamming(sa, sb) {
  return popcount32((sa.hi ^ sb.hi) >>> 0) + popcount32((sa.lo ^ sb.lo) >>> 0);
}

/** Pearson correlation of two crop signatures' vecs (they are mean-centred and unit length). */
function correlation(sa, sb) {
  const { vec: va } = sa;
  const { vec: vb } = sb;
  let dot = 0;
  for (let i = 0; i < va.length; i++) dot += va[i] * vb[i];
  return dot;
}

/** Bit-hash distance above which a crop pair is not even compared by correlation. */
const SHORTLIST_BITS = 24;

/**
 * How alike two images look: the highest correlation over the crop aspects
 * both have a usable signature for (a crop pair far apart on the bit hash is
 * skipped without the correlation). -1 when nothing is comparable.
 */
function similarity(sigA, sigB) {
  let best = -1;
  if (!sigA || !sigB) return best;
  for (const k of ASPECT_KEYS) {
    const a = sigA[k];
    const b = sigB[k];
    if (!a || !b) continue;
    if (hamming(a, b) > SHORTLIST_BITS) continue;
    const r = correlation(a, b);
    if (r > best) best = r;
  }
  return best;
}

let sharpModule = null;
function getSharp() {
  if (!sharpModule) sharpModule = require('sharp');
  return sharpModule;
}

/** Greyscale raster of an image file or buffer, longest edge GRAY_EDGE. */
async function grayRaster(input) {
  const { data, info } = await getSharp()(input, { failOn: 'none' })
    .resize(GRAY_EDGE, GRAY_EDGE, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .greyscale()
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 1) throw new Error(`expected 1 grey channel, got ${info.channels}`);
  return { data, width: info.width, height: info.height };
}

/** Signature of an image file path or Buffer; null when unreadable or flat. */
async function signatureOf(input) {
  try {
    return signatureFromGray(await grayRaster(input));
  } catch {
    return null;
  }
}

module.exports = {
  ASPECTS,
  GRID,
  GRAY_EDGE,
  MIN_STDDEV,
  SHORTLIST_BITS,
  cropBox,
  cropSignature,
  signatureFromGray,
  hamming,
  correlation,
  similarity,
  grayRaster,
  signatureOf,
};
