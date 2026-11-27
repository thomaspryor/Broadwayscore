/**
 * BRO-5572 backlog ceiling: the live reviews.json Unknown/missing critic count may not grow past
 * what was measured (2,979 on 2026-11-27, ceiling 3,000). Lower it as parser fixes land
 * (unknown-critic-backlog.test.mjs holds the parser cases). Live-data lane (-live-data name,
 * BRO-7101): reviews.json is rebuilt by bots. Skipped when data is absent.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const UNKNOWN_CEILING = 3000;

describe('Unknown-critic backlog ceiling', () => {
  const file = path.join(ROOT, 'data/reviews.json');
  test(`live reviews.json carries at most ${UNKNOWN_CEILING} Unknown/missing critic names`, { skip: !fs.existsSync(file) && 'data/reviews.json not present' }, () => {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const reviews = Array.isArray(data) ? data : data.reviews || [];
    assert.ok(reviews.length > 1000, `reviews.json looks truncated (${reviews.length} rows)`);
    const unknown = reviews.filter((r) => !r.criticName || /^(unknown|unnamed)$/i.test(String(r.criticName).trim())).length;
    assert.ok(unknown <= UNKNOWN_CEILING, `${unknown} reviews have no critic name (ceiling ${UNKNOWN_CEILING}); fix the source parser, do not raise the ceiling`);
  });
});
