// Unit tests for scripts/lib/reddit-grosses.js.
// Per feedback_test_extraction_pattern.md — require() the real lib.
// Also a parity guard: these exact cases were the inline isRelevantPost
// implementation in scrape-boring-waltz-costs.js before it was moved here
// (2026-07-19) — any behavior change here is a real regression.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { isRelevantPost, parseDollarAmount, extractCostsFromPost, parseProfitRange, extractWeeklyFinancialsFromPost } = require('../../scripts/lib/reddit-grosses');

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

  it('reads Reddit-escaped costs only in the shadow candidate until checker signoff', () => {
    for (const [value, cost] of [['\\~$750k/week', 750000], ['\\~$650-\\~$700k/week', 675000]]) {
      const text = `***X***\nEstimated Weekly Operating Cost: ${value}`;
      assert.deepEqual(extractCostsFromPost(text), []);
      assert.deepEqual(extractCostsFromPost(text, { unescapeCosts: true }), [{ showName: 'X', cost }]);
    }
  });

  it('keeps costs with ordinary formatting identical in shadow mode', () => {
    assert.deepEqual(extractCostsFromPost(post, { unescapeCosts: true }), extractCostsFromPost(post));
  });

  it('returns nothing for an empty post or a cost with no heading', () => {
    assert.deepEqual(extractCostsFromPost(''), []);
    assert.deepEqual(extractCostsFromPost(undefined), []);
    assert.deepEqual(extractCostsFromPost('Weekly Operating Cost: $700k/week'), []);
  });
});

// BRO-5027: his profit line, in every shape seen across 1,487 posted values.
describe('parseProfitRange', () => {
  const cases = [
    ['$0k-$(100k)', { low: -100000, high: 0 }],
    ['$0-($100k)', { low: -100000, high: 0 }],
    ['($50k)-$50k', { low: -50000, high: 50000 }],
    ['$50k-($50k)', { low: -50000, high: 50000 }],
    ['$(100k)-$(50k)', { low: -100000, high: -50000 }],
    ['($150k)-($100k)', { low: -150000, high: -100000 }],
    ['$50-$100k', { low: 50000, high: 100000 }],
    ['$(50k)', { low: -50000, high: -50000 }],
    ['\\~$50k', { low: 50000, high: 50000 }],
    ['$1.2 million', { low: 1200000, high: 1200000 }],
    ['$100k+', { low: 100000, high: null }],
    ['($100k+)', { low: null, high: -100000 }],
    ['Even*', { low: 0, high: 0 }],
    // Suffix or "+" outside the parentheses (real values).
    ['$(68)k', { low: -68000, high: -68000 }],
    ['($100k)+', { low: null, high: -100000 }],
    ['$(100k)+', { low: null, high: -100000 }],
    ['$0-$100k+', { low: 0, high: null }],
    ['$100k+ (final week)', { low: 100000, high: null }],
    ['$100k+ this week, vs 2023', { low: 100000, high: null }],
    ['$(100k) to $0', { low: -100000, high: 0 }],
  ];
  for (const [input, want] of cases) {
    it(`reads ${input}`, () => assert.deepEqual(parseProfitRange(input), want));
  }
  it('returns null for N/A, empty and prose', () => {
    assert.equal(parseProfitRange('N/A'), null);
    assert.equal(parseProfitRange(''), null);
    assert.equal(parseProfitRange('(Twice their box office return)*'), null);
    assert.equal(parseProfitRange('($300+)'), null, 'a nonzero figure under $1k is a missing suffix');
  });
  it('stays fast on whitespace-padded text (no catastrophic backtracking)', () => {
    const t = Date.now();
    parseProfitRange(' '.repeat(5000) + '#');
    parseProfitRange('$' + ' '.repeat(5000) + '(' + ' '.repeat(5000) + '#');
    extractWeeklyFinancialsFromPost('***X*** - $500k gross\nEstimated Profit (Loss): $' + ' '.repeat(5000) + '(' + ' '.repeat(5000) + '#');
    assert.ok(Date.now() - t < 1000, `took ${Date.now() - t}ms`);
  });
});

describe('extractWeeklyFinancialsFromPost', () => {
  const post = [
    '➡ ***The Great Gatsby*** \\- *$884k, 80% capacity, $93 atp (Up \\~$43k from last week).*',
    '',
    'Gross Less-Fees: $778k; Estimated Weekly Operating Cost: $850k/week; Estimated Profit (Loss): $0k-$(100k)',
    '',
    'Estimated percentage recouped: 10%-30%',
    '',
    '➡***️Chess***\\- *1.0 million gross, 71% capacity, $122 atp*',
    '',
    '*Gross Less-Fees: $893k; Estimated Weekly Operating Cost: $900k/week; Estimated Profit (Loss): N/A*',
    '',
    '***Ragtime*** \\- $*1.9 million gross, 99% capacity*',
    'Gross Less-Fees: $1.6 million; Weekly Operating Cost: $1M/week; Estimated Profit (Loss): $100k+',
    '',
    '***Just A Heading*** with commentary and no figures',
  ].join('\n');
  const rows = extractWeeklyFinancialsFromPost(post);

  it('returns one row per show with figures, dropping a bare heading', () => {
    assert.deepEqual(rows.map((r) => r.showName), ['The Great Gatsby', 'Chess', 'Ragtime']);
  });
  it('reads gross, less-fees, cost, profit range and recouped range', () => {
    assert.deepEqual(rows[0], {
      showName: 'The Great Gatsby', gross: 884000, grossLessFees: 778000, costLow: 850000, costHigh: 850000,
      profit: { low: -100000, high: 0 }, profitText: '$0k-$(100k)', recoupedLow: 10, recoupedHigh: 30, flags: [],
    });
  });
  it('reads a "gross"-labelled figure with no "$" ahead of the atp figure', () => {
    assert.equal(rows[1].gross, 1000000);
    assert.equal(rows[1].profit, null);
  });
  it('reads "$*1.9 million" and an open profit bound', () => {
    assert.equal(rows[2].gross, 1900000);
    assert.equal(rows[2].grossLessFees, 1600000);
    assert.deepEqual(rows[2].profit, { low: 100000, high: null });
    assert.equal(rows[2].recoupedLow, null);
  });
  it('keeps the weekly profit when a post-mortem run total follows', () => {
    const r = extractWeeklyFinancialsFromPost([
      '***Elf*** - $1.2 million gross',
      'Gross Less-Fees: $1.05 million; Weekly Operating Cost: $900k/week; Estimated Profit (Loss): $189k',
      'Total Estimated Profit (Loss): \\~($6 million)',
      '***Back to the Future*** - $1.0 million gross',
      'Gross Less-Fees: 776k; Weekly Operating Cost: $950k/week; Estimated Profit (Loss): $(100k)-$0',
      'Estimated Profit (Loss); $(15.5 million)',
    ].join('\n'));
    assert.deepEqual(r[0].profit, { low: 189000, high: 189000 });
    assert.deepEqual(r[1].profit, { low: -100000, high: 0 });
    assert.equal(r[1].grossLessFees, 776000, 'less-fees without a "$"');
  });
  it('reads "Gross Less-Fees- $1.050 million" and flags less-fees above gross', () => {
    const r = extractWeeklyFinancialsFromPost('***X*** - $900k gross\nGross Less-Fees- $1.050 million; Estimated Profit (Loss): $0');
    assert.equal(r[0].grossLessFees, 1050000);
    assert.deepEqual(r[0].flags, ['lessFeesImplausible']);
  });
  it('reads an escaped "\\~$750k" cost and skips a Capitalization run total', () => {
    const r = extractWeeklyFinancialsFromPost([
      '***X*** - $900k gross',
      'Capitalization: $22 million; Estimated Profit (Loss); $(15.5 million)-$(6.5 million)',
      'Gross Less-Fees: $800k; Weekly Operating Cost: \\~$750k/week; Estimated Profit (Loss): $0-$50k',
    ].join('\n'));
    assert.equal(r[0].costLow, 750000);
    assert.deepEqual(r[0].profit, { low: 0, high: 50000 });
  });
  it('allows a rounded heading gross and flags a profit above gross minus cost', () => {
    const ok = extractWeeklyFinancialsFromPost('***X*** - $1.1 million gross\nGross Less-Fees: $1.122 million; Estimated Profit (Loss): $0');
    assert.deepEqual(ok[0].flags, []);
    const bad = extractWeeklyFinancialsFromPost('***X*** - $397k gross\nWeekly Operating Cost: $650k/week; Estimated Profit (Loss): $415k');
    assert.deepEqual(bad[0].flags, ['profitAboveGrossLessCost']);
  });
  it('does not read profit text from the next line', () => {
    const r = extractWeeklyFinancialsFromPost('***X*** - $500k gross\nEstimated Profit (Loss):\nLost $200k this week');
    assert.equal(r.length, 0);
  });
});
