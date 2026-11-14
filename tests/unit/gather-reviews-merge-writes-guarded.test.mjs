/**
 * BRO-5791: gather-reviews.js merges into an existing review file only through
 * safeWriteReview (via writeMergedInto). A raw writeFileSync on
 * path.join(showDir, existingFile) bypasses the phantom / byline / cross-market
 * guards and misfiled same-URL siblings (BRO-5789). A raw write must carry an
 * explicit RAW-WRITE-OK marker on the line above.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const lines = fs.readFileSync(new URL('../../scripts/gather-reviews.js', import.meta.url), 'utf8').split('\n');

test('no unmarked raw writeFileSync into an existing review file', () => {
  const bad = [];
  lines.forEach((l, i) => {
    if (/fs\.writeFileSync\(path\.join\(showDir, existingFile\)/.test(l) && !/RAW-WRITE-OK/.test(lines[i - 1] || '')) bad.push(i + 1);
  });
  assert.deepEqual(bad, [], `raw merge writes at lines ${bad.join(', ')}`);
});

test('writeMergedInto routes through safeWriteReview and refuses on a blocked write', () => {
  const src = lines.join('\n');
  const m = src.match(/const writeMergedInto = [\s\S]*?\n  \};/);
  assert.ok(m, 'writeMergedInto missing');
  assert.match(m[0], /safeWriteReview\(/);
  assert.match(m[0], /return false/);
});
