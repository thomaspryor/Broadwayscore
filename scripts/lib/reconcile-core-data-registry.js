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
 *   node scripts/lib/reconcile-core-data-registry.js <remote-snapshot-dir>
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

function main() {
  const [snapshotDir] = process.argv.slice(2);
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

      const result = entry.merge(ours, remote);
      const after = JSON.stringify(result.merged, null, 2) + (entry.newline === false ? '' : '\n');
      if (after === before) continue;

      fs.writeFileSync(localFile, after);
      changedFiles.push(localFile);
      console.error(`  reconciled ${localFile} — ${JSON.stringify(result.stats)}`);
    } catch (e) {
      // Fail OPEN, loudly enough to debug but never blocking.
      console.error(`  ::warning::reconcile-core-data-registry: ${localFile} skipped (${String(e.message).slice(0, 120)})`);
    }
  }
  process.stdout.write(changedFiles.join('\n'));
}

module.exports = { main };

if (require.main === module) main();
