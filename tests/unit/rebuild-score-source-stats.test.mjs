/**
 * BRO-4204 S7-T11: `_meta.stats.scoreSources` in reviews.json reported null
 * for 'llm-v6', 'anchored-v6' and 'adjudicated' — the three MAIN score
 * sources — because rebuild-all-reviews.js seeded the counter object from a
 * hand-copied subset of labels and `undefined++` is NaN (serialised as null).
 *
 * The fix: scripts/lib/rebuild-helpers.js exports SCORE_SOURCE_LABELS (every
 * `source` getBestScore() can emit) and rebuild-all-reviews.js seeds the
 * counter from it. This test require()s the real constant and scans the real
 * getBestScore() source so a new label without a matching entry fails here,
 * not in the next reviews.json (CLAUDE.md §15 — never copy the list).
 *
 * Run: node --test tests/unit/rebuild-score-source-stats.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
const { SCORE_SOURCE_LABELS, getBestScore } = require(path.join(ROOT, 'scripts/lib/rebuild-helpers.js'));

const helpersSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/rebuild-helpers.js'), 'utf8');
const rebuildSrc = fs.readFileSync(path.join(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');

function getBestScoreBody() {
  const start = helpersSrc.indexOf('function getBestScore(');
  assert.ok(start > 0, 'getBestScore must exist');
  const end = helpersSrc.indexOf('\n}\n', start);
  return helpersSrc.slice(start, end);
}

describe('SCORE_SOURCE_LABELS covers every source getBestScore can emit', () => {
  test('the three sources the audit found null are listed', () => {
    for (const label of ['llm-v6', 'anchored-v6', 'adjudicated']) {
      assert.ok(SCORE_SOURCE_LABELS.includes(label), `${label} must be a seeded label`);
    }
  });

  test("every `source: '…'` literal in getBestScore is in the list, and vice versa", () => {
    const body = getBestScoreBody();
    const emitted = new Set([...body.matchAll(/source: '([^']+)'/g)].map((m) => m[1]));
    // Inline ternaries: `source: <cond> ? 'a' : 'b'` (the thumb-validated/boosted pair)
    for (const m of body.matchAll(/source: [^;'\n]*\? '([^']+)' : '([^']+)'/g)) {
      emitted.add(m[1]);
      emitted.add(m[2]);
    }
    // The one variable-valued source: effectiveV6Source = … ? 'anchored-v6' : 'llm-v6'
    const v6 = body.match(/effectiveV6Source = [^;]*\? '([^']+)' : '([^']+)'/);
    assert.ok(v6, 'the v6 source ternary must still exist');
    emitted.add(v6[1]);
    emitted.add(v6[2]);
    // The P0.5 source: p05Source = … ? 'aggregatorStars-relay' : 'originalScore-priority0'
    const p05 = body.match(/p05Source = [^;]*\? '([^']+)' : '([^']+)'/);
    assert.ok(p05, 'the P0.5 source ternary must still exist');
    emitted.add(p05[1]);
    emitted.add(p05[2]);

    const missing = [...emitted].filter((l) => !SCORE_SOURCE_LABELS.includes(l));
    assert.deepEqual(missing, [], `labels emitted by getBestScore but not seeded: ${missing.join(', ')}`);
    const stale = SCORE_SOURCE_LABELS.filter((l) => !emitted.has(l));
    assert.deepEqual(stale, [], `seeded labels getBestScore no longer emits: ${stale.join(', ')}`);
  });

  test('the list is frozen and has no duplicates', () => {
    assert.ok(Object.isFrozen(SCORE_SOURCE_LABELS));
    assert.equal(new Set(SCORE_SOURCE_LABELS).size, SCORE_SOURCE_LABELS.length);
  });

  test('sanity: the real getBestScore emits the three main sources with a matching file shape', () => {
    assert.equal(getBestScore({ humanReviewScore: 0, adjudicatedScore: 77 }).source, 'adjudicated');
    assert.equal(getBestScore({ scoreSource: 'llm-v6', llmScore: { score: 71 } }).source, 'llm-v6');
    assert.equal(getBestScore({ scoreSource: 'anchored-v6', llmScore: { score: 79 } }).source, 'anchored-v6');
  });
});

describe('rebuild-all-reviews.js seeds scoreSources from SCORE_SOURCE_LABELS', () => {
  test('imports the constant and spreads it into the stats seed', () => {
    assert.match(rebuildSrc, /SCORE_SOURCE_LABELS \} = require\('\.\/lib\/rebuild-helpers'\)/, 'must import SCORE_SOURCE_LABELS from the real helper');
    assert.match(rebuildSrc, /scoreSources: \{[\s\S]*?\.\.\.Object\.fromEntries\(SCORE_SOURCE_LABELS\.map\(\(label\) => \[label, 0\]\)\)/, 'scoreSources seed must spread every label at 0');
  });

  test('the counter stays safe for a label outside the seed (S6-T5)', () => {
    assert.match(rebuildSrc, /stats\.scoreSources\[source\] = \(stats\.scoreSources\[source\] \|\| 0\) \+ 1;/);
  });

  test('a seed built the same way reports 0, never null, for every label (the reviews.json contract)', () => {
    const seed = {
      'explicit-stars': 0,
      ...Object.fromEntries(SCORE_SOURCE_LABELS.map((label) => [label, 0])),
      originalScore: 0,
    };
    const roundTripped = JSON.parse(JSON.stringify(seed));
    for (const label of ['llm-v6', 'anchored-v6', 'adjudicated', ...SCORE_SOURCE_LABELS]) {
      assert.equal(roundTripped[label], 0, `${label} must serialise as 0`);
    }
    assert.ok(!Object.values(roundTripped).some((v) => v === null || Number.isNaN(v)));
  });
});
