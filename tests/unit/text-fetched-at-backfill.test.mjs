/**
 * BRO-4490: truncated-text-scored files without textFetchedAt get one, so
 * isTruncatedScoreNowComplete can detect a complete text that landed later.
 *
 * Run: node --test tests/unit/text-fetched-at-backfill.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { needsTextFetchedAtBackfill, chooseTextFetchedAt, fullTextChangedAtFromVersions, backfillFields } = require('../../scripts/lib/text-fetched-at-backfill.js');
const { isTruncatedScoreNowComplete } = require('../../scripts/lib/rescore-flagging.js');

const complete = 'This production is a careful, well acted evening and the ending lands with real force. '.repeat(40).trim();
const rec = (over = {}) => ({
  fullText: complete,
  contentTier: 'complete',
  llmMetadata: { scoredAt: '2026-05-01T10:00:00.000Z', textSource: { type: 'fullText', status: 'truncated' } },
  firstSeenAt: '2026-04-30T09:00:00-04:00',
  ...over,
});

describe('needsTextFetchedAtBackfill', () => {
  test('truncated fullText score without textFetchedAt', () => assert.equal(needsTextFetchedAtBackfill(rec()), true));
  test('already stamped', () => assert.equal(needsTextFetchedAtBackfill(rec({ textFetchedAt: '2026-05-02T00:00:00Z' })), false));
  test('scored on an excerpt', () => assert.equal(needsTextFetchedAtBackfill(rec({ llmMetadata: { textSource: { type: 'excerpt' } } })), false));
  test('scored on complete text', () => assert.equal(needsTextFetchedAtBackfill(rec({ llmMetadata: { textSource: { type: 'fullText', status: 'complete' } } })), false));
});

describe('chooseTextFetchedAt', () => {
  test('git fullText change wins', () => {
    assert.deepEqual(chooseTextFetchedAt(rec(), { fullTextChangedAt: '2026-05-03T12:00:00+00:00' }),
      { value: '2026-05-03T12:00:00.000Z', source: 'git-fulltext-change' });
  });
  test('falls back to firstSeenAt, then addedAt, then collectedAt', () => {
    assert.equal(chooseTextFetchedAt(rec()).source, 'firstSeenAt');
    assert.equal(chooseTextFetchedAt(rec({ firstSeenAt: undefined, addedAt: '2026-04-29T00:00:00Z' })).source, 'addedAt');
    assert.equal(chooseTextFetchedAt(rec({ firstSeenAt: 'garbage', collectedAt: '2026-04-29T00:00:00Z' })).source, 'collectedAt');
  });
  test('nothing known: null', () => assert.equal(chooseTextFetchedAt(rec({ firstSeenAt: undefined })), null));
});

describe('fullTextChangedAtFromVersions', () => {
  test('oldest consecutive commit with the current text, once an older different text proves the change', () => {
    const v = [{ at: 'T3', fullText: 'new' }, { at: 'T2', fullText: 'new' }, { at: 'T1', fullText: 'old' }];
    assert.equal(fullTextChangedAtFromVersions('new', v), 'T2');
  });
  test('shallow history that never shows the change: null', () => {
    assert.equal(fullTextChangedAtFromVersions('new', [{ at: 'T3', fullText: 'new' }]), null);
  });
  test('history reaching the creation commit counts', () => {
    assert.equal(fullTextChangedAtFromVersions('new', [{ at: 'T3', fullText: 'new' }], { reachedCreation: true }), 'T3');
  });
  test('uncommitted working-tree text: null', () => {
    assert.equal(fullTextChangedAtFromVersions('newer', [{ at: 'T3', fullText: 'new' }]), null);
  });
});

describe('end to end with isTruncatedScoreNowComplete', () => {
  test('a git-dated complete text that landed after scoring is detected', () => {
    const d = rec();
    assert.equal(isTruncatedScoreNowComplete(d), false, 'undetectable without textFetchedAt');
    Object.assign(d, backfillFields(chooseTextFetchedAt(d, { fullTextChangedAt: '2026-05-03T12:00:00Z' })));
    assert.equal(isTruncatedScoreNowComplete(d), true);
  });
  test('a firstSeenAt fallback (before scoring) never makes the score look stale', () => {
    const d = rec();
    Object.assign(d, backfillFields(chooseTextFetchedAt(d)));
    assert.equal(d.textFetchedAtBackfill, 'firstSeenAt');
    assert.equal(isTruncatedScoreNowComplete(d), false);
  });
});
