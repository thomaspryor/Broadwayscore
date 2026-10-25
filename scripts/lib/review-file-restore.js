'use strict';
/**
 * Restore a review-texts file from the private repo's git history (BRO-5133).
 *
 * A pending-fix plan deleted a complete review mis-filed under the wrong outlet
 * and re-ingested its url; every fetch tier then failed or returned a bot-block
 * page, so the review text was lost from the working tree. No other plan action
 * can carry fullText (review-field-edit refuses it, and plans are public), so
 * this copies the file back from a named commit instead.
 *
 * CI clones review-texts at depth 1, so the commit is fetched first; GitHub only
 * serves a full 40-char sha, hence the strict format. The write goes through
 * safeWriteReview like every other review write.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const COMMIT_RE = /^[0-9a-f]{40}\^?$/;

function resolveInside(dir, rel) {
  if (typeof rel !== 'string' || !rel.endsWith('.json')) return null;
  const abs = path.resolve(dir, rel);
  return abs.startsWith(dir + path.sep) ? abs : null;
}

/**
 * @param {string} reviewTextsDir - a git checkout of the review-texts repo
 * @param {{sourcePath: string, fromCommit: string, destPath?: string}} action
 * @param {{git?: Function}} [deps] - git runner override for tests
 * @returns {{ok: true, msg: string} | {ok: false, reason: string}}
 */
function restoreReviewFileFromCommit(reviewTextsDir, action, deps = {}) {
  const { sourcePath, fromCommit, destPath } = action || {};
  const dir = path.resolve(reviewTextsDir);
  if (!COMMIT_RE.test(fromCommit || '')) {
    return { ok: false, reason: `fromCommit must be a full 40-char sha (optionally with ^): ${fromCommit}` };
  }
  const absSource = resolveInside(dir, sourcePath);
  const absDest = resolveInside(dir, destPath || sourcePath);
  if (!absSource || !absDest) return { ok: false, reason: `Bad review path: ${sourcePath} -> ${destPath || sourcePath}` };
  if (fs.existsSync(absDest)) return { ok: false, reason: `Destination already exists: ${destPath || sourcePath}` };

  const git = deps.git || ((args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  const sha = fromCommit.replace(/\^$/, '');
  let content;
  try {
    // Depth 2 so a `<sha>^` parent is present too; a no-op when the history is already local.
    git(['fetch', '--quiet', '--depth=2', 'origin', sha]);
    content = git(['show', `${fromCommit}:${path.relative(dir, absSource).split(path.sep).join('/')}`]);
  } catch (e) {
    return { ok: false, reason: `git could not read ${sourcePath} at ${fromCommit}: ${String(e.message).split('\n')[0]}` };
  }
  let record;
  try {
    record = JSON.parse(content);
  } catch {
    return { ok: false, reason: `${sourcePath} at ${fromCommit} is not valid JSON` };
  }
  if (!record || typeof record !== 'object' || !record.url) {
    return { ok: false, reason: `${sourcePath} at ${fromCommit} has no url` };
  }
  // A restore into another show's folder carries that show's id, as a rename
  // does (safeRenameReview); the rebuild groups by folder but audits read showId.
  const destShow = path.basename(path.dirname(absDest));
  if (record.showId && record.showId !== destShow) record.showId = destShow;
  // BRO-5356: restored onto another path, its push-time history is the source's.
  if (absDest !== absSource) {
    const rel = path.relative(dir, absSource).split(path.sep);
    record._renamedFrom = require('./rename-identity').renameStamp(rel[0], rel.slice(1).join('/'));
  }
  fs.mkdirSync(path.dirname(absDest), { recursive: true });
  const written = require('./review-write-guard').safeWriteReview(absDest, record);
  if (written && written.wrote === false) {
    return { ok: false, reason: `write guard skipped ${destPath || sourcePath}: ${written.skipped || 'no reason given'}` };
  }
  return { ok: true, msg: `Restored ${sourcePath}@${fromCommit} -> ${destPath || sourcePath}` };
}

module.exports = { restoreReviewFileFromCommit, COMMIT_RE };
