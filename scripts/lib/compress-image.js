/**
 * Image compression utility using sharp.
 * Resizes and compresses image buffers before saving to disk.
 *
 * Size targets:
 *   thumbnail: 400px wide, ≤50KB (over-byte-limit path)
 *   Any image wider than IMAGE_WIDTH_CAPS (show-image-caps.js) is resized regardless of bytes (BRO-5990)
 *   poster:    300px wide, ≤60KB  (largest display: 160px CSS × 2x retina = 320px)
 *   hero:      1200px wide, ≤300KB
 */

const { IMAGE_WIDTH_CAPS } = require('./show-image-caps');
const { PLACEHOLDER_FILE_HASHES } = require('./show-images');

let sharp;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

const SIZE_LIMITS = {
  thumbnail: { maxWidth: 400, maxBytes: 50 * 1024, quality: 80 },
  poster:    { maxWidth: 300, maxBytes: 60 * 1024, quality: 82 },
  hero:      { maxWidth: 1200, maxBytes: 300 * 1024, quality: 85 },
};

/**
 * Compress an image buffer. Returns the compressed buffer, or the original
 * if sharp is unavailable or compression fails.
 *
 * @param {Buffer} buffer - Raw image buffer
 * @param {'thumbnail'|'poster'|'hero'} type - Image type (determines size limits)
 * @returns {Promise<Buffer>} Compressed buffer
 */
async function compressImage(buffer, type = 'thumbnail') {
  if (!sharp || !buffer || buffer.length === 0) return buffer;

  const limits = SIZE_LIMITS[type] || SIZE_LIMITS.thumbnail;

  // Known placeholders must stay byte-identical so the callers' exact-MD5
  // rejection (fetch-show-images-auto.js) still matches them (BRO-5990).
  if (PLACEHOLDER_FILE_HASHES.has(require('crypto').createHash('md5').update(buffer).digest('hex'))) return buffer;

  // Skip only when under the byte limit AND within the display-width cap (BRO-5990:
  // a 100KB-or-less 800px poster used to pass through untouched).
  let targetWidth = limits.maxWidth;
  if (buffer.length <= limits.maxBytes) {
    // Already small in bytes: only trim to the display cap, never below it.
    targetWidth = IMAGE_WIDTH_CAPS[type] || limits.maxWidth;
    let width = 0;
    try { width = (await sharp(buffer).metadata()).width || 0; } catch { return buffer; }
    if (!(width > (IMAGE_WIDTH_CAPS[type] || Infinity))) return buffer;
  }

  try {
    const compressed = await sharp(buffer)
      .resize({ width: targetWidth, withoutEnlargement: true })
      .webp({ quality: limits.quality })
      .toBuffer();

    // Only use compressed if it's actually smaller
    if (compressed.length < buffer.length) {
      const savings = ((1 - compressed.length / buffer.length) * 100).toFixed(0);
      console.log(`   📦 Compressed ${type}: ${(buffer.length/1024).toFixed(0)}KB → ${(compressed.length/1024).toFixed(0)}KB (-${savings}%)`);
      return compressed;
    }
  } catch (err) {
    console.log(`   ⚠ Compression failed for ${type}: ${err.message}`);
  }

  return buffer;
}

/**
 * Thumbnails must be square or mild-portrait (h/w >= 0.85, enforced after the
 * fetch by check-image-aspect.js, which QUARANTINES anything wider). A landscape
 * production photo reaching the retry/last-resort path used to be written as-is
 * and quarantined by CI, so the show stayed imageless and self-heal re-dispatched
 * forever (BRO-5417, still-no-idea-west-end-2018, 640x427). Center-crop it to a
 * square instead (and over-tall images, h/w > 1.70, to 1.70). Returns the buffer unchanged if it already fits or can't be read.
 */
async function ensureThumbnailAspect(buffer) {
  if (!sharp || !buffer || buffer.length === 0) return buffer;
  try {
    const { width, height } = await sharp(buffer).metadata();
    const ratio = height / width;
    if (!width || !height || (ratio >= 0.85 && ratio <= 1.7)) return buffer;
    const region = ratio < 0.85
      ? { left: Math.floor((width - height) / 2), top: 0, width: height, height }
      : { left: 0, top: Math.floor((height - width * 1.7) / 2), width, height: Math.floor(width * 1.7) };
    return await sharp(buffer)
      .extract(region)
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    return buffer;
  }
}

module.exports = { compressImage, ensureThumbnailAspect, SIZE_LIMITS };
