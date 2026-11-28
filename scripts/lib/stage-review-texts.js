#!/usr/bin/env node
'use strict';
/**
 * stage-review-texts.js: the ONE way a CI writer stages a whole
 * broadway-review-texts checkout for commit (BRO-7171).
 *
 * Every CI writer used to run a whole-tree `git add -A`, which commits
 * anything that happens to sit in the checkout: Playwright screenshots, temp
 * files a crashed step left, *.mergetmp from a conflict resolver, a stray
 * symlink. Scoped staging instead:
 *   1. every change to a TRACKED path, deletions included (`git add -u`), so
 *      the stray-symlink removal (push-review-texts, collect-review-texts) and
 *      edits to tracked non-JSON files (aggregator-archive html, CLAUDE.md)
 *      still land;
 *   2. NEW files only when they are *.json outside dot-directories (the repo's
 *      content contract: review files, _pending/ files, failed-fetches.json),
 *      or lane-recordings/ .gz/.jsonl recordings.
 * Untracked new files are listed with `ls-files --others --exclude-standard`,
 * so a sparse checkout's skip-worktree entries are never touched.
 *
 * Writers that know exactly which files they wrote stage those paths instead
 * (review-texts-checkpoint.checkpointReviewTexts).
 *
 * CLI: node scripts/lib/stage-review-texts.js [repoDir]   (default: cwd)
 *      reports counts on stderr; exits 1 if git fails.
 */

const { execFileSync } = require('child_process');

/** Pure: which untracked paths may be staged as new content. */
function isStageableNewPath(rel) {
  const p = String(rel);
  if (p.split('/').some((seg) => seg.startsWith('.'))) return false; // .playwright-mcp/, .claude/, hidden temp files
  if (p.endsWith('.json')) return true;
  // lane-recording-import.yml's own content (it stages lane-recordings/ itself).
  return /^lane-recordings\/.+\.(?:json\.gz|jsonl|gz)$/.test(p);
}

/**
 * @param {string} repoDir
 * @returns {{added: string[], skipped: string[]}} new files staged / left untracked
 */
function stageReviewTexts(repoDir) {
  const git = (args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  git(['add', '-u', '--', '.']);
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const added = untracked.filter(isStageableNewPath);
  const skipped = untracked.filter((p) => !isStageableNewPath(p));
  for (let i = 0; i < added.length; i += 500) git(['add', '--', ...added.slice(i, i + 500)]);
  return { added, skipped };
}

module.exports = { stageReviewTexts, isStageableNewPath };

if (require.main === module) {
  const dir = process.argv[2] || process.cwd();
  try {
    const { added, skipped } = stageReviewTexts(dir);
    if (added.length) process.stderr.write(`stage-review-texts: staged ${added.length} new file(s)\n`);
    if (skipped.length) process.stderr.write(`::warning::stage-review-texts: left ${skipped.length} untracked non-content file(s) unstaged (e.g. ${skipped.slice(0, 3).join(', ')})\n`);
  } catch (e) {
    process.stderr.write(`stage-review-texts: ${e.message}\n`);
    process.exit(1);
  }
}
