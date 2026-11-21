#!/usr/bin/env node
/**
 * Generic post-rebase reconciliation for the "private-core-data" surface
 * (files pushed to the private broadway-scorecard-data repo via
 * .github/actions/push-core-data/action.yml's CORE_FILES list).
 *
 * Companion to scripts/lib/reconcile-merged-json.js, which does the same job
 * for the PUBLIC repo surface (data/*.json committed to broadway-scorecard
 * itself, via push-with-retry.sh). The two surfaces push to different repos
 * through different mechanisms, so they need separate reconciliation drivers
 * even though they share the same registry and the same {ours, remote} ->
 * {merged, stats} merge-function shape (BRO-76).
 *
 * Usage:
 *   node scripts/lib/reconcile-core-data-registry.js <remote-snapshot-dir> [<base-snapshot-dir>]
 *
 * <base-snapshot-dir> (BRO-4852) is the job's pre-run checkout snapshot
 * (/tmp/core-data-snapshot from checkout-core-data). Mergers taking a third
 * argument get that file as their base; missing or unparsable = no base.
 *
 * <remote-snapshot-dir> holds one file per registered basename, captured via
 * `git show origin/main:<basename>` BEFORE the caller's rebase ran (see
 * push-core-data/action.yml's "Commit and push core data" step) — reading
 * origin/main AFTER the rebase would see whatever the rebase just produced,
 * not the remote side that needs reconciling in.
 *
 * Runs from the private-repo checkout's cwd (files at root, no `data/`
 * prefix — the private repo checkout has no `data/` directory at all).
 *
 * Prints one changed basename per line to stdout, so the caller can `git add`
 * exactly those paths and amend — never a blanket `-A` (same reasoning as
 * reconcile-merged-json.js). Fails OPEN per file: a reconciliation error must
 * never block a push that would otherwise succeed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { activeEntriesFor } = require('./core-data-merge-registry');
const { TOMBSTONE_DIR, buildTombstoneRows, writeTombstones } = require('./merge-tombstones');
const { dropRetiredShowReviews } = require('./retired-show-reviews');

// BRO-7192: manual review rows of a retired show come back through the merge (it never drops
// a manualEntry row), so drop them here, against the merged-time shows.json beside reviews.json.
// Fails open: an unreadable registry or shows.json leaves the merge result as it is.
function dropRetiredReviews(result) {
  try {
    const retired = JSON.parse(fs.readFileSync('retired-show-ids.json', 'utf8')).map((e) => e && e.id).filter(Boolean);
    const live = (JSON.parse(fs.readFileSync('shows.json', 'utf8')).shows || []).map((s) => s.id);
    const { kept, dropped } = dropRetiredShowReviews(result.merged.reviews || [], retired, live);
    if (!dropped.length) return;
    result.merged.reviews = kept;
    if (result.merged._meta && result.merged._meta.stats) result.merged._meta.stats.totalReviews = kept.length;
    if (result.stats) { result.stats.totalReviews = kept.length; result.stats.droppedRetired = dropped.length; }
    console.error(`  dropped ${dropped.length} review row(s) of retired show(s): ${[...new Set(dropped.map((r) => r.showId))].join(', ')}`);
  } catch (e) {
    console.error(`  ::warning::retired-show review filter skipped (${String(e.message).slice(0, 120)})`);
  }
}

function main() {
  const [snapshotDir, baseDir] = process.argv.slice(2);
  if (!snapshotDir) { console.error('reconcile-core-data-registry: missing <remote-snapshot-dir>'); process.exit(0); }

  const changedFiles = [];
  for (const entry of activeEntriesFor('private-core-data')) {
    const localFile = entry.file;
    const remoteFile = path.join(snapshotDir, entry.file);
    try {
      if (!fs.existsSync(localFile) || !fs.existsSync(remoteFile)) continue;
      const before = fs.readFileSync(localFile, 'utf8');
      const remoteText = fs.readFileSync(remoteFile, 'utf8');
      if (!remoteText.trim()) continue; // empty capture (remote lacked the file, or capture failed) — nothing to reconcile
      const ours = JSON.parse(before);
      const remote = JSON.parse(remoteText);

      let base;
      if (baseDir && entry.merge.length >= 3) {
        try { base = JSON.parse(fs.readFileSync(path.join(baseDir, entry.file), 'utf8')); } catch { base = undefined; }
      }
      const result = entry.merge.length >= 3 ? entry.merge(ours, remote, base) : entry.merge(ours, remote);
      if (entry.file === 'reviews.json') dropRetiredReviews(result);
      const after = JSON.stringify(result.merged, null, 2) + (entry.newline === false ? '' : '\n');
      // Audit BEFORE the unchanged-bytes early exit: the common production shape
      // is a clean local file plus a remote-only fossil the merge declines to
      // carry, which leaves local bytes identical but is still a deletion
      // decision worth a durable record (BRO-2918). Fail open.
      try {
        const tomb = writeTombstones(TOMBSTONE_DIR, buildTombstoneRows(localFile, result.stats));
        if (tomb) changedFiles.push(tomb);
      } catch (te) { console.error(`  ::warning::tombstone write failed, deletion evidence is log-only (${String(te.message).slice(0, 120)})`); }
      if (after === before) continue;

      fs.writeFileSync(localFile, after);
      changedFiles.push(localFile);
      console.error(`  reconciled ${localFile} — ${JSON.stringify(result.stats)}`);
    } catch (e) {
      // Fail OPEN, loudly enough to debug but never blocking.
      console.error(`  ::warning::reconcile-core-data-registry: ${localFile} skipped (${String(e.message).slice(0, 120)})`);
    }
  }
  // Newline-TERMINATED: the caller consumes this with `while read -r f`, which
  // skips an unterminated last line — and the last line is the reconciled file
  // itself (tombstones are pushed first), so reviews.json was never staged and
  // the un-reconciled copy got pushed (BRO-4809).
  process.stdout.write(changedFiles.map((f) => f + '\n').join(''));
}

module.exports = { main };

if (require.main === module) main();
