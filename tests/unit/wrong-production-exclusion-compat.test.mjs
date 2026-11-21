import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const trend = require('../../scripts/lib/exclusion-trend');
const narrow = require('../../scripts/lib/wrong-production-exclusion-analysis');
const reason = 'skippedWrongProduction';
const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n');

it('shares the JSONL parser without a circular dependency', () => {
  assert.equal(narrow.parseExclusionLog, trend.parseExclusionLog);
  assert.deepEqual(trend.parseExclusionLog('\nheader\nnull\n{"file":"a.json"}\n'), [null, { file: 'a.json' }]);
});

it('delegates all four compatibility entry points to the generalized functions', (t) => {
  const grouping = t.mock.method(trend, 'summarizeByReasonAndShow');
  const categorizing = t.mock.method(trend, 'categorizeGroup');
  const analyzing = t.mock.method(trend, 'analyzeExclusionLog');
  const ledger = t.mock.method(trend, 'buildNextLedger');
  const records = [
    { showId: 'a', file: 'a.json', reason },
    { showId: 'a', file: 'other.json', reason: 'skippedNotReview' },
  ];
  const entry = narrow.summarizeByShow(records).get('a');
  narrow.categorizeShow(entry);
  narrow.analyzeExclusionLog(jsonl(records));
  narrow.buildNextLedger(records);
  for (const fn of [grouping, categorizing, analyzing, ledger]) assert.equal(fn.mock.callCount(), 1);
  assert.deepEqual(grouping.mock.calls[0].arguments[0], [records[0]]);
  assert.deepEqual(trend.parseExclusionLog(analyzing.mock.calls[0].arguments[0]), [records[0]]);
  assert.deepEqual(ledger.mock.calls[0].arguments[0], [records[0]]);
});

it('preserves the exact aggregate result, including a total not divisible by file count', () => {
  const entry = { showId: 'a', totalLines: 5, files: new Set(['a.json', 'b.json']) };
  assert.deepEqual(narrow.categorizeShow(entry, { knownFiles: new Set(['a.json']) }), {
    showId: 'a', totalLines: 5, distinctFiles: 2, repeatMultiplier: 2.5, newFileCount: 1, category: 'NEEDS_REVIEW',
  });
  const group = trend.categorizeGroup(entry, { knownFiles: new Set(['a.json']) });
  assert.equal(group.newFileCount, 1);
  assert.equal(Object.hasOwn(group, 'newLineCount'), false, 'aggregate counts cannot supply new-line volume');
});

it('preserves zero-file aggregates with a supplied ledger', () => {
  assert.deepEqual(narrow.categorizeShow({ showId: 'empty', totalLines: 0, files: new Set() }, { knownFiles: new Set() }), {
    showId: 'empty', totalLines: 0, distinctFiles: 0, repeatMultiplier: 0, newFileCount: 0, category: 'NORMAL',
  });
});

it('adapts Map and object ledgers, including absent shows, without mutating them', () => {
  const records = [
    { showId: 'a', file: 'a.json', reason },
    { showId: 'new', file: 'new.json', reason },
    { showId: 'new', file: 'new.json', reason },
  ];
  const map = new Map([['a', new Set(['a.json'])]]);
  const object = { a: ['a.json'] };
  const results = narrow.analyzeExclusionLog(jsonl(records), { knownFilesByShow: map });
  assert.deepEqual(results, narrow.analyzeExclusionLog(jsonl(records), { knownFilesByShow: object }));
  assert.deepEqual(results[0], {
    showId: 'new', totalLines: 2, distinctFiles: 1, repeatMultiplier: 2, newFileCount: 1, category: 'NEEDS_REVIEW',
  });
  assert.equal(results[1].category, 'NORMAL');
  assert.deepEqual(map, new Map([['a', new Set(['a.json'])]]));
  assert.deepEqual(object, { a: ['a.json'] });
  assert.equal(narrow.analyzeExclusionLog(jsonl(records))[0].category, 'REPEATED_LOGGING');
});

it('forwards custom thresholds and direct knownFiles through the full pipeline', () => {
  const text = jsonl([
    { showId: 'a', file: 'a.json', reason },
    { showId: 'a', file: 'b.json', reason },
  ]);
  assert.equal(narrow.analyzeExclusionLog(text, { distinctFileThreshold: 2 })[0].category, 'NEEDS_REVIEW');
  const opts = { knownFiles: new Set(['a.json']), newFileThreshold: 2, repeatThreshold: 3 };
  assert.deepEqual(narrow.analyzeExclusionLog(text, opts)[0], {
    showId: 'a', totalLines: 2, distinctFiles: 2, repeatMultiplier: 1, newFileCount: 1, category: 'REPEATED_LOGGING',
  });
});

it('preserves missing-file compatibility while the digest still ignores sentinel identity', () => {
  const records = [{ showId: 'a', reason }, { showId: 'a', file: '-', reason }];
  const previous = { a: ['-'], absent: ['old.json'] };
  assert.deepEqual(narrow.buildNextLedger(records, previous), previous);
  assert.deepEqual(narrow.buildNextLedger(records), { a: ['-'] });
  assert.deepEqual(trend.buildNextLedger(records), { [reason]: { a: [] } });
  assert.deepEqual(narrow.analyzeExclusionLog(jsonl(records), { knownFilesByShow: {} }), [{
    showId: 'a', totalLines: 2, distinctFiles: 1, repeatMultiplier: 2, newFileCount: 1, category: 'NEEDS_REVIEW',
  }]);
  assert.equal(narrow.analyzeExclusionLog(jsonl(records), { knownFilesByShow: previous })[0].newFileCount, 0);
  const [group] = trend.analyzeExclusionLog(jsonl(records), { knownFilesByReasonAndShow: { [reason]: {} } });
  assert.equal(group.hasFileIdentity, false);
  assert.equal(group.sentinelLineCount, 2);
  assert.equal(Object.hasOwn(group, 'newFileCount'), false);
});

it('preserves mixed sentinel and real-file counts, unknown show IDs and ledger unions', () => {
  const records = [null, { reason }, { reason, file: 'new.json' }, { reason: 'skippedNotReview', file: 'ignored.json' }];
  assert.deepEqual(narrow.summarizeByShow(records), new Map([['unknown', {
    showId: 'unknown', totalLines: 2, files: new Set(['-', 'new.json']),
  }]]));
  assert.deepEqual(narrow.analyzeExclusionLog(jsonl(records), { knownFilesByShow: {} }), [{
    showId: 'unknown', totalLines: 2, distinctFiles: 2, repeatMultiplier: 1, newFileCount: 2, category: 'NEEDS_REVIEW',
  }]);
  assert.deepEqual(narrow.buildNextLedger(records, { unknown: ['old.json'] }), { unknown: ['-', 'new.json', 'old.json'] });
});
