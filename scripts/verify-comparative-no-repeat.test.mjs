/**
 * verify-comparative-no-repeat.test.mjs — RECHECK-AFTER acceptance probe for
 * BRO-4467 (comparative-rescore re-spending on the same band groups).
 *
 * Before the fix, data/llm-scoring-runs.json showed the same comparative pass
 * (identical processed + input-token counts, e.g. 158/415935) recorded 27
 * times in ~13h, ~$1.16 each. Once the fix is live, a group is paid for once
 * and then skipped, so an identical non-trivial signature should not recur.
 *
 * Reads LIVE repo data, not a fixture: run by
 * scripts/autonomous-acceptance-recheck.js at the card's RECHECK-AFTER date,
 * never by CI (registered in audit-orphan-tests.js EXEMPT_NEVER_CI). A red run
 * means the claim is disproven, not that code regressed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.join(HERE, '..', 'data', 'llm-scoring-runs.json');
// The fix landed on main at ~13:01Z; allow the in-flight pre-fix runs to finish.
const FIX_LIVE_AT = '2026-10-01T14:00:00.000Z';
// Below this many reviews a repeat is a tiny group, not the costly loop.
const MIN_PROCESSED = 20;

test('no costly comparative pass repeats 3+ times after the BRO-4467 fix', () => {
  const runs = JSON.parse(fs.readFileSync(RUNS, 'utf8'));
  const after = runs.filter((r) => (r.startedAt || '') >= FIX_LIVE_AT);
  assert.ok(after.length >= 5, `only ${after.length} scoring run(s) recorded since ${FIX_LIVE_AT}; not enough history to judge yet`);

  const counts = new Map();
  for (const r of after) {
    if (!r.processed || r.processed < MIN_PROCESSED) continue;
    const key = `${r.processed}/${r.tokensUsed && r.tokensUsed.input}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const repeats = [...counts].filter(([, n]) => n >= 3);
  assert.deepEqual(repeats, [], `identical scoring passes repeated 3+ times since the fix: ${JSON.stringify(repeats)}`);
});
