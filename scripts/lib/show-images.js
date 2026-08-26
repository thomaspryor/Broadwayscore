/**
 * Canonical "does this show actually have a usable image?" predicates.
 *
 * Two DIFFERENT questions live here, on purpose, under unambiguous names
 * (BRO-179 — consolidated from scripts/lib/show-image-coverage.js, which
 * answered the second question from a separate module and disagreed with
 * this one on the rejected-candidate case):
 *
 *   - declaredImageResolves(imgPath) — does a show's DECLARED shows.json
 *     images.* path actually resolve to a real, non-placeholder file? A
 *     shows.json entry can carry `/images/shows/<id>/poster.webp` with no
 *     file behind it. the-gin-game-2026 shipped that way and was live for
 *     two weeks rendering the emoji placeholder, because every monitor asked
 *     `if (!show.images?.poster)` — a phantom path is truthy (2026-07-31).
 *
 *   - archivedFilesExist(imagesRoot, showId) — does public/images/shows/<id>/
 *     hold any real image file at all, independent of what shows.json
 *     declares? fetch-show-images-auto.js used to mkdir that directory
 *     before it knew whether any candidate would pass verification, so a
 *     show whose every candidate was rejected was left with an empty
 *     directory that directory-existence checks misread as coverage — how
 *     imageless shows reached the live homepage showing "Images coming
 *     soon" (Brainiac Live, The Gin Game) (2026-08-02).
 *
 * Both predicates are needed by different callers (one asks "is the show's
 * declared art live", the other asks "did we ever successfully archive
 * anything for this show") — the fix was giving them one home and two names
 * that cannot be confused for each other, not collapsing them into one
 * function. Per CLAUDE.md rule 15 (canonical predicates), never
 * re-implement either check inline.
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
function declaredImageResolves(imgPath, opts = {}) {
  if (!imgPath || typeof imgPath !== 'string') return false;
  const trimmed = imgPath.trim();
  if (!trimmed) return false;
  // External URL: we can't cheaply prove liveness, so assume it renders.
  // `//cdn.example.com/x.jpg` is protocol-relative — a valid external URL that
  // starts with '/', so it must be caught BEFORE the local-path branch or it
  // gets resolved against public/ and reported permanently missing.
  if (trimmed.startsWith('//')) return true;
  if (!trimmed.startsWith('/')) return true;
  const abs = path.join(opts.publicDir || PUBLIC_DIR, trimmed);
  if (!fs.existsSync(abs)) return false;
  return !isPlaceholderFile(abs);
}

/**
 * True when the show has at least one usable DECLARED image in any role.
 *
 * @param {{images?: {poster?: string, thumbnail?: string, hero?: string}}} show
 * @param {{publicDir?: string}} [opts]
 * @returns {boolean}
 */
function hasRealImage(show, opts = {}) {
  const images = show && show.images;
  if (!images) return false;
  return ['poster', 'thumbnail', 'hero'].some(role => declaredImageResolves(images[role], opts));
}

// The archiver writes .webp; historical archives may still hold the source
// format. Anything else in the directory (.json sidecars, .DS_Store, partial
// .tmp downloads) is NOT key art and must not count as coverage.
const IMAGE_EXTENSIONS = new Set(['.webp', '.jpg', '.jpeg', '.png', '.avif', '.gif']);

function hasImageExtension(name) {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * True when showDir holds at least one real image file.
 * A missing directory and an empty/junk-only directory are both false — the
 * distinction the old existsSync check could not make.
 *
 * Requires a REGULAR file: a directory or dangling symlink named "poster.webp"
 * is not key art, and treating it as such would both misreport coverage and
 * (worse) protect a junk directory from cleanup.
 *
 * @param {string} showDir absolute or relative path to public/images/shows/<id>
 * @returns {boolean}
 */
function dirHasImageFiles(showDir) {
  let entries;
  try {
    entries = fs.readdirSync(showDir, { withFileTypes: true });
  } catch {
    return false; // missing, or unreadable — either way, no proven coverage
  }
  return entries.some((e) => e.isFile() && hasImageExtension(e.name));
}

/**
 * @param {string} imagesRoot path to public/images/shows
 * @param {string} showId
 * @returns {boolean}
 */
function archivedFilesExist(imagesRoot, showId) {
  if (!showId) return false;
  return dirHasImageFiles(path.join(imagesRoot, showId));
}

/**
 * Set of show ids under imagesRoot that have at least one real image file.
 * Replaces `new Set(fs.readdirSync(imagesRoot))`, which counted empty dirs.
 *
 * THROWS if imagesRoot itself is unreadable. That is deliberate: callers use
 * this to compute "which shows are MISSING art", so degrading to an empty set
 * would declare the entire catalogue imageless. Callers already distinguish
 * "unknown" (null) from "known missing" — let their catch keep that distinction
 * rather than manufacturing a confident wrong answer here.
 * Per-show-directory read errors are still tolerated (that show reads as
 * uncovered, which is the safe direction for one show).
 *
 * @param {string} imagesRoot path to public/images/shows
 * @returns {Set<string>}
 * @throws if imagesRoot cannot be read
 */
function listShowIdsWithImages(imagesRoot) {
  const dirents = fs.readdirSync(imagesRoot, { withFileTypes: true });
  const covered = new Set();
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    if (dirHasImageFiles(path.join(imagesRoot, d.name))) covered.add(d.name);
  }
  return covered;
}

/**
 * Remove a show's image directory ONLY if it is completely empty. Called on the
 * failure path of a fetch so a rejected show does not leave behind a directory
 * that later reads as coverage.
 *
 * Deliberately NOT recursive, and deliberately not "no image files" —
 * `fs.rmdirSync` fails on a non-empty directory, which is the safety property
 * we want. A dir holding real art, a nested originals/ folder, a sidecar, or a
 * partially-written .tmp download is left strictly alone. The only thing that
 * can be removed is a directory with zero entries, which carries no data and
 * only ever misleads coverage readers.
 *
 * (An unlink-then-rmdir variant would be a TOCTOU hazard: a concurrent fetch
 * could create the file between our listing and our delete. rmdir is atomic
 * against exactly that — it refuses the moment anything is inside.)
 *
 * @param {string} showDir
 * @returns {boolean} true if a directory was removed
 */
function pruneEmptyShowImageDir(showDir) {
  try {
    fs.rmdirSync(showDir); // throws ENOTEMPTY if anything at all is inside
    return true;
  } catch {
    return false; // non-empty, missing, or not removable — all fine to skip
  }
}

/**
 * Snapshot the entry names in a show's image directory.
 *
 * Taken BEFORE a fetch so the failure path can tell "art that was already
 * archived" (must survive) from "a candidate this run wrote and then had
 * rejected" (must not survive as fake coverage).
 *
 * @param {string} showDir
 * @returns {Set<string>} entry names; empty when the directory does not exist
 */
function snapshotShowImageDir(showDir) {
  try {
    return new Set(fs.readdirSync(showDir));
  } catch {
    return new Set();
  }
}

/**
 * Undo the files a FAILED fetch left behind, then drop the directory if that
 * empties it.
 *
 * Kept as a crash-safety net even after BRO-179 moved the Google Images
 * source (the only source that wrote candidate bytes before verification) to
 * hold buffers in memory and write only on acceptance: a thrown error between
 * an accepted write's mkdir and its writeFileSync calls (disk full, OOM) can
 * still leave a partial file behind. Scoped to THIS show, and only to entries
 * that appeared during this run, so previously archived art can never be
 * destroyed.
 *
 * @param {string} showDir
 * @param {Set<string>} before result of snapshotShowImageDir taken pre-fetch
 * @returns {{removed: string[], prunedDir: boolean}}
 */
function discardFailedFetchArtifacts(showDir, before) {
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(showDir, { withFileTypes: true });
  } catch {
    return { removed, prunedDir: false };
  }
  for (const e of entries) {
    if (!e.isFile()) continue;      // never recurse into a nested archive
    if (before.has(e.name)) continue; // pre-existing — not ours to delete
    try {
      fs.unlinkSync(path.join(showDir, e.name));
      removed.push(e.name);
    } catch {
      // Another process may have moved it; leaving it is the safe direction.
    }
  }
  return { removed, prunedDir: pruneEmptyShowImageDir(showDir) };
}

module.exports = {
  PLACEHOLDER_FILE_HASHES,
  isPlaceholderFile,
  declaredImageResolves,
  hasRealImage,
  hasImageExtension,
  dirHasImageFiles,
  archivedFilesExist,
  listShowIdsWithImages,
  pruneEmptyShowImageDir,
  snapshotShowImageDir,
  discardFailedFetchArtifacts,
};
