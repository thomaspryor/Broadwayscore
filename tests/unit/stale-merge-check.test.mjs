/**
 * BRO-3790: ingest-review-from-url.js's merge-into-existing path
 * (createOrMergeReviewFile → review-file-writer.js _mergeIntoExisting) only
 * fills fields that are currently BLANK on the existing file — a merge onto
 * a file with a non-blank-but-WRONG url/criticName/fullText silently keeps
 * the old value while the caller still prints "✅ Updated" and exits 0.
 *
 * findStaleMergeFields (scripts/lib/stale-merge-check.js) is the fix's
 * detection primitive: diff what the ingest INTENDED to establish against
 * what actually landed on disk. This file tests that pure function
 * directly; ingest-review-from-url-stale-merge.test.mjs below exercises it
 * wired against the real createOrMergeReviewFile merge path.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findStaleMergeFields } = require('../../scripts/lib/stale-merge-check.js');

describe('findStaleMergeFields', () => {
  test('reports fields where the intended value did not land', () => {
    const stale = findStaleMergeFields(
      { url: 'https://outlet.com/real-review/' },
      { url: 'https://outlet.com/dead-end-forum-thread/' },
    );
    assert.deepEqual(stale, ['url']);
  });

  test('reports every mismatched field, not just the first', () => {
    const stale = findStaleMergeFields(
      { url: 'https://outlet.com/real/', fullText: 'the real body', criticName: 'Jane Critic' },
      { url: 'https://outlet.com/stale/', fullText: 'the old stale body', criticName: 'Unknown' },
    );
    assert.deepEqual(stale.sort(), ['criticName', 'fullText', 'url']);
  });

  test('a clean merge (intended values landed) reports nothing', () => {
    const stale = findStaleMergeFields(
      { url: 'https://outlet.com/real/', fullText: 'the real body' },
      { url: 'https://outlet.com/real/', fullText: 'the real body', outletId: 'outlet' },
    );
    assert.deepEqual(stale, []);
  });

  test('omitted keys are never checked — no opinion means no mismatch', () => {
    // criticName was auto-extracted, not explicitly asserted by the caller —
    // the caller should omit it from `intended` entirely rather than pass it.
    const stale = findStaleMergeFields(
      { url: 'https://outlet.com/real/' },
      { url: 'https://outlet.com/real/', criticName: 'Whatever Was There Before' },
    );
    assert.deepEqual(stale, []);
  });

  test('null/undefined intended values are skipped, not treated as "must be null"', () => {
    const stale = findStaleMergeFields(
      { url: 'https://outlet.com/real/', fullText: null },
      { url: 'https://outlet.com/real/', fullText: 'some text' },
    );
    assert.deepEqual(stale, []);
  });

  test('a missing/unreadable landed record flags every intended field stale', () => {
    const stale = findStaleMergeFields({ url: 'https://outlet.com/real/' }, null);
    assert.deepEqual(stale, ['url']);
  });
});
