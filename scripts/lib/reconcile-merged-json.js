#!/usr/bin/env node
/**
 * Post-rebase reconciliation for the union-merged JSON files. Task #420,
 * ship-check finding (Codex adversarial review, 2026-07-26).
 *
 * THE HOLE THIS CLOSES
 * --------------------
 * push-with-retry.sh rebases with `-X theirs`, which resolves every conflicting
 * hunk in favour of OUR replayed commits WITHOUT ever raising a conflict. Its
 * resolve_conflicts() function — the one that knows to per-slug UNION
 * commercial-pending-review.json, diary-shows.json, etc. instead of picking a
 * winner — only runs when the rebase actually conflicts. So on the common path
 * the union merger never fires, and a concurrent writer's edit inside the same
 * diff hunk is silently dropped.
 *
 * Measured 2026-07-26 on a two-branch fixture editing DIFFERENT slugs three
 * lines apart in commercial-pending-review.json:
 *     git rebase -X theirs  ->  "Successfully rebased" (no conflict reported)
 *     result: local slug kept, REMOTE slug's edit gone.
 * The per-slug merger never ran because there was nothing git called a conflict.
 *
 * This script is the reconciliation pass: after the rebase/merge has moved HEAD,
 * re-merge each managed file against the remote tip using the SAME union
 * functions resolve_conflicts() would have used, so both sides survive.
 *
 * OPT-IN, BY DESIGN
 * -----------------
 * push-with-retry.sh only invokes this when PUSH_RECONCILE_MERGED_JSON=1. ~114
 * workflows push through that helper and changing their conflict semantics
 * wholesale is not something to do as a side effect of this card — the default
 * stays byte-for-byte today's behaviour. Callers that write a union-merged file
 * (deep-research-commercial.js) opt in. Generalising the flag to every caller is
 * tracked separately.
 *
 * Usage:
 *   node scripts/lib/reconcile-merged-json.js <remote-ref> [file...]
 *
 * With no file list, every managed file that exists is considered. Prints one
 * repo-relative path per line on stdout for each file actually CHANGED by
 * reconciliation (empty output = nothing to do), so the caller can both skip
 * an empty `git commit --amend` AND `git add` exactly those paths — never a
 * blanket `-A` (task #574 hardening: see the call site's comment for why).
 * Fails OPEN: any error leaves the file untouched and exits 0 — a
 * reconciliation problem must never block a push that would otherwise
 * succeed.
 *
 * JSONL FILES (task #698)
 * ------------------------
 * MANAGED entries with `format: 'jsonl'` (currently just the BWW roundup
 * miss-ledger) are read/written as one JSON value PER LINE instead of a
 * single JSON.parse'd document — same reconciliation pass, different
 * serialization. Their merge function takes/returns an ARRAY of parsed line
 * entries (see merge-bww-roundup-ledger.js), not the whole-document
 * ours/remote shape the JSON mergers use.
 *
 * CWD-INDEPENDENCE (task #698, ship-check finding)
 * -------------------------------------------------
 * MANAGED file paths are repo-root-relative, but this module's fs.* calls
 * resolve them against process.cwd() — every existing caller happens to
 * invoke push-with-retry.sh from repo root, so this was latent until
 * opening-night-poller.yml's commit step (which used to `cd data` first)
 * needed the flag. main() chdir's to the git toplevel up front so a future
 * caller with a non-root cwd degrades to a loud `::warning::` skip (via the
 * per-file try/catch below) instead of silently never reconciling.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null; // not a git repo, or git unavailable — fall through and use cwd as-is
  }
}

const { mergeCommercialJson, mergePendingReview, mergeResearchQueue } = require('./merge-commercial-data');
const { mergeDiaryShows } = require('./merge-diary-shows');
const { mergeSocialPostHistory } = require('./merge-social-post-history');
const { mergeBwwRoundupLedger } = require('./merge-bww-roundup-ledger');

// Kept in sync with resolve_conflicts() in push-with-retry.sh. `newline: false`
// matches diary-shows.json's producers, which write no trailing newline — so a
// no-op reconciliation is byte-identical and does not create a phantom diff.
const MANAGED = [
  { file: 'data/commercial.json', merge: mergeCommercialJson, newline: true },
  { file: 'data/commercial-pending-review.json', merge: mergePendingReview, newline: true },
  { file: 'data/commercial-research-queue.json', merge: mergeResearchQueue, newline: true },
  { file: 'data/diary-shows.json', merge: mergeDiaryShows, newline: false },
  { file: 'data/social-post-history.json', merge: mergeSocialPostHistory, newline: true },
  { file: 'data/audit/bww-roundup-miss-ledger.jsonl', merge: mergeBwwRoundupLedger, format: 'jsonl' },
];

/** Pure: pick the merger for a path (exported so the test does not shell out). */
function mergerFor(file) {
  return MANAGED.find((m) => file.endsWith(m.file.replace(/^data\//, ''))) || null;
}

/** Blank lines are skipped; a genuinely corrupt (non-blank, unparsable) line
 * THROWS — deliberately, unlike bww-roundup-persistence.js's own lenient
 * readRoundupMisses(). This function only feeds the reconciliation pass
 * below, whose per-file try/catch fails OPEN (skips that file, logs a
 * `::warning::`) on any error — the same fail-open behavior JSON.parse
 * already gives the 5 non-JSONL MANAGED files. A lenient skip-and-continue
 * here would silently drop the corrupt line from the parsed array and then
 * COMMIT that deletion when the reconciled file is written back (ship-check/
 * Opus review finding) — appendFileSync in recordRoundupMiss() isn't atomic
 * across a killed runner, so a torn last line is a realistic occurrence this
 * pass must never permanently erase. */
function parseJsonlLines(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    entries.push(JSON.parse(t));
  }
  return entries;
}

function readRemote(ref, file, format) {
  try {
    const text = execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return format === 'jsonl' ? parseJsonlLines(text) : JSON.parse(text);
  } catch {
    return null; // absent on the remote side, or unparsable — nothing to reconcile against
  }
}

function main() {
  const [ref, ...only] = process.argv.slice(2);
  if (!ref) { console.error('reconcile-merged-json: missing <remote-ref>'); process.exit(0); }

  const root = repoRoot();
  if (root) { try { process.chdir(root); } catch { /* fall through, per-file try/catch below fails open */ } }

  const targets = only.length
    ? only.map((f) => ({ ...(mergerFor(f) || {}), file: f })).filter((t) => t.merge)
    : MANAGED;

  const changedFiles = [];
  for (const t of targets) {
    try {
      if (!fs.existsSync(t.file)) continue;
      const before = fs.readFileSync(t.file, 'utf8');
      const ours = t.format === 'jsonl' ? parseJsonlLines(before) : JSON.parse(before);
      const remote = readRemote(ref, t.file, t.format);
      if (remote === null) continue;

      const result = t.merge(ours, remote);
      const after = t.format === 'jsonl'
        ? result.merged.map((e) => JSON.stringify(e)).join('\n') + (result.merged.length ? '\n' : '')
        : JSON.stringify(result.merged, null, 2) + (t.newline ? '\n' : '');
      if (after === before) continue;

      fs.writeFileSync(t.file, after);
      changedFiles.push(t.file);
      console.error(`  reconciled ${t.file} against ${ref} — ${JSON.stringify(result.stats)}`);
    } catch (e) {
      // Fail OPEN, loudly enough to debug but never blocking.
      console.error(`  ::warning::reconcile-merged-json: ${t.file} skipped (${String(e.message).slice(0, 120)})`);
    }
  }
  // One changed path per line on stdout — NOT just a count. push-with-retry.sh
  // uses this to `git add` exactly these paths before amending, instead of
  // `git add -A` (ship-check/Codex finding: a blanket -A would also sweep up
  // any OTHER untracked file sitting in the working tree at reconcile time —
  // e.g. update-show-status.yml's discovery-blocked audit JSON, which is
  // deliberately pushed to the PRIVATE repo only and must never land in this
  // public amended commit).
  process.stdout.write(changedFiles.join('\n'));
}

module.exports = { MANAGED, mergerFor };

if (require.main === module) main();
