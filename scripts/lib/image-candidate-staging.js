'use strict';
/**
 * Hold unverified image candidates in memory (BRO-179, BRO-4906).
 *
 * fetch-show-images-auto.js's Google Images tier used to write each candidate
 * straight into public/images/shows/<id>/thumbnail.jpg and poster.jpg before
 * the verifier ran. A rejected candidate, or one that lost to another tier or
 * to the keep-existing-thumbnail branch, left unverified Google bytes on the
 * site while data/image-sources.json still named the old source.
 *
 * The images object keeps the final /images/shows/ path and carries
 * `_staged: { [format]: { local, final, bytes } }`. Only after verification
 * and selection does finalizeStaged write the formats the row will serve.
 * It uses a temporary file and rename to preserve live art on a failed write.
 * sweepStagedCandidates still removes leftovers from older runs or a crash
 * during an accepted candidate's final write.
 */
const fs = require('fs');
const path = require('path');

const CANDIDATE_MARK = '.candidate';

/** dir/thumbnail.jpg -> dir/thumbnail.candidate.jpg */
function stagedPathFor(finalAbs) {
  const ext = path.extname(finalAbs);
  return path.join(path.dirname(finalAbs), path.basename(finalAbs, ext) + CANDIDATE_MARK + ext);
}

/**
 * Keep bytes as the staged candidate for `format`; no filesystem writes.
 * @returns {object} staged (mutated)
 */
function writeStagedCandidate(staged, format, { local, final }, bytes) {
  staged[format] = { local, final, bytes };
  return staged;
}

/** Delete the staged candidate for one format, if any. */
function discardStaged(staged, format) {
  const e = staged && staged[format];
  if (!e) return false;
  delete staged[format];
  return true;
}

/** Bytes a staged candidate holds for a final abs path, or null. */
function stagedBytesFor(staged, finalAbs) {
  for (const e of Object.values(staged || {})) {
    if (e && e.final === finalAbs) {
      return e.bytes;
    }
  }
  return null;
}

/** Stage a selected production photo's snapshot through the same final checks. */
function stageImageSnapshot(images, files, imagesRoot) {
  const staged = {};
  for (const format of ['thumbnail', 'poster', 'hero']) {
    const local = images[format];
    if (typeof local !== 'string' || !local.startsWith('/images/shows/')) continue;
    const final = path.join(imagesRoot, local.slice('/images/shows/'.length));
    const bytes = files && files[final];
    if (bytes) writeStagedCandidate(staged, format, { local, final }, bytes);
  }
  return staged;
}

/**
 * Write the accepted formats the row now serves (`served[format] === local`),
 * release the rest without writing them.
 * A failed write or rename counts as discarded, so the caller can drop that format
 * instead of serving a path whose bytes never arrived.
 * @returns {{promoted: string[], discarded: string[]}}
 */
function finalizeStaged(staged, served, fsImpl = fs) {
  const promoted = [];
  const discarded = [];
  for (const format of Object.keys(staged || {})) {
    const e = staged[format];
    const stage = stagedPathFor(e.final);
    let moved = false;
    if (served && served[format] === e.local) {
      try {
        fsImpl.mkdirSync(path.dirname(e.final), { recursive: true });
        fsImpl.writeFileSync(stage, e.bytes);
        fsImpl.renameSync(stage, e.final);
        moved = true;
      } catch {
        try { fsImpl.unlinkSync(stage); } catch { /* absent or already gone */ }
      }
    }
    if (moved) {
      promoted.push(format);
    } else {
      discarded.push(format);
    }
    delete staged[format];
  }
  return { promoted, discarded };
}

/** Remove any leftover *.candidate.* file in a show's image dir. */
function sweepStagedCandidates(dir, fsImpl = fs) {
  let names = [];
  try { names = fsImpl.readdirSync(dir); } catch { return []; }
  const removed = [];
  for (const n of names) {
    if (!n.includes(CANDIDATE_MARK + '.')) continue;
    try { fsImpl.unlinkSync(path.join(dir, n)); removed.push(n); } catch { /* raced */ }
  }
  return removed;
}

module.exports = {
  stagedPathFor,
  writeStagedCandidate,
  discardStaged,
  stagedBytesFor,
  stageImageSnapshot,
  finalizeStaged,
  sweepStagedCandidates,
};
