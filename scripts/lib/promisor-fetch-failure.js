#!/usr/bin/env node
'use strict';
// Classifier for a rebase that died because of a PARTIAL-CLONE lazy fetch,
// not because of the patches (BRO-4141 class, seen first on land/our-sinatra,
// run 36351955579, 2026-09-27; BRO-4219 extends it to push-with-retry.sh).
//
// A blobless clone (`fetch-depth: 0` + `filter: blob:none`, the checkout
// land.yml, autonomous-merge.yml, check-direct-push-to-main.yml and the
// opening-night poller use) holds the full commit graph but no historical
// blobs; git fetches missing blobs lazily, in batches, the first time
// something reads them. Mid-rebase, a batch can name a blob the rebase itself
// just wrote (a 3-way merge result) that its cached lookup missed. GitHub
// answers `not our ref` for that id, the whole batch dies, and the rebase
// fails with NO conflict. A fresh process sees the blobs the failed pass
// wrote, so retrying the rebase gets further each time — that retry is the
// cure, and this function is the one place that decides when it applies.
//
// Shared by scripts/lib/land-branch.js (rebaseOnto) and, through the CLI at
// the bottom, scripts/lib/push-with-retry.sh (_rebase_with_promisor_retry).
// CLAUDE.md §15: one definition, required by both callers and by the tests,
// never copied into bash as a second regex.

const PROMISOR_ERR_RE = /promisor remote|not our ref/i;
const REBASE_CONFLICT_RE = /CONFLICT|could not apply/;
// How many times a rebase that dies this way is retried before the caller
// falls back to its ordinary failure handling.
const PROMISOR_REBASE_RETRIES = 3;

/**
 * A rebase failure caused by a partial-clone lazy fetch, not by the patches.
 * A real content conflict is never masked: if the stderr also reports one,
 * the answer is false and the caller's conflict handling runs as before.
 * @param {string|undefined} stderr
 * @returns {boolean}
 */
function isPromisorFetchFailure(stderr) {
  const text = String(stderr || '');
  return PROMISOR_ERR_RE.test(text) && !REBASE_CONFLICT_RE.test(text);
}

module.exports = { isPromisorFetchFailure, PROMISOR_ERR_RE, PROMISOR_REBASE_RETRIES };

// CLI for the shell caller:
//   node promisor-fetch-failure.js <stderr-file>
//   ... | node promisor-fetch-failure.js -        (read stdin)
// Exit 0 = promisor lazy-fetch failure (retry the rebase), 1 = anything else
// (take the ordinary path), 2 = usage/read error (callers treat as 1 — the
// classifier failing must never widen the retry).
if (require.main === module) {
  const fs = require('fs');
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: promisor-fetch-failure.js <stderr-file> | -');
    process.exit(2);
  }
  let text;
  try {
    text = fs.readFileSync(arg === '-' ? 0 : arg, 'utf8');
  } catch (e) {
    console.error(`promisor-fetch-failure: cannot read ${arg}: ${e.message}`);
    process.exit(2);
  }
  process.exit(isPromisorFetchFailure(text) ? 0 : 1);
}
