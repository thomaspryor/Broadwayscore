'use strict';

// BRO-5217: in a cloud session data/*.json core files are plain copies of the
// core-data clone (setup-local-data.sh CLOUD_COPY), re-copied at every session
// start. A write to one "succeeds" and is then silently lost, where on the Mac
// the same write goes through the symlink into the clone. Writers that mean to
// persist (atomic-shows-write.js, retired-show-ids.js) call this and refuse
// loudly instead. data/.core-data-sha beside the file marks a cloud copy.

const fs = require('fs');
const path = require('path');
const { getLocalSymlinkFiles } = require('./core-data-files');

/** @returns {string|null} why the write must not happen, or null when it may. */
function cloudCopyWriteRefusal(targetPath, env = process.env) {
  if (env.CLAUDE_CODE_REMOTE !== 'true' || env.BSC_ALLOW_CLOUD_COPY_WRITE === '1') return null;
  // Only the core files the clone owns (SYMLINK_FILES); public tracked data/*.json
  // (playbill-urls.json etc.) share atomicWriteJson and must stay writable.
  if (!getLocalSymlinkFiles().includes(path.basename(targetPath))) return null;
  let st;
  try { st = fs.lstatSync(targetPath); } catch { return null; }
  if (st.isSymbolicLink()) return null;
  if (!fs.existsSync(path.join(path.dirname(targetPath), '.core-data-sha'))) return null;
  return `refusing to write ${path.basename(targetPath)}: in a cloud session data/ core files are disposable copies of the core-data clone, re-copied at every session start, so this change would be lost (BRO-5217). Route data changes through a data/pending-fixes plan (.claude/CLOUD.md), or set BSC_ALLOW_CLOUD_COPY_WRITE=1 for a throwaway scratch run.`;
}

function assertNotCloudCopy(targetPath, env = process.env) {
  const why = cloudCopyWriteRefusal(targetPath, env);
  if (why) throw new Error(why);
}

/**
 * BRO-5892: read-only audits (validate-data.js) default to their dry run in a cloud
 * session, where their auto-fixes and data/audit/ rewrites land on disposable copies
 * and dirty the tree. `--write` opts back in; CI (GITHUB_ACTIONS) is never affected.
 * @returns {{dryRun: boolean, note: string|null}}
 */
function cloudAuditDryRun(argv, env = process.env) {
  if (argv.includes('--dry-run')) return { dryRun: true, note: null };
  if (env.CLAUDE_CODE_REMOTE !== 'true' || env.GITHUB_ACTIONS === 'true' || argv.includes('--write')) {
    return { dryRun: false, note: null };
  }
  return { dryRun: true, note: 'Cloud session: running as --dry-run (no writes). Pass --write to let it write.' };
}

module.exports = { cloudCopyWriteRefusal, assertNotCloudCopy, cloudAuditDryRun };
