import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findLogExclusionSites, parseUnifiedHunks, computeTouchedSites } = require('./scoring-delta.js');

// Task #1929: scoring-delta.js's Phase A replay (decideInclusion) is a
// hand-maintained mirror of review-guards.js only — it never executes
// rebuild-all-reviews.js's own ~60 logExclusion() call sites, which is the
// code that actually decides reviews.json inclusion. Confirmed empirically
// in task #1926: a check landed only in review-guards.js, this tool reported
// 0 flips, and a direct corpus scan found 722 reviews across 78 outlets
// would flip once the same check was wired into the real loop. These tests
// cover the detector added to close that blind spot.

describe('findLogExclusionSites', () => {
  test('finds every logExclusion( call site with its statKey and line number', () => {
    const source = [
      'function rebuild() {',
      '  logExclusion("skippedWrongProduction", showId, file, data);',
      '  if (x) {',
      '    logExclusion(\'skippedWrongShow\', showId, file, data);',
      '  }',
      '}',
    ].join('\n');
    const sites = findLogExclusionSites(source);
    assert.deepStrictEqual(sites, [
      { line: 2, statKey: 'skippedWrongProduction' },
      { line: 4, statKey: 'skippedWrongShow' },
    ]);
  });

  test('returns empty array when there are no logExclusion( calls', () => {
    assert.deepStrictEqual(findLogExclusionSites('const x = 1;\nfunction f() { return x; }'), []);
  });
});

describe('parseUnifiedHunks', () => {
  test('parses standard @@ -a,b +c,d @@ headers', () => {
    const diff = [
      'diff --git a/f.js b/f.js',
      '--- a/f.js',
      '+++ b/f.js',
      '@@ -10,3 +10,4 @@ function foo() {',
      '-old line',
      '+new line',
      '+another new line',
    ].join('\n');
    assert.deepStrictEqual(parseUnifiedHunks(diff), [{ oldStart: 10, oldLen: 3, newStart: 10, newLen: 4 }]);
  });

  test('defaults omitted length to 1 (single-line hunk)', () => {
    const diff = '@@ -42 +42 @@';
    assert.deepStrictEqual(parseUnifiedHunks(diff), [{ oldStart: 42, oldLen: 1, newStart: 42, newLen: 1 }]);
  });

  test('parses multiple hunks in one diff', () => {
    const diff = [
      '@@ -5,2 +5,2 @@',
      '-a',
      '+b',
      '@@ -100,1 +101,1 @@',
      '-c',
      '+d',
    ].join('\n');
    assert.strictEqual(parseUnifiedHunks(diff).length, 2);
  });
});

describe('computeTouchedSites', () => {
  const oldContent = Array.from({ length: 200 }, (_, i) => {
    const line = i + 1;
    if (line === 100) return '  logExclusion("skippedPreOpening", showId, file, data);';
    return `// line ${line}`;
  }).join('\n');

  test('flags a hunk that lands within the proximity window of a logExclusion( site', () => {
    // Edit at old line 95 — 5 lines before the logExclusion at line 100, well
    // inside EXCLUSION_PROXIMITY_WINDOW (12).
    const newContent = oldContent.replace('// line 95', '// line 95 EDITED');
    const hunks = [{ oldStart: 95, oldLen: 1, newStart: 95, newLen: 1 }];
    const result = computeTouchedSites(oldContent, newContent, hunks);
    assert.strictEqual(result.touched, true, 'expected an edit 5 lines from a logExclusion( call to be flagged');
    assert.ok(result.sites.some(s => s.statKey === 'skippedPreOpening'));
  });

  test('does not flag a hunk far from any logExclusion( site', () => {
    const newContent = oldContent.replace('// line 1', '// line 1 EDITED');
    const hunks = [{ oldStart: 1, oldLen: 1, newStart: 1, newLen: 1 }];
    const result = computeTouchedSites(oldContent, newContent, hunks);
    assert.strictEqual(result.touched, false, 'edit at line 1 is >12 lines from the logExclusion( call at line 100');
    assert.deepStrictEqual(result.sites, []);
  });

  test('flags a NEW logExclusion( call site added near an edit', () => {
    // Simulates the exact task #1926 shape: a brand-new exclusion check added
    // to rebuild-all-reviews.js's loop, near (but not literally on) an
    // existing call site.
    const lines = oldContent.split('\n');
    lines[97] = '  logExclusion("skippedNewCheck", showId, file, data); // line 98, new';
    const newContent = lines.join('\n');
    const hunks = [{ oldStart: 98, oldLen: 0, newStart: 98, newLen: 1 }];
    const result = computeTouchedSites(oldContent, newContent, hunks);
    assert.strictEqual(result.touched, true);
    assert.ok(result.sites.some(s => s.statKey === 'skippedNewCheck' && s.side === 'new'));
  });

  test('returns untouched when there are no hunks at all', () => {
    assert.deepStrictEqual(computeTouchedSites(oldContent, oldContent, []), { touched: false, sites: [] });
  });
});
