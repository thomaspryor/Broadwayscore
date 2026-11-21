/**
 * Maximum pixel widths for the per-show images in public/images/shows (BRO-5990).
 * Cards render posters at 112-176 CSS px and thumbnails at 96-112 CSS px, so
 * these caps already cover 2-3x retina. Ingest scripts (compress-image.js,
 * fetch-tour-images.js, the venue-image path in fetch-show-images-auto.js) and
 * the audit/resizer (scripts/resize-show-images.js) share this one table.
 */
const IMAGE_WIDTH_CAPS = { poster: 480, thumbnail: 540, hero: 1920 };

const RESIZE_QUALITY = 80;

/**
 * Small list/card variants (BRO-6277). List and card slots render at 96-128 CSS
 * px, so 2x is 192-256px; the originals are 480-540px. Each canonical
 * `<show>/poster.<ext>` / `<show>/thumbnail.<ext>` gets a webp sibling at
 * `<show>/sm/<role>.<ext>.webp` (e.g. sm/poster.jpg.webp). One variant per source
 * file, because 78 show dirs hold both a poster.jpg and a poster.webp and the
 * site may reference either. A subfolder with a double extension, so the
 * path-based scanners (check-image-aspect FILENAME_RE) and the dir listings
 * (listImageFiles) never see the variants.
 * src/lib/images.ts mirrors these numbers (tested for equality).
 */
const VARIANT_WIDTHS = { poster: 256, thumbnail: 240 };
const VARIANT_DIR = 'sm';
const VARIANT_QUALITY = 78;

/** Canonical (unsuffixed) role files only: poster.webp / thumbnail.jpg, not hero or thumbnail-v2. */
function variantRoleFromFilename(filename) {
  const m = /^(poster|thumbnail)\.(webp|jpe?g|png)$/i.exec(filename);
  return m ? m[1].toLowerCase() : null;
}

/** Variant file name for an original file name: poster.jpg -> poster.jpg.webp, or null. */
function variantNameFor(filename) {
  return variantRoleFromFilename(filename) ? `${filename.toLowerCase()}.webp` : null;
}

/** Absolute path of the variant for an original at `absPath` (always .webp). */
function variantPathFor(absPath) {
  const path = require('path');
  const name = variantNameFor(path.basename(absPath));
  return name ? path.join(path.dirname(absPath), VARIANT_DIR, name) : null;
}

/**
 * Write the variant for the original at `absPath`. Never enlarges; known
 * placeholders get no variant (they must stay recognisable). Returns
 * 'written' | 'skipped' | 'placeholder' | 'unreadable'.
 */
async function writeVariant(absPath, { force = false } = {}) {
  const fs = require('fs');
  const path = require('path');
  const out = variantPathFor(absPath);
  if (!out) return 'skipped';
  const role = variantRoleFromFilename(path.basename(absPath));
  const buf = fs.readFileSync(absPath);
  const crypto = require('crypto');
  const { PLACEHOLDER_FILE_HASHES } = require('./show-images');
  if (PLACEHOLDER_FILE_HASHES.has(crypto.createHash('md5').update(buf).digest('hex'))) {
    fs.rmSync(out, { force: true }); // a placeholder must never keep a variant of earlier art
    return 'placeholder';
  }
  if (!force && fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(absPath).mtimeMs) return 'skipped';
  try {
    const small = await require('sharp')(buf).rotate()
      .resize({ width: VARIANT_WIDTHS[role], withoutEnlargement: true })
      .webp({ quality: VARIANT_QUALITY }).toBuffer();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, small);
    return 'written';
  } catch { return 'unreadable'; }
}

/** Delete the variant of the original at `absPath` (used when the original is quarantined or removed). */
function removeVariant(absPath) {
  const out = variantPathFor(absPath);
  if (out) require('fs').rmSync(out, { force: true });
}

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

module.exports = { variantNameFor, removeVariant, VARIANT_WIDTHS, VARIANT_DIR, variantRoleFromFilename, variantPathFor, writeVariant, encodeToCap, IMAGE_WIDTH_CAPS, RESIZE_QUALITY, WIDTH_CAP_EXCEPTIONS, imageRoleFromFilename, exceedsWidthCap };
