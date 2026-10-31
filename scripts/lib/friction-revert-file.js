'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// revertFile(filePath, root) — undo a patch applyPatch() wrote to filePath by
// restoring it from HEAD, or (BRO-3595 cousin, same class as BRO-2364/
// scripts/lib/sync-audit-checkout.sh) removing it if HEAD has no version of
// the path at all. `git checkout HEAD -- <path>` errors ("did not match any
// file(s) known to git") when the target was created and patched within the
// SAME run and never committed — that error used to be swallowed by a bare
// `catch {}`, leaving the broken patched content on disk unreverted.
function revertFile(filePath, root) {
  let headHasFile = true;
  try {
    execSync(`git cat-file -e "HEAD:${filePath}"`, { cwd: root, stdio: 'pipe' });
  } catch {
    headHasFile = false;
  }
  try {
    if (headHasFile) {
      // Restore both index (staging) and working tree from HEAD
      execSync(`git checkout HEAD -- "${filePath}"`, { cwd: root, stdio: 'pipe' });
    } else {
      execSync(`git reset -q -- "${filePath}"`, { cwd: root, stdio: 'pipe' });
      fs.rmSync(path.join(root, filePath), { force: true });
    }
  } catch {
    // best effort
  }
}

module.exports = { revertFile };
