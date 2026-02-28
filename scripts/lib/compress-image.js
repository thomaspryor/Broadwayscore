/**
 * Image compression utility using sharp.
 * Resizes and compresses image buffers before saving to disk.
 *
 * Size targets:
 *   thumbnail: 400px wide, ≤50KB
 *   poster:    600px wide, ≤150KB
 *   hero:      1200px wide, ≤300KB
 */

let sharp;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

const SIZE_LIMITS = {
  thumbnail: { maxWidth: 400, maxBytes: 50 * 1024, quality: 80 },
  poster:    { maxWidth: 600, maxBytes: 150 * 1024, quality: 82 },
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

  // Skip if already under size limit
  if (buffer.length <= limits.maxBytes) return buffer;

  try {
    const compressed = await sharp(buffer)
      .resize({ width: limits.maxWidth, withoutEnlargement: true })
      .jpeg({ quality: limits.quality, mozjpeg: true })
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

module.exports = { compressImage, SIZE_LIMITS };
