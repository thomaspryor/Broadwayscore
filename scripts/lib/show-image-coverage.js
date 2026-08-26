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
function hasArchivedShowImages(imagesRoot, showId) {
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
 * WHY (2026-08-02, second adversarial review):
 * Several source paths write thumbnail.jpg/poster.jpg to disk BEFORE Gemini
 * verifies the candidate (fetch-show-images-auto.js writes at ~1753, verifies
 * at ~1888). When verification then rejects, the fetch returns null and no URL
 * is recorded in shows.json — but the written file stays. Pruning only EMPTY
 * directories therefore missed this case entirely: the show has a real file on
 * disk (so every coverage reader says "has art") and no shows.json entry (so
 * the page still renders "Images coming soon"). That is the same live symptom
 * this module exists to prevent, reached by a different route.
 *
 * Only entries absent from `before` are removed, so pre-existing archived art
 * is never touched — the failure path must not be able to destroy a previously
 * good poster. Directories are left alone (we only ever write flat files).
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

/**
 * Run a single show's image fetch and guarantee discardFailedFetchArtifacts
 * runs no matter how the fetch ends — including a throw.
 *
 * WHY (BRO-178, 2026-08-11 zombie-sweep reopen of the 2026-08-02 fix): a plain
 * `images = await fetchFn()` only reaches cleanup on the resolve path. A throw
 * between a source's mkdir and its write (a sharp/compression error, an OOM, a
 * disk error) propagates straight out, Promise.allSettled records a rejection,
 * and the freshly created empty (or partially written) directory survives as
 * false coverage — the exact failure case discardFailedFetchArtifacts exists
 * for. try/finally reaches cleanup on every exit path, including throw.
 *
 * Cleanup errors are swallowed (not rethrown): a filesystem error while
 * cleaning up must never replace the real fetch error and hide its cause.
 *
 * @param {() => Promise<any>} fetchFn performs the fetch; its resolved value is
 *   returned unchanged. Truthy means success — nothing is cleaned up.
 * @param {string} showImageDir
 * @param {Set<string>} dirBefore snapshot taken before the fetch (snapshotShowImageDir)
 * @param {string} showId for logging
 * @param {(msg: string) => void} [log] defaults to console.log; override in tests
 * @returns {Promise<any>} fetchFn's resolved value
 */
async function runFetchWithCleanup(fetchFn, showImageDir, dirBefore, showId, log = console.log) {
  let images = null;
  try {
    images = await fetchFn();
  } finally {
    if (!images) {
      try {
        const { removed, prunedDir } = discardFailedFetchArtifacts(showImageDir, dirBefore);
        if (removed.length > 0) {
          log(`   🧹 discarded ${removed.length} rejected candidate file(s) for ${showId} (${removed.join(', ')}) — they would have read as coverage`);
        }
        if (prunedDir) {
          log(`   🧹 removed empty image dir for ${showId} (would otherwise read as coverage)`);
        }
      } catch (cleanupErr) {
        log(`   ⚠ image-dir cleanup failed for ${showId}: ${cleanupErr.message}`);
      }
    }
  }
  return images;
}

module.exports = {
  hasArchivedShowImages,
  listShowIdsWithImages,
  pruneEmptyShowImageDir,
  snapshotShowImageDir,
  discardFailedFetchArtifacts,
  dirHasImageFiles,
  runFetchWithCleanup,
};
