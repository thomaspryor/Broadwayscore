// Unit tests for scripts/lib/reddit-grosses.js.
// Per feedback_test_extraction_pattern.md — require() the real lib.
// Also a parity guard: these exact cases were the inline isRelevantPost
// implementation in scrape-boring-waltz-costs.js before it was moved here
// (2026-07-19) — any behavior change here is a real regression.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { isRelevantPost, parseDollarAmount, extractCostsFromPost } = require('../../scripts/lib/reddit-grosses');

describe('isRelevantPost', () => {
  it('matches a title containing "grosses"', () => {
    assert.equal(isRelevantPost({ title: 'Broadway Grosses Analysis: Week Ending 7/13/2026' }), true);
  });

  it('matches a title containing "post-mortem"', () => {
    assert.equal(isRelevantPost({ title: 'Hamilton Post-Mortem: 10 Years on Broadway' }), true);
  });

  it('matches a title containing "postmortem" (no hyphen)', () => {
    assert.equal(isRelevantPost({ title: 'Show Postmortem Thread' }), true);
  });

  it('is case-insensitive', () => {
    assert.equal(isRelevantPost({ title: 'WEEKLY GROSSES REPORT' }), true);
  });

  it('does not match an unrelated title', () => {
    assert.equal(isRelevantPost({ title: 'What did everyone see this weekend?' }), false);
  });

  it('handles a missing title gracefully', () => {
    assert.equal(isRelevantPost({}), false);
  });
});

// BRO-4666: the cost lines in u/Boring_Waltz_9545's Grosses Analysis posts,
// in the formats his 2026 posts use.
describe('parseDollarAmount', () => {
  it('reads k, M, million and plain amounts', () => {
    assert.equal(parseDollarAmount('850', 'k'), 850000);
    assert.equal(parseDollarAmount('1.1', 'M'), 1100000);
    assert.equal(parseDollarAmount('1', 'million'), 1000000);
    assert.equal(parseDollarAmount('850,000'), 850000);
    assert.equal(parseDollarAmount('', 'k'), null);
    assert.equal(parseDollarAmount('abc'), null);
  });
});

describe('extractCostsFromPost', () => {
  const post = [
    '➡ ***The Great Gatsby*** \\- *$841k, 78% capacity, $90 atp. Open-Ended.*',
    'Gross Less-Fees: $740k; Estimated Weekly Operating Cost: $850k/week; Estimated Profit (Loss): $50k-$(50k)',
    '➡***Ragtime*** *$1.9 million gross*',
    'Gross Less-Fees: $1.708 million; Estimated Weekly Operating Cost: $1 million/week; Estimated Profit (Loss): $100k+',
    '➡***Buena Vista Social Club-*** *$804k gross, 94% capacity*',
    'Gross Less-Fees: $700k; Weekly Operating Cost: $650-$700k/week',
    '***Show With A Running Cost*** *$400k gross*',
    'Estimated percentage recouped: 10%-30%',
    'Weekly Running Cost: $1.25M',
  ].join('\n');

  it('attributes each cost line to the show heading above it', () => {
    assert.deepEqual(extractCostsFromPost(post), [
      { showName: 'The Great Gatsby', cost: 850000 },
      { showName: 'Ragtime', cost: 1000000 },
      { showName: 'Buena Vista Social Club', cost: 675000 },
      { showName: 'Show With A Running Cost', cost: 1250000 },
    ]);
  });

  it('reads "$1 million/week" as a million, not $1', () => {
    const [entry] = extractCostsFromPost('***Ragtime***\nEstimated Weekly Operating Cost: $1 million/week');
    assert.equal(entry.cost, 1000000);
  });

  it('ignores the gross and profit figures on the same line', () => {
    const [entry] = extractCostsFromPost('***X***\nGross Less-Fees: $592k; Weekly Operating Cost: $765k/week; Estimated Profit (Loss): $0-($100k)');
    assert.equal(entry.cost, 765000);
  });

  it('reads plural, bold, "~" and "thousand" variants', () => {
    const cases = [
      ['Weekly Operating Costs: $850k', 850000],
      ['Weekly Operating Cost: ~$850k', 850000],
      ['**Estimated Weekly Operating Cost:** $850k/week', 850000],
      ['Weekly Operating Cost: $850 thousand', 850000],
      ['Weekly Operating Cost: ~$800k-~$900k', 850000],
    ];
    for (const [line, cost] of cases) {
      assert.deepEqual(extractCostsFromPost(`***X***\n${line}`), [{ showName: 'X', cost }], line);
    }
  });

  it('reads a range whose low end has no suffix of its own', () => {
    // "$950-$1.1M" is $950k to $1.1M; the low end inheriting "M" read $950M.
    assert.equal(extractCostsFromPost('***X***\nWeekly Operating Cost: $950-$1.1M')[0].cost, 1025000);
    assert.equal(extractCostsFromPost('***X***\nWeekly Operating Cost: $1-$1.2M')[0].cost, 1100000);
    assert.equal(extractCostsFromPost('***X***\nWeekly Operating Cost: $650-$700k')[0].cost, 675000);
  });

  it('returns nothing for an empty post or a cost with no heading', () => {
    assert.deepEqual(extractCostsFromPost(''), []);
    assert.deepEqual(extractCostsFromPost(undefined), []);
    assert.deepEqual(extractCostsFromPost('Weekly Operating Cost: $700k/week'), []);
  });
});
