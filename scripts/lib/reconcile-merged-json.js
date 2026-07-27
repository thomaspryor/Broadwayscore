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
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { mergeCommercialJson, mergePendingReview, mergeResearchQueue } = require('./merge-commercial-data');
const { mergeDiaryShows } = require('./merge-diary-shows');
const { mergeSocialPostHistory } = require('./merge-social-post-history');

// Kept in sync with resolve_conflicts() in push-with-retry.sh. `newline: false`
// matches diary-shows.json's producers, which write no trailing newline — so a
// no-op reconciliation is byte-identical and does not create a phantom diff.
const MANAGED = [
  { file: 'data/commercial.json', merge: mergeCommercialJson, newline: true },
  { file: 'data/commercial-pending-review.json', merge: mergePendingReview, newline: true },
  { file: 'data/commercial-research-queue.json', merge: mergeResearchQueue, newline: true },
  { file: 'data/diary-shows.json', merge: mergeDiaryShows, newline: false },
  { file: 'data/social-post-history.json', merge: mergeSocialPostHistory, newline: true },
];

/** Pure: pick the merger for a path (exported so the test does not shell out). */
function mergerFor(file) {
  return MANAGED.find((m) => file.endsWith(m.file.replace(/^data\//, ''))) || null;
}

function readRemote(ref, file) {
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null; // absent on the remote side — nothing to reconcile against
  }
}

function main() {
  const [ref, ...only] = process.argv.slice(2);
  if (!ref) { console.error('reconcile-merged-json: missing <remote-ref>'); process.exit(0); }

  const targets = only.length
    ? only.map((f) => ({ ...(mergerFor(f) || {}), file: f })).filter((t) => t.merge)
    : MANAGED;

  const changedFiles = [];
  for (const t of targets) {
    try {
      if (!fs.existsSync(t.file)) continue;
      const before = fs.readFileSync(t.file, 'utf8');
      const ours = JSON.parse(before);
      const remote = readRemote(ref, t.file);
      if (remote === null) continue;

      const result = t.merge(ours, remote);
      const after = JSON.stringify(result.merged, null, 2) + (t.newline ? '\n' : '');
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
