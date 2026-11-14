// BRO-4313: detector for code that raw-means reviews' assignedScore instead of
// the canonical Critic Score. Fixtures mirror the shapes that shipped.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findRawMeanLines, auditRawMeanScores, isScannable, ALLOWLIST } = require('./raw-mean-scores.js');

describe('findRawMeanLines — flags raw means', () => {
  test('reduce + divide by length on one line (related-shows-scores / validate-consensus shape)', () => {
    const src = [
      'const showReviews = reviews.filter(r => r.showId === id);',
      'const avg = showReviews.reduce((sum, r) => sum + r.assignedScore, 0) / showReviews.length;',
    ].join('\n');
    assert.deepEqual(findRawMeanLines(src), [2]);
  });

  test('scores mapped into a variable, then mean()', () => {
    const src = [
      'const scores = rs.map(r => r.assignedScore).filter(Boolean);',
      'console.log("x");',
      'const avg = mean(scores);',
    ].join('\n');
    assert.deepEqual(findRawMeanLines(src), [1]);
  });

  test('accumulator divided by a count', () => {
    const src = [
      'let total = 0; let n = 0;',
      'for (const r of rs) { total += r.assignedScore; n++; }',
      'const avg = total / n;',
    ].join('\n');
    assert.deepEqual(findRawMeanLines(src), [2]);
  });
});

describe('findRawMeanLines — multi-line and helper shapes (ship-check review)', () => {
  const cases = {
    'multi-line reduce': ['const avg = rs.reduce((s, r) =>', '  s + r.assignedScore, 0) / rs.length;'],
    'chained filter/map then mean': ['const scores = rs', '  .filter(r => r.ok)', '  .map(r => r.assignedScore);', 'const a = mean(scores);'],
    'any average-named helper': ['const xs = rs.map(r => r.assignedScore);', 'return getAverage(xs);'],
    'lodash sumBy / n': ['const a = _.sumBy(rs, r => r.assignedScore) / n;'],
    'lodash meanBy': ["const a = _.meanBy(rs, 'assignedScore');"],
    '$-named variable': ['const $s = rs.map(r => r.assignedScore);', 'const a = $s.reduce((x, y) => x + y, 0) / $s.length;'],
    "a '//' inside a string does not hide code": ["const u = 'a//b'; const a = rs.reduce((s, r) => s + r.assignedScore, 0) / rs.length;"],
  };
  for (const [name, src] of Object.entries(cases)) {
    test(name, () => assert.ok(findRawMeanLines(src.join('\n')).length > 0, name));
  }
});

describe('findRawMeanLines — ignores non-averages', () => {
  test('a count percentage near a score filter is not a mean', () => {
    const src = [
      'const extra = scored.filter((r) => r.assignedScore > 0).map((r) => r.outlet);',
      'const pct = results.length ? scoredCount / results.length : 0;',
    ].join('\n');
    assert.deepEqual(findRawMeanLines(src), []);
  });

  test('comments mentioning the bad pattern are ignored', () => {
    const src = [
      '// never do: rs.reduce((a, r) => a + r.assignedScore, 0) / rs.length',
      '/* avg = mean(rs.map(r => r.assignedScore)) */',
      'const s = getCriticScore(id);',
    ].join('\n');
    assert.deepEqual(findRawMeanLines(src), []);
  });

  test('the canonical scorer shape (score copied, weighted sum) is not flagged', () => {
    const src = [
      'let score = review.assignedScore;',
      'if (score == null) continue;',
      'weightedSum += score * tierWeight * confidenceWeight * outletShare;',
      'totalWeight += tierWeight * confidenceWeight * outletShare;',
      'const weightedScore = Math.round((weightedSum / totalWeight) * 100) / 100;',
    ].join('\n');
    assert.deepEqual(findRawMeanLines(src), []);
  });

  test('bucket counting by score threshold is not flagged', () => {
    const src = [
      'const positive = showReviews.filter(r => r.assignedScore >= 65).length;',
      'const negative = showReviews.filter(r => r.assignedScore < 55).length;',
    ].join('\n');
    assert.deepEqual(findRawMeanLines(src), []);
  });
});

describe('auditRawMeanScores', () => {
  const bad = 'const a = rs.reduce((s, r) => s + r.assignedScore, 0) / rs.length;';
  test('splits violations from allowlisted files and reports stale entries', () => {
    const r = auditRawMeanScores(
      [{ path: 'scripts/new.js', source: bad }, { path: 'scripts/ok.js', source: bad }, { path: 'scripts/clean.js', source: 'x()' }],
      { 'scripts/ok.js': 'diagnostic', 'scripts/gone.js': 'removed file' },
    );
    assert.deepEqual(r.violations, [{ path: 'scripts/new.js', lines: [1] }]);
    assert.deepEqual(r.allowed.map((a) => a.path), ['scripts/ok.js']);
    assert.deepEqual(r.staleAllowlist, ['scripts/gone.js']);
  });

  test('every allowlist entry carries a reason', () => {
    for (const [p, why] of Object.entries(ALLOWLIST)) assert.ok(why && why.length > 20, `${p} needs a reason`);
  });
});

test('isScannable skips tests, fixtures and non-code', () => {
  assert.equal(isScannable('scripts/foo.js'), true);
  assert.equal(isScannable('src/lib/engine.ts'), true);
  assert.equal(isScannable('scripts/lib/foo.test.mjs'), false);
  assert.equal(isScannable('tests/unit/foo.ts'), false);
  assert.equal(isScannable('scripts/fixtures/x.js'), false);
  assert.equal(isScannable('scripts/data.json'), false);
});
