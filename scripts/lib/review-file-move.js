'use strict';
/**
 * Move one review-text file inside data/review-texts for an approved-fix plan
 * (review-file-op move/rename). BRO-4317: fs.renameSync replaces an existing
 * destination silently, so a move onto a same-named review in the target show
 * destroyed that review. A plan that means to replace it says overwrite: true.
 */
const fs = require('fs');
const path = require('path');

function inside(root, p) {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function moveReviewFile(reviewTextsDir, sourcePath, destPath, { overwrite = false } = {}) {
  const root = path.resolve(reviewTextsDir);
  const absSource = path.resolve(root, sourcePath || '');
  if (!inside(root, absSource)) return { ok: false, reason: `Source path escapes review-texts/: ${sourcePath}` };
  if (!fs.existsSync(absSource)) return { ok: false, reason: `Source not found: ${sourcePath}` };
  if (!destPath) return { ok: false, reason: 'No destination path for move/rename' };
  const absDest = path.resolve(root, destPath);
  if (!inside(root, absDest)) return { ok: false, reason: `Dest path escapes review-texts/: ${destPath}` };
  if (fs.existsSync(absDest) && overwrite !== true) {
    return { ok: false, reason: `Destination exists: ${destPath} (delete it first or set overwrite: true)` };
  }
  fs.mkdirSync(path.dirname(absDest), { recursive: true });
  fs.renameSync(absSource, absDest);
  return { ok: true, msg: `Moved ${sourcePath} → ${destPath}` };
}

module.exports = { moveReviewFile };
