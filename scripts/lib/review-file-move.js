'use strict';
/**
 * Move one review-text file inside data/review-texts for an approved-fix plan
 * (review-file-op move/rename). BRO-4317: fs.renameSync replaces an existing
 * destination silently, so a move onto a same-named review in the target show
 * destroyed that review. A plan that means to replace it says overwrite: true.
 *
 * The move goes through safeRenameReview, which re-stamps showId to the
 * destination folder, refuses locked files and same-url siblings, and moves the
 * llm-scores sidecar. A cross-folder move also auto-clears flags that only
 * described the source folder (locationFlagsStaleAfterMove); left in place they
 * kept 29 of 69 rehomed BRO-4317 reviews off the site.
 */
const fs = require('fs');
const path = require('path');
const { safeRenameReview } = require('./review-write-guard');
const { locationFlagsStaleAfterMove } = require('./wrong-production-autoclear');

function inside(root, p) {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Copy of `data` with the stale location flags cleared (AutoCleared idiom), plus the fields touched. */
function clearStaleLocationFlags(data, srcFolder) {
  const stale = locationFlagsStaleAfterMove(data, srcFolder);
  const next = { ...data };
  const cleared = [];
  const today = new Date().toISOString().split('T')[0];
  if (stale.wrongShow) {
    next.wrongShow = false;
    next.wrongShowAutoCleared = `review-file-move: left orphan folder ${srcFolder} (was: ${data.wrongShowReason})`;
    next.wrongShowAutoClearedAt = today;
    delete next.wrongShowReason;
    cleared.push('wrongShow');
  }
  if (stale.wrongProduction) {
    next.wrongProduction = false;
    next.wrongProductionAutoCleared = `review-file-move: left folder ${srcFolder} (was: ${data.wrongProductionNote})`;
    next.wrongProductionAutoClearedAt = today;
    delete next.wrongProductionNote;
    cleared.push('wrongProduction');
  }
  return { next, cleared };
}

function moveReviewFile(reviewTextsDir, sourcePath, destPath, { overwrite = false } = {}) {
  const root = path.resolve(reviewTextsDir);
  const absSource = path.resolve(root, sourcePath || '');
  if (!inside(root, absSource)) return { ok: false, reason: `Source path escapes review-texts/: ${sourcePath}` };
  if (!fs.existsSync(absSource)) return { ok: false, reason: `Source not found: ${sourcePath}` };
  if (!destPath) return { ok: false, reason: 'No destination path for move/rename' };
  const absDest = path.resolve(root, destPath);
  if (!inside(root, absDest)) return { ok: false, reason: `Dest path escapes review-texts/: ${destPath}` };
  if (absDest === absSource) return { ok: false, reason: `Source and destination are the same: ${sourcePath}` };
  const destExists = fs.existsSync(absDest);
  if (destExists && overwrite !== true) {
    return { ok: false, reason: `Destination exists: ${destPath} (delete it first or set overwrite: true)` };
  }

  let data;
  try { data = JSON.parse(fs.readFileSync(absSource, 'utf8')); } catch (e) {
    return { ok: false, reason: `Source is not valid JSON: ${sourcePath} (${e.message})` };
  }
  const srcFolder = path.basename(path.dirname(absSource));
  const crossFolder = srcFolder !== path.basename(path.dirname(absDest));
  const { next, cleared } = crossFolder ? clearStaleLocationFlags(data, srcFolder) : { next: data, cleared: [] };

  if (destExists) {
    let destData = null;
    try { destData = JSON.parse(fs.readFileSync(absDest, 'utf8')); } catch { /* unreadable: replaceable */ }
    if (destData && destData._locked === true) return { ok: false, reason: `Destination is _locked: ${destPath}` };
  }
  // Overwrite: park the old destination so a refused rename can put it back.
  const parked = destExists ? `${absDest}.move-backup` : null;
  if (parked) fs.renameSync(absDest, parked);
  let res;
  try {
    res = safeRenameReview(absSource, absDest, { newData: next });
  } catch (e) {
    res = { wrote: false, skipped: `error: ${e.message}` };
  }
  if (!res.wrote) {
    // Restore only when the source is still there; a throw after the write leaves the moved review in place.
    if (parked && fs.existsSync(absSource) && !fs.existsSync(absDest)) fs.renameSync(parked, absDest);
    return { ok: false, reason: `Move refused (${res.skipped || 'not written'}): ${sourcePath} → ${destPath}` };
  }
  if (parked) fs.unlinkSync(parked);
  const notes = cleared.length ? `; auto-cleared ${cleared.join(', ')} that named ${srcFolder}` : '';
  return { ok: true, msg: `Moved ${sourcePath} → ${destPath}${notes}`, cleared };
}

module.exports = { moveReviewFile, clearStaleLocationFlags };
