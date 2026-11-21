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
  // `//cdn.example.com/x.jpg` is protocol-relative — a valid external URL that
  // starts with '/', so it must be caught BEFORE the local-path branch or it
  // gets resolved against public/ and reported permanently missing.
  if (trimmed.startsWith('//')) return true;
  if (!trimmed.startsWith('/')) return true;
  const abs = path.join(opts.publicDir || PUBLIC_DIR, trimmed);
  return imageFileIsUsable(abs);
}

/**
 * True when a shows.json image path is a local /images/ path with no file
 * behind it. Narrower than !imageOnDisk: a placeholder file still renders, so
 * it is not phantom. pre-deploy-check.js clears these before the build; on
 * 2026-10-08 293 such fields were live as broken images (BRO-2242).
 *
 * @param {string|null|undefined} imgPath
 * @param {{publicDir?: string}} [opts]
 * @returns {boolean}
 */
function isPhantomImagePath(imgPath, opts = {}) {
  if (typeof imgPath !== 'string') return false;
  // Only the show image tree: any other local path (/og/..., generated later
  // in the build) is not ours to judge. Query/hash never reach the filesystem.
  const local = imgPath.trim().split(/[?#]/)[0];
  if (!local.startsWith('/images/shows/') || local.includes('..')) return false;
  return !fs.existsSync(path.join(opts.publicDir || PUBLIC_DIR, local));
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

// The archiver writes .webp; historical archives may still hold the source
// format. Anything else in the directory (.json sidecars, .DS_Store, partial
// .tmp downloads) is NOT key art and must not count as coverage.
const IMAGE_EXTENSIONS = new Set(['.webp', '.jpg', '.jpeg', '.png', '.avif', '.gif']);

/** Shared local-file predicate for declared paths and archived directories. */
function imageFileIsUsable(filePath) {
  if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false;
  if (path.basename(filePath).includes('.candidate.')) return false;
  try {
    return fs.lstatSync(filePath).isFile() && !isPlaceholderFile(filePath);
  } catch {
    return false;
  }
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
  return entries.some(e => imageFileIsUsable(path.join(showDir, e.name)));
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
  const names = new Set();
  // BRO-4401: also keep the BYTES of every pre-existing flat file. Several
  // source paths write thumbnail.jpg/poster.jpg in place before Gemini
  // verifies the candidate; when a show already had art, a rejected
  // candidate OVERWRITES it and survives every name-based cleanup because
  // the name was "pre-existing". Run 36676191484 (2026-09-30): Player's
  // accepted production still was replaced by a Google Images hit Gemini
  // rejected as "a soccer match score update", and that file was committed
  // to main with shows.json still pointing at it. A show dir holds a handful
  // of files of a few hundred KB, so an in-memory copy is cheap.
  const contents = new Map();
  try {
    for (const e of fs.readdirSync(showDir, { withFileTypes: true })) {
      names.add(e.name);
      if (!e.isFile()) continue;
      try { contents.set(e.name, fs.readFileSync(path.join(showDir, e.name))); } catch { /* unreadable: name-only */ }
    }
  } catch {
    return names;
  }
  Object.defineProperty(names, 'contents', { value: contents, enumerable: false });
  return names;
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
 * Pre-existing files whose BYTES changed during the fetch are restored from
 * the snapshot's in-memory copy (BRO-4401) — a rejected candidate that
 * overwrote good art in place is the other route to the same symptom.
 *
 * @returns {{removed: string[], restored: string[], prunedDir: boolean}}
 */
function discardFailedFetchArtifacts(showDir, before) {
  const removed = [];
  const restored = [];
  let entries;
  try {
    entries = fs.readdirSync(showDir, { withFileTypes: true });
  } catch {
    return { removed, restored, prunedDir: false };
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
  // BRO-4401: a pre-existing file whose bytes changed during the fetch was
  // overwritten in place by a candidate that was then rejected. Put the
  // snapshot bytes back (also when the file is gone), or the show page
  // renders the wrong art with shows.json still pointing at the name.
  const contents = before && before.contents;
  if (contents && contents.size > 0) {
    for (const [name, bytes] of contents) {
      const file = path.join(showDir, name);
      let current = null;
      try { current = fs.readFileSync(file); } catch { current = null; }
      if (current && current.equals(bytes)) continue;
      try {
        fs.writeFileSync(file, bytes);
        restored.push(name);
      } catch {
        // unrestorable — the removed/restored report still tells the operator
      }
    }
  }
  return { removed, restored, prunedDir: pruneEmptyShowImageDir(showDir) };
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
        const { removed, restored, prunedDir } = discardFailedFetchArtifacts(showImageDir, dirBefore);
        if (removed.length > 0) {
          log(`   🧹 discarded ${removed.length} rejected candidate file(s) for ${showId} (${removed.join(', ')}) — they would have read as coverage`);
        }
        if (restored && restored.length > 0) {
          log(`   🧹 restored ${restored.length} pre-existing file(s) a rejected candidate had overwritten for ${showId} (${restored.join(', ')})`);
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
  PLACEHOLDER_FILE_HASHES,
  isPlaceholderFile,
  imageOnDisk,
  isPhantomImagePath,
  hasRealImage,
  hasArchivedShowImages,
  listShowIdsWithImages,
  pruneEmptyShowImageDir,
  snapshotShowImageDir,
  discardFailedFetchArtifacts,
  dirHasImageFiles,
  runFetchWithCleanup,
};
