/**
 * show-image-coverage.js
 *
 * Single answer to "does this show actually have archived key art?"
 *
 * WHY THIS EXISTS (2026-08-02):
 * Coverage was decided by directory EXISTENCE — `public/images/shows/<id>/`.
 * But fetch-show-images-auto.js mkdir's that directory BEFORE it knows whether
 * any candidate will pass verification, so a show whose every candidate is
 * rejected is left with an empty directory. Every existence-based reader then
 * reports the show as covered, and it is silently dropped from the imageless
 * cohort — which is exactly how imageless shows reach the live homepage showing
 * "Images coming soon" (Brainiac Live, The Gin Game).
 *
 * Directory existence is a claim. A file on disk is evidence. Read the files.
 */

const fs = require('fs');
const path = require('path');

// The archiver writes .webp; historical archives may still hold the source
// format. Anything else in the directory (.json sidecars, .DS_Store) is NOT
// key art and must not count as coverage.
const IMAGE_EXTENSIONS = new Set(['.webp', '.jpg', '.jpeg', '.png', '.avif', '.gif']);

function isImageFile(name) {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * True when showDir holds at least one real image file.
 * A missing directory and an empty/junk-only directory are both false — the
 * distinction the old existsSync check could not make.
 *
 * @param {string} showDir absolute or relative path to public/images/shows/<id>
 * @returns {boolean}
 */
function dirHasImageFiles(showDir) {
  let entries;
  try {
    entries = fs.readdirSync(showDir);
  } catch {
    return false; // missing, or unreadable — either way, no proven coverage
  }
  return entries.some(isImageFile);
}

/**
 * @param {string} imagesRoot path to public/images/shows
 * @param {string} showId
 * @returns {boolean}
 */
function hasArchivedShowImages(imagesRoot, showId) {
  if (!showId) return false;
  return dirHasImageFiles(path.join(imagesRoot, showId));
}

/**
 * Set of show ids under imagesRoot that have at least one real image file.
 * Replaces `new Set(fs.readdirSync(imagesRoot))`, which counted empty dirs.
 *
 * @param {string} imagesRoot path to public/images/shows
 * @returns {Set<string>}
 */
function listShowIdsWithImages(imagesRoot) {
  let dirents;
  try {
    dirents = fs.readdirSync(imagesRoot, { withFileTypes: true });
  } catch {
    return new Set();
  }
  const covered = new Set();
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    if (dirHasImageFiles(path.join(imagesRoot, d.name))) covered.add(d.name);
  }
  return covered;
}

/**
 * Remove a show's image directory if it holds no image files. Called on the
 * failure path of a fetch so a rejected show does not leave behind a directory
 * that later reads as coverage. Never removes a directory holding real art.
 *
 * @param {string} showDir
 * @returns {boolean} true if a directory was removed
 */
function pruneEmptyShowImageDir(showDir) {
  let entries;
  try {
    entries = fs.readdirSync(showDir);
  } catch {
    return false; // nothing there to prune
  }
  if (entries.some(isImageFile)) return false; // real art — leave it alone
  try {
    fs.rmSync(showDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  hasArchivedShowImages,
  listShowIdsWithImages,
  pruneEmptyShowImageDir,
  dirHasImageFiles,
};
