/**
 * Acceptance for BRO-5282 (merge train), run by the nightly acceptance
 * recheck after RECHECK-AFTER: at least one real merge train has landed since
 * the train went live (2026-10-13T21:15Z), and every commit a train recorded
 * in data/audit/landings.jsonl is on origin/main. Reads the landings ledger
 * from origin/main (fetched), so it judges production, not this checkout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { trainsFromLandings } = require('../../scripts/lib/land-train.js');
const { parseLandings } = require('../../scripts/lib/landings-ledger.js');

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

// Before the recheck date this is not yet a fair question (a quiet queue forms
// no train), and a landing's own gate runs every changed test file: skip.
const RECHECK_AFTER = '2026-10-15';
const due = new Date().toISOString().slice(0, 10) >= RECHECK_AFTER;

test('BRO-5282: a merge train has landed in production, and all of its commits are on main', { skip: due ? false : `not due before ${RECHECK_AFTER}` }, () => {
  git(['fetch', '-q', 'origin', 'main']);
  // The recheck checkout is shallow (depth 1000) and main has taken tens of
  // thousands of commits since the train went live, so a train commit can be
  // absent from the clone without being off main (BRO-5282 false fail, 2026-11).
  // Deepen to the train's start with a blobless fetch (~25s), then judge.
  if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
    git(['fetch', '-q', '--filter=blob:none', '--shallow-since=2026-10-12', 'origin', 'main']);
  }
  const rows = parseLandings(git(['show', 'origin/main:data/audit/landings.jsonl']));
  const trains = trainsFromLandings(rows, '2026-10-13T21:15');
  assert.ok(trains.length >= 1, `no merge train in landings.jsonl since 2026-10-13T21:15Z (${rows.length} rows read)`);
  for (const tr of trains) {
    for (const sha of tr.shas) {
      assert.doesNotThrow(() => git(['cat-file', '-e', `${sha}^{commit}`]), `${sha} (train ${tr.runUrl}) is absent from the clone even after deepening`);
      assert.doesNotThrow(() => git(['merge-base', '--is-ancestor', sha, 'origin/main']), `${sha} (train ${tr.runUrl}: ${tr.branches.join(', ')}) is not on origin/main`);
    }
  }
});
