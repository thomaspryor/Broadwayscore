// purely structural: the detector under test parses synthetic YAML strings
// plus the real opening-night-poller.yml; it never reads data/*.json.
/**
 * Unit tests for findRebuildWithoutMemoRestore (rule (y2), BRO-8012): a job
 * that runs scripts/rebuild-all-reviews.js without restoring the fingerprint
 * memo first. The poller's readiness rebuild ran cold, took 12-34 min against
 * a 10-min step timeout, and paged the owner on every review night.
 *
 * Pattern: require() the real function; never copy logic into tests
 * (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findRebuildWithoutMemoRestore } = require('../../scripts/audit-workflow-hygiene.js');

const RESTORE = `      - name: Restore fingerprint memo
        uses: actions/cache/restore@v5
        with:
          path: .cache/rebuild-fp-cache.json
          key: rebuild-fp-memo-v1-x
`;
const REBUILD = `      - name: Rebuild
        run: node scripts/rebuild-all-reviews.js
`;
const wf = (jobs) => `name: t\non: push\njobs:\n${jobs}`;
const job = (name, steps) => `  ${name}:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n${steps}`;

describe('findRebuildWithoutMemoRestore', () => {
  test('flags a cold rebuild (the BRO-8012 readiness-rebuild shape)', () => {
    const hits = findRebuildWithoutMemoRestore(wf(job('poll', REBUILD)));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].job, 'poll');
  });

  test('passes when the memo is restored earlier in the same job', () => {
    assert.deepEqual(findRebuildWithoutMemoRestore(wf(job('poll', RESTORE + REBUILD))), []);
  });

  test('a restore AFTER the rebuild does not count', () => {
    assert.equal(findRebuildWithoutMemoRestore(wf(job('poll', REBUILD + RESTORE))).length, 1);
  });

  test('a restore in a different job does not count', () => {
    const hits = findRebuildWithoutMemoRestore(wf(job('a', RESTORE) + job('b', REBUILD)));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].job, 'b');
  });

  test('commented-out calls and commented memo paths are ignored', () => {
    const steps = `      # path: .cache/rebuild-fp-cache.json\n      - name: x\n        run: |\n          # node scripts/rebuild-all-reviews.js\n          echo hi\n`;
    assert.deepEqual(findRebuildWithoutMemoRestore(wf(job('poll', steps))), []);
    const commentedMemo = `      # path: .cache/rebuild-fp-cache.json\n${REBUILD}`;
    assert.equal(findRebuildWithoutMemoRestore(wf(job('poll', commentedMemo))).length, 1);
  });

  test('job-level exemption marker', () => {
    const steps = `      # hygiene-rebuild-memo-ok: one-off backfill, time does not matter\n${REBUILD}`;
    assert.deepEqual(findRebuildWithoutMemoRestore(wf(job('poll', steps))), []);
  });

  test('the real opening-night poller restores the memo before every rebuild call', () => {
    const raw = fs.readFileSync(path.join(import.meta.dirname, '../../.github/workflows/opening-night-poller.yml'), 'utf8');
    assert.deepEqual(findRebuildWithoutMemoRestore(raw), []);
  });
});

describe('restore gated narrower than the rebuild (the actual BRO-8012 bug)', () => {
  const gated = (restoreIf, rebuildIf) => wf(job('poll',
    RESTORE.replace('        uses:', `        if: ${restoreIf}\n        uses:`) +
    REBUILD.replace('        run:', `        if: ${rebuildIf}\n        run:`)));

  test('pre-fix poller shape: restore only on fast_path, readiness rebuild off it -> flagged', () => {
    const hits = findRebuildWithoutMemoRestore(gated(
      "inputs.fast_path && steps.find.outputs.has_shows == 'true' && (steps.poll.outputs.any_action == 'true' || steps.nyt_picks.outputs.picks_added == 'true')",
      "steps.find.outputs.has_shows == 'true' && steps.poll.outputs.any_action == 'true' && steps.fast_rebuild.outcome != 'success'",
    ));
    assert.equal(hits.length, 1);
    assert.match(hits[0].reason, /gated/);
  });

  test('post-fix shape: an a||b restore conjunct is implied by a rebuild conjunct', () => {
    assert.deepEqual(findRebuildWithoutMemoRestore(gated(
      "steps.find.outputs.has_shows == 'true' && (steps.poll.outputs.any_action == 'true' || steps.nyt_picks.outputs.picks_added == 'true')",
      "steps.find.outputs.has_shows == 'true' && steps.poll.outputs.any_action == 'true' && steps.fast_rebuild.outcome != 'success'",
    )), []);
  });

  test('an unconditional restore covers any rebuild; a gated rebuild under an equal gate is covered', () => {
    assert.deepEqual(findRebuildWithoutMemoRestore(wf(job('poll', RESTORE + REBUILD.replace('        run:', "        if: inputs.x == 'y'\n        run:")))), []);
    assert.deepEqual(findRebuildWithoutMemoRestore(gated("inputs.x == 'y'", "inputs.x == 'y'")), []);
  });
});
