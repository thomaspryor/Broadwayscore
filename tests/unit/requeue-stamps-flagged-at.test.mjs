/**
 * BRO-4804: a script that requeues a review by clearing rescoreCompletedAt must also
 * stamp rescoreFlaggedAt. Without it the staged copy's scoring stamp drops below
 * HEAD's, and push-review-texts' carryNewerScoring copies HEAD's scoring group back
 * over the flag, silently un-flagging every previously drained file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '../../scripts');
// strip-stale-single-model-scores nulls llmScore (carry never resurrects those);
// archive-previous-scores only cleans orphaned stamps when needsRescore is already gone.
const EXEMPT = new Set(['strip-stale-single-model-scores.js', 'archive-previous-scores.js']);
const CLEARS = /(delete\s+[\w.]+\.rescoreCompletedAt|\.rescoreCompletedAt\s*=\s*null)/;

test('every script that clears rescoreCompletedAt also stamps rescoreFlaggedAt', () => {
  const offenders = [];
  let seen = 0;
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js') && !EXEMPT.has(n))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!CLEARS.test(src)) continue;
    seen++;
    if (!/rescoreFlaggedAt\s*=/.test(src)) offenders.push(f);
  }
  assert.ok(seen >= 6, `expected to find the requeue scripts, saw ${seen}`);
  assert.deepEqual(offenders, []);
});
