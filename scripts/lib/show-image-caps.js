/**
 * Maximum pixel widths for the per-show images in public/images/shows (BRO-5990).
 * Cards render posters at 112-176 CSS px and thumbnails at 96-112 CSS px, so
 * these caps already cover 2-3x retina. Ingest scripts (compress-image.js,
 * fetch-tour-images.js, the venue-image path in fetch-show-images-auto.js) and
 * the audit/resizer (scripts/resize-show-images.js) share this one table.
 */
const IMAGE_WIDTH_CAPS = { poster: 480, thumbnail: 540, hero: 1920 };

const RESIZE_QUALITY = 80;

// Files whose re-encode at the cap is LARGER than the original (flat-colour PNG
// art), so the resizer leaves them alone. Keep this list tiny; each entry needs a reason.
const WIDTH_CAP_EXCEPTIONS = {
  'anansi-the-spider-west-end-2026/poster.jpg': 'already-landscape art that check-image-aspect rejects; left byte-identical so that gate is not re-triggered, needs new art not a resize',
  'the-spy-who-came-in-from-the-cold-west-end-2025/poster.png': '600px flat-colour PNG, 31KB; resizing to 480px grows it to 48KB',
};

/** 'poster' | 'thumbnail' | 'hero' for a file name like poster.webp / thumbnail-v2.jpg, else null. */
function imageRoleFromFilename(filename) {
  const m = /^(poster|thumbnail|hero)(?:[^/]*)\.(webp|jpe?g|png)$/i.exec(filename);
  return m ? m[1].toLowerCase() : null;
}

function exceedsWidthCap(role, width) {
  const cap = IMAGE_WIDTH_CAPS[role];
  return !!cap && Number.isFinite(width) && width > cap;
}

/**
 * Re-encode `buf` so its width fits the role's cap, keeping the container format
 * of `ext` (webp | jpg | png). Known "Coming Soon" placeholders are returned
 * byte-identical so exact-hash placeholder detection still matches.
 * Callers decide whether to keep the result (it can be larger for flat PNG art).
 */
async function encodeToCap(buf, role, ext) {
  const crypto = require('crypto');
  const { PLACEHOLDER_FILE_HASHES } = require('./show-images');
  if (PLACEHOLDER_FILE_HASHES.has(crypto.createHash('md5').update(buf).digest('hex'))) return buf;
  const sharp = require('sharp');
  let img = sharp(buf).rotate().resize({ width: IMAGE_WIDTH_CAPS[role], withoutEnlargement: true });
  if (ext === 'webp') img = img.webp({ quality: RESIZE_QUALITY });
  else if (ext === 'png') img = img.png({ compressionLevel: 9, palette: true, quality: RESIZE_QUALITY });
  else img = img.jpeg({ quality: RESIZE_QUALITY, mozjpeg: true });
  return img.toBuffer();
}

module.exports = { encodeToCap, IMAGE_WIDTH_CAPS, RESIZE_QUALITY, WIDTH_CAP_EXCEPTIONS, imageRoleFromFilename, exceedsWidthCap };
