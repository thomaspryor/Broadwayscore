'use strict';
// BRO-6886: scripts that push review-texts mid-run (collect-review-texts.js
// checkpoints and the other markReviewTextsPushed callers) start press-night
// scoring right after each push, the same way the push-review-texts action
// does after its push. Without this, a stub that gained its text in a
// checkpoint waited for the end of a long job before scoring was dispatched.
//
// Usage at a mid-run push site:
//   const files = listUnpushedReviewFiles(rtDir);   // before pushWithRetry
//   ... pushWithRetry ...
//   if (ok) startPressNightScoring(files);
// Both are fail-open and do nothing outside GitHub Actions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'score-new-press-night-reviews.js');

/** Review-text paths changed by local commits not yet on origin/main. */
function listUnpushedReviewFiles(cwd) {
  try {
    const out = execFileSync('git', ['log', '--format=', '--name-only', 'origin/main..HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

/**
 * Run score-new-press-night-reviews.js for these files. Synchronous with a
 * 90-second cap so a caller's checkpoint cadence is bounded. Returns true when
 * the CLI ran (it is advisory and always exits 0).
 */
function startPressNightScoring(files, { env = process.env, spawn = spawnSync } = {}) {
  if (!env.GITHUB_ACTIONS || !Array.isArray(files) || files.length === 0) return false;
  let listFile = null;
  try {
    listFile = path.join(env.RUNNER_TEMP || os.tmpdir(), `press-night-scoring-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(listFile, `${files.join('\n')}\n`);
    const r = spawn(process.execPath, [CLI, `--files=${listFile}`], { env, stdio: 'inherit', timeout: 90000 });
    return !r.error;
  } catch {
    return false;
  } finally {
    if (listFile) { try { fs.unlinkSync(listFile); } catch { /* ignore */ } }
  }
}

module.exports = { listUnpushedReviewFiles, startPressNightScoring };
