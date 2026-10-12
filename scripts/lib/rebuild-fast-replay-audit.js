#!/usr/bin/env node
/**
 * BRO-2783 review fix: replay the LOST rebuild-fast commit's data/audit/ diff
 * onto a fresh origin/main tree, without clobbering other writers' rows.
 *
 * rebuild-fast-push-cycle.sh drops the lost commit (`git reset --hard` onto
 * fresh main) and rebuild-fast-redo.sh regenerates the public data. But the
 * first pass also wrote data/audit state that the redo cannot (and must not)
 * re-run: alert-ledger.json (cooldowns/dedup), alert-digest-queue.json (digest
 * lines), verify-all-scored-state.json, opening-night-completeness-state.json,
 * critic-outlets-baseline.json, orphan-unscored-*.json markers. This replays
 * exactly that diff (LOST^ -> LOST), per file:
 *
 *   orphan-unscored-*.json  this run's verdict wins (add/update/delete taken
 *                           from LOST). Only verify-all-scored.js writes them
 *                           and they are per-show snapshots.
 *   everything else         `git apply -3 --index` of that file's diff. Clean
 *                           AND the result still parses (registry format, else
 *                           .json/.jsonl by extension) -> done ("applied").
 *                           On conflict or invalid output, the file is put
 *                           back to fresh main's version, then:
 *                             - registry merger exists (alert-ledger.json,
 *                               alert-digest-queue.json, ...): 3-way merge
 *                               merge(ours=LOST, remote=HEAD, base=LOST^), the
 *                               same functions push-via-git-api.sh uses
 *                               ("merged");
 *                             - otherwise, or the merger throws: KEEP fresh
 *                               main's version and warn ("kept-remote").
 *
 * Why fall back to main's version instead of failing closed: failing the redo
 * strands the whole scored rebuild (the very incident BRO-2783 fixes), while
 * keeping main's copy never destroys another writer's rows. The cost is
 * bounded to this run's own edit of that one state file (e.g. one repeat
 * alert or a re-evaluated snapshot on the next run). Blind-checking-out the
 * LOST version over other writers' rows is never done.
 *
 * Precondition: data/audit/ in the work tree and index equals HEAD.
 * Usage: node scripts/lib/rebuild-fast-replay-audit.js <lost-commit>
 * Exit 0 on success (any mix of applied/merged/kept-remote), 1 when git itself
 * fails (caller must not push).
 */
'use strict';

const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');
const { explicitMergerFor } = require('./reconcile-merged-json');

const ORPHAN_RE = /^data\/audit\/orphan-unscored-[^/]*\.json$/;
const BIG = 1024 * 1024 * 512;

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: BIG, stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

function showOrNull(rev, file) {
  const r = spawnSync('git', ['show', `${rev}:${file}`], { encoding: 'utf8', maxBuffer: BIG });
  return r.status === 0 ? r.stdout : null;
}

function parse(text, format) {
  if (format !== 'jsonl') return JSON.parse(text);
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function serialize(value, t) {
  if (t.format === 'jsonl') return value.map((e) => JSON.stringify(e)).join('\n') + (value.length ? '\n' : '');
  return JSON.stringify(value, null, 2) + (t.newline ? '\n' : '');
}

/** Put `file` back to HEAD's version (or absent), clearing any unmerged state. */
function restoreHead(file) {
  if (showOrNull('HEAD', file) !== null) {
    git(['checkout', 'HEAD', '--', file]);
  } else {
    spawnSync('git', ['rm', '-q', '--cached', '--ignore-unmatch', '--', file]);
    fs.rmSync(file, { force: true });
  }
}

/** Format a data/audit file must parse as: registry format, else by extension. */
function formatFor(file) {
  const t = explicitMergerFor(file);
  if (t) return t.format === 'jsonl' ? 'jsonl' : 'json';
  if (file.endsWith('.jsonl')) return 'jsonl';
  if (file.endsWith('.json')) return 'json';
  return null; // not structured data: nothing to validate
}

/** null when the work-tree file is absent (a replayed delete) or parses; else a reason. */
function invalidReason(file) {
  const format = formatFor(file);
  if (!format || !fs.existsSync(file)) return null;
  try {
    parse(fs.readFileSync(file, 'utf8'), format);
    return null;
  } catch (e) {
    return `${format} (${String(e && e.message).slice(0, 80)})`;
  }
}

function mergeWithRegistry(lost, file) {
  const t = explicitMergerFor(file);
  if (!t) return 'no-merger';
  const oursText = showOrNull(lost, file);
  const remoteText = showOrNull('HEAD', file);
  if (oursText === null || remoteText === null) return 'no-merger'; // add/delete vs edit: nothing to union
  const baseText = showOrNull(`${lost}^`, file);
  const base = baseText === null ? undefined : parse(baseText, t.format);
  const ours = parse(oursText, t.format);
  const remote = parse(remoteText, t.format);
  const result = t.merge.length >= 3 ? t.merge(ours, remote, base) : t.merge(ours, remote);
  fs.writeFileSync(file, serialize(result.merged, t));
  git(['add', '--', file]);
  return 'merged';
}

function replayAudit(lost) {
  const out = git(['diff', '--no-renames', '--name-status', `${lost}^`, lost, '--', 'data/audit']);
  const results = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [status, file] = line.split('\t');
    if (!file) continue;
    if (ORPHAN_RE.test(file)) {
      if (status === 'D') git(['rm', '-q', '--ignore-unmatch', '--', file]);
      else git(['checkout', lost, '--', file]);
      results.push({ file, outcome: 'ours' });
      continue;
    }
    const patch = git(['diff', '--binary', '--no-renames', `${lost}^`, lost, '--', file]);
    const applied = spawnSync('git', ['apply', '-3', '--index'], { input: patch, encoding: 'utf8', maxBuffer: BIG });
    const unmerged = git(['diff', '--name-only', '--diff-filter=U', '--', file]).trim();
    if (applied.status === 0 && !unmerged) {
      // A clean 3-way apply can still splice two writers' hunks into invalid
      // JSON (e.g. a missing comma between adjacent added keys). Never publish
      // that: treat it like a conflict.
      const invalid = invalidReason(file);
      if (!invalid) {
        results.push({ file, outcome: 'applied' });
        continue;
      }
      console.log(`::warning::rebuild-fast redo: clean apply of ${file} produced invalid ${invalid}; falling back to the merger / main's copy`);
    }
    restoreHead(file);
    let outcome;
    try {
      outcome = mergeWithRegistry(lost, file);
    } catch (e) {
      restoreHead(file);
      outcome = `merge-error(${String(e && e.message).slice(0, 80)})`;
    }
    if (outcome !== 'merged') {
      console.log(`::warning::rebuild-fast redo: ${file} conflicts with fresh main and has no usable merger (${outcome}); kept main's version, this run's edit to it is dropped`);
      outcome = 'kept-remote';
    }
    results.push({ file, outcome });
  }
  return results;
}

if (require.main === module) {
  const lost = process.argv[2];
  if (!lost) {
    console.error('usage: rebuild-fast-replay-audit.js <lost-commit>');
    process.exit(1);
  }
  try {
    const root = git(['rev-parse', '--show-toplevel']).trim();
    process.chdir(root);
    for (const r of replayAudit(lost)) console.log(`[rebuild-fast-replay-audit] ${r.outcome}: ${r.file}`);
  } catch (e) {
    console.error(`::error::rebuild-fast-replay-audit failed: ${String(e && e.message).slice(0, 300)}`);
    process.exit(1);
  }
}

module.exports = { replayAudit, invalidReason, ORPHAN_RE };
