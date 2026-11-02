'use strict';

/**
 * land-local-check-log.js (BRO-5730): where land-local-check.js records each verdict, and how the
 * land push hook (land-preflight.mjs) reads it back.
 *
 * One JSON line per finished check, {ts, head, tree, verdict}, in <main checkout>/.claude/
 * land-local-check.jsonl (the git common dir's parent, the same rule as land-preflight.jsonl, so
 * every worktree of a checkout shares one log). verdict: clean | new-failures | not-ready | skipped.
 * No dependencies on purpose: the push hook loads it and must stay cheap and load-safe.
 * Every function fails silent; a log problem never changes a verdict or blocks a push.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LOG_NAME = 'land-local-check.jsonl';
// land-local-check.js exit code -> recorded verdict. 2 (bad usage) and --help are not checks.
const VERDICT_BY_EXIT = { 0: 'clean', 1: 'new-failures', 3: 'not-ready', 4: 'skipped' };
const READ_TAIL_BYTES = 256 * 1024;

function gitOut(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

/** -> absolute log path for the checkout `cwd` belongs to, or null outside a repo. */
function logPath(cwd) {
  const common = gitOut(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common ? path.join(path.dirname(common), '.claude', LOG_NAME) : null;
}

/** Append the verdict for the HEAD `cwd` has checked out. Unknown exit codes are not recorded. */
function recordVerdict(cwd, exitCode, { file = logPath(cwd), now = new Date() } = {}) {
  const verdict = VERDICT_BY_EXIT[exitCode];
  if (!verdict || !file) return null;
  try {
    const head = gitOut(cwd, ['rev-parse', 'HEAD']);
    const tree = gitOut(cwd, ['rev-parse', 'HEAD^{tree}']);
    if (!head) return null;
    const entry = { ts: now.toISOString(), head, tree, verdict };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    return entry;
  } catch {
    return null;
  }
}

/**
 * Newest record for a commit `sha` or, failing that, the same `tree` (an amend or a re-commit of
 * identical content). -> the record, or null when there is none or the log is unreadable.
 */
function latestVerdict({ sha, tree, file }) {
  if (!file || (!sha && !tree)) return null;
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, READ_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    let byTree = null;
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || !e.verdict) continue;
      if (sha && e.head === sha) return e;
      if (!byTree && tree && e.tree === tree) byTree = e;
    }
    return byTree;
  } catch {
    return null;
  }
}

module.exports = { LOG_NAME, VERDICT_BY_EXIT, logPath, recordVerdict, latestVerdict };
