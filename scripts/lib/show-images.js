/**
 * Canonical "does this show actually have a usable image?" predicate.
 *
 * A shows.json entry can carry `/images/shows/<id>/poster.webp` with no file
 * behind it. the-gin-game-2026 shipped that way and was live for two weeks
 * rendering the emoji placeholder, because every monitor asked
 * `if (!show.images?.poster)` — a phantom path is truthy, so nothing alerted
 * (2026-07-31).
 *
 * Three call sites had already grown their own version of the disk check with
 * DIVERGENT semantics: fetch-show-images-auto.js's `--missing` filter rejected
 * known-placeholder files by MD5, the two monitors did not, so a show could be
 * reported "covered" while the page rendered a TodayTix "Coming Soon" graphic.
 * One predicate, one set of semantics, per CLAUDE.md rule 15.
 *
 * Semantics:
 *   - falsy path            → not present
 *   - external http(s) URL  → assumed live (we don't HEAD every CDN URL here)
 *   - local /images/ path   → must exist under public/ AND not be a known
 *                             placeholder graphic
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/**
 * MD5 hashes of known "Coming Soon" placeholder images saved to disk before
 * URL-based filtering existed. A file whose bytes match one of these is a
 * placeholder, not key art.
 */
const PLACEHOLDER_FILE_HASHES = new Set([
  'b4d7d1bdb443e0a94e69ac8a5abd6f40', // poster.webp (19,118 bytes) — variant 1 (round-rect glow)
  'ac3ea27f64c633474ad93fd826f614e7', // thumbnail.webp (11,664 bytes) — variant 1
  '4aed489bb69c5c49be3315e3f85b342f', // hero.webp (28,998 bytes) — variant 1 (round-rect glow)
  '52968e9f240e2db8d7523ac053d019fb', // hero.webp (28,808 bytes) — variant 2 (oval glow, different layout)
  'da0408f33ffaff9c63baf108b53b1128', // hero.webp (25,372 bytes) — variant 3 (1440x580 landscape)
  '9d1b34a4045d176b1856ab38a852d47b', // thumbnail.webp (32,372 bytes) — variant 2 (square format)
]);

/**
 * True when an absolute on-disk path is a byte-identical known placeholder.
 * @param {string} filePath
 * @returns {boolean}
 */
function isPlaceholderFile(filePath) {
  try {
    const hash = crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
    return PLACEHOLDER_FILE_HASHES.has(hash);
  } catch {
    return false;
  }
}

/**
 * True when a shows.json image path resolves to a real, non-placeholder image.
 *
 * @param {string|null|undefined} imgPath value from show.images[role]
 * @param {{publicDir?: string}} [opts] publicDir override (tests)
 * @returns {boolean}
 */
function imageOnDisk(imgPath, opts = {}) {
  if (!imgPath || typeof imgPath !== 'string') return false;
  const trimmed = imgPath.trim();
  if (!trimmed) return false;
  // External URL: we can't cheaply prove liveness, so assume it renders.
  if (!trimmed.startsWith('/')) return true;
  const abs = path.join(opts.publicDir || PUBLIC_DIR, trimmed);
  if (!fs.existsSync(abs)) return false;
  return !isPlaceholderFile(abs);
}

/**
 * True when the show has at least one usable image in any role.
 *
 * @param {{images?: {poster?: string, thumbnail?: string, hero?: string}}} show
 * @param {{publicDir?: string}} [opts]
 * @returns {boolean}
 */
function hasRealImage(show, opts = {}) {
  const images = show && show.images;
  if (!images) return false;
  return ['poster', 'thumbnail', 'hero'].some(role => imageOnDisk(images[role], opts));
}

module.exports = {
  PLACEHOLDER_FILE_HASHES,
  isPlaceholderFile,
  imageOnDisk,
  hasRealImage,
};
