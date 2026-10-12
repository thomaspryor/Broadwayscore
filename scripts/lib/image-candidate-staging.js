'use strict';
/**
 * Stage unverified image candidates next to, never on, the live file (BRO-4906).
 *
 * fetch-show-images-auto.js's Google Images tier used to write each candidate
 * straight into public/images/shows/<id>/thumbnail.jpg and poster.jpg before
 * the verifier ran. A rejected candidate, or one that lost to another tier or
 * to the keep-existing-thumbnail branch, left unverified Google bytes on the
 * site while data/image-sources.json still named the old source.
 *
 * Now a candidate goes to <name>.candidate.<ext>. The images object keeps the
 * final /images/shows/ path (so every downstream check reads as before) and
 * carries `_staged: { [format]: { local, final, stage } }`. Only the formats
 * the row ends up serving are renamed into place (finalizeStaged); everything
 * else is deleted. sweepStagedCandidates removes leftovers from a show dir.
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
 * Write bytes as the staged candidate for `format`; record it on `staged`.
 * @returns {object} staged (mutated)
 */
function writeStagedCandidate(staged, format, { local, final }, bytes, fsImpl = fs) {
  const stage = stagedPathFor(final);
  fsImpl.mkdirSync(path.dirname(stage), { recursive: true });
  fsImpl.writeFileSync(stage, bytes);
  staged[format] = { local, final, stage };
  return staged;
}

/** Delete the staged candidate for one format, if any. */
function discardStaged(staged, format, fsImpl = fs) {
  const e = staged && staged[format];
  if (!e) return false;
  try { fsImpl.unlinkSync(e.stage); } catch { /* already gone */ }
  delete staged[format];
  return true;
}

/** Bytes a staged candidate holds for a final abs path, or null. */
function stagedBytesFor(staged, finalAbs, fsImpl = fs) {
  for (const e of Object.values(staged || {})) {
    if (e && e.final === finalAbs) {
      try { return fsImpl.readFileSync(e.stage); } catch { return null; }
    }
  }
  return null;
}

/**
 * Promote the staged formats the row now serves (`served[format] === local`),
 * delete the rest.
 * @returns {{promoted: string[], discarded: string[]}}
 */
function finalizeStaged(staged, served, fsImpl = fs) {
  const promoted = [];
  const discarded = [];
  for (const format of Object.keys(staged || {})) {
    const e = staged[format];
    if (served && served[format] === e.local && fsImpl.existsSync(e.stage)) {
      fsImpl.renameSync(e.stage, e.final);
      promoted.push(format);
    } else {
      try { fsImpl.unlinkSync(e.stage); } catch { /* already gone */ }
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
  finalizeStaged,
  sweepStagedCandidates,
};
