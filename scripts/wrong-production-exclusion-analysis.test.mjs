/**
 * wrong-production-exclusion-analysis.test.mjs — BRO-75 acceptance suite.
 *
 * Confirms the analysis correctly distinguishes REPEATED_LOGGING (the same
 * already-flagged review files re-logged across multiple rebuild passes —
 * log noise, not over-blocking) from NEEDS_REVIEW (many distinct newly
 * excluded files — a real signal worth a content audit). The real function
 * is require()d (CLAUDE.md rule 15) — change the thresholds in production
 * code and these tests fail.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseExclusionLog,
  summarizeByShow,
  categorizeShow,
  analyzeExclusionLog,
  buildNextLedger,
} = require('./lib/wrong-production-exclusion-analysis');

function exclusionLine({ showId, file, ts, url }) {
  return JSON.stringify({
    ts: ts || '2026-04-17T00:00:00.000Z',
    script: 'rebuild-all-reviews',
    showId,
    file,
    reason: 'skippedWrongProduction',
    details: { url, outletId: 'broadwayworld', criticName: 'unknown', publishDate: undefined },
  });
}

describe('parseExclusionLog', () => {
  it('parses one JSON object per line', () => {
    const text = [
      exclusionLine({ showId: 'a', file: 'x.json' }),
      exclusionLine({ showId: 'b', file: 'y.json' }),
    ].join('\n');
    const records = parseExclusionLog(text);
    assert.equal(records.length, 2);
    assert.equal(records[0].showId, 'a');
    assert.equal(records[1].showId, 'b');
  });

  it('skips blank lines and non-JSON garbage without throwing', () => {
    const text = [
      '',
      '   ',
      'not json at all',
      exclusionLine({ showId: 'a', file: 'x.json' }),
      '',
    ].join('\n');
    const records = parseExclusionLog(text);
    assert.equal(records.length, 1);
    assert.equal(records[0].showId, 'a');
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(parseExclusionLog(''), []);
    assert.deepEqual(parseExclusionLog(undefined), []);
  });
});

describe('summarizeByShow', () => {
  it('ignores exclusion reasons other than skippedWrongProduction', () => {
    const records = [
      JSON.parse(exclusionLine({ showId: 'a', file: 'x.json' })),
      { showId: 'a', file: 'x.json', reason: 'skippedDuplicateOf' },
      { showId: 'a', file: 'y.json', reason: 'skippedNotReview' },
    ];
    const byShow = summarizeByShow(records);
    assert.equal(byShow.size, 1);
    assert.equal(byShow.get('a').totalLines, 1);
  });

  it('tracks distinct files separately from total log lines', () => {
    const records = [
      JSON.parse(exclusionLine({ showId: 'a', file: 'x.json' })),
      JSON.parse(exclusionLine({ showId: 'a', file: 'x.json' })),
      JSON.parse(exclusionLine({ showId: 'a', file: 'y.json' })),
    ];
    const byShow = summarizeByShow(records);
    const entry = byShow.get('a');
    assert.equal(entry.totalLines, 3);
    assert.equal(entry.files.size, 2);
  });
});

describe('categorizeShow — REPEATED_LOGGING vs NEEDS_REVIEW (BRO-75 core question)', () => {
  it('categorizes the beetlejuice-2022 shape as REPEATED_LOGGING, not over-blocking', () => {
    // Real-world shape from investigation: 94 distinct files (2019
    // original-run reviews + national-tour BWW reviews scraped into the
    // 2022 show ID), each re-logged on 3 same-day rebuild runs — the
    // reported 261/day volume (94 * ~2.78 rebuild passes).
    const files = new Set(Array.from({ length: 94 }, (_, i) => `outlet-${i}.json`));
    const entry = { showId: 'beetlejuice-2022', totalLines: 261, files };
    const result = categorizeShow(entry);
    assert.equal(result.category, 'REPEATED_LOGGING');
    assert.equal(result.distinctFiles, 94);
    assert.ok(result.repeatMultiplier > 2.5 && result.repeatMultiplier < 3,
      `expected ~2.78x repeat, got ${result.repeatMultiplier}`);
  });

  it('categorizes many distinct single-occurrence exclusions as NEEDS_REVIEW', () => {
    // Contrast case: 20 DISTINCT files, each excluded exactly once — a
    // genuine new-exclusion spike, not stale re-logging.
    const files = new Set(Array.from({ length: 20 }, (_, i) => `new-review-${i}.json`));
    const entry = { showId: 'some-new-show-2026', totalLines: 20, files };
    const result = categorizeShow(entry);
    assert.equal(result.category, 'NEEDS_REVIEW');
    assert.equal(result.repeatMultiplier, 1);
  });

  it('categorizes low volume as NORMAL', () => {
    const files = new Set(['x.json', 'y.json']);
    const entry = { showId: 'quiet-show', totalLines: 2, files };
    const result = categorizeShow(entry);
    assert.equal(result.category, 'NORMAL');
  });

  it('respects custom thresholds', () => {
    const files = new Set(['x.json', 'y.json']);
    const entry = { showId: 'show', totalLines: 3, files }; // 1.5x repeat
    assert.equal(categorizeShow(entry, { repeatThreshold: 2 }).category, 'NORMAL');
    assert.equal(categorizeShow(entry, { repeatThreshold: 1.5 }).category, 'REPEATED_LOGGING');
  });

  it('handles a show with zero tracked files without dividing by zero', () => {
    const entry = { showId: 'empty', totalLines: 0, files: new Set() };
    const result = categorizeShow(entry);
    assert.equal(result.repeatMultiplier, 0);
    assert.equal(result.category, 'NORMAL');
  });

  it('with a knownFiles ledger, surfaces a genuinely new file even when it is buried among heavily re-logged stale files', () => {
    // The gap a same-day-only repeat ratio can't see: 20 stale files each
    // re-logged 3x (60 lines, repeatMultiplier 3 -> would read as pure
    // REPEATED_LOGGING) PLUS 1 brand-new file logged once. Total volume
    // (61 lines / 21 files) still looks noise-dominated by ratio alone, but
    // the ledger diff must still catch the 1 new file.
    const staleFiles = Array.from({ length: 20 }, (_, i) => `stale-${i}.json`);
    const files = new Set([...staleFiles, 'brand-new-review.json']);
    const entry = { showId: 'mixed-show', totalLines: 61, files };
    const knownFiles = new Set(staleFiles); // everything except the new one was already known
    const result = categorizeShow(entry, { knownFiles });
    assert.equal(result.category, 'NEEDS_REVIEW');
    assert.equal(result.newFileCount, 1);
  });

  it('with a knownFiles ledger, categorizes an all-known show as REPEATED_LOGGING regardless of ratio', () => {
    const files = new Set(['a.json', 'b.json']);
    const entry = { showId: 'all-known', totalLines: 6, files };
    const result = categorizeShow(entry, { knownFiles: new Set(['a.json', 'b.json']) });
    assert.equal(result.category, 'REPEATED_LOGGING');
    assert.equal(result.newFileCount, 0);
  });

  it('with a knownFiles ledger, categorizes a single known file logged once as NORMAL', () => {
    const files = new Set(['a.json']);
    const entry = { showId: 'quiet', totalLines: 1, files };
    const result = categorizeShow(entry, { knownFiles: new Set(['a.json']) });
    assert.equal(result.category, 'NORMAL');
    assert.equal(result.newFileCount, 0);
  });
});

describe('analyzeExclusionLog — end to end', () => {
  it('distinguishes REPEATED_LOGGING from NEEDS_REVIEW across multiple shows in one log, sorted by volume', () => {
    const lines = [];
    // beetlejuice-2022: 5 known-bad files, logged 3x (3 rebuild runs) = 15 lines.
    for (let run = 0; run < 3; run++) {
      for (let i = 0; i < 5; i++) {
        lines.push(exclusionLine({ showId: 'beetlejuice-2022', file: `outlet-${i}.json`, ts: `2026-04-17T0${run}:00:00.000Z` }));
      }
    }
    // a show with 12 genuinely distinct new exclusions, logged once each.
    for (let i = 0; i < 12; i++) {
      lines.push(exclusionLine({ showId: 'genuinely-over-blocked-show', file: `review-${i}.json` }));
    }
    // an unrelated reason on the same show — must not be counted.
    lines.push(JSON.stringify({ showId: 'beetlejuice-2022', file: 'ignored.json', reason: 'skippedDuplicateOf' }));

    const results = analyzeExclusionLog(lines.join('\n'));
    assert.equal(results.length, 2);

    const byShowId = Object.fromEntries(results.map(r => [r.showId, r]));
    assert.equal(byShowId['beetlejuice-2022'].category, 'REPEATED_LOGGING');
    assert.equal(byShowId['beetlejuice-2022'].totalLines, 15);
    assert.equal(byShowId['beetlejuice-2022'].distinctFiles, 5);

    assert.equal(byShowId['genuinely-over-blocked-show'].category, 'NEEDS_REVIEW');
    assert.equal(byShowId['genuinely-over-blocked-show'].totalLines, 12);
    assert.equal(byShowId['genuinely-over-blocked-show'].distinctFiles, 12);

    // sorted by total volume descending
    assert.equal(results[0].showId, 'beetlejuice-2022');
  });

  it('returns [] for a log with no wrongProduction exclusions', () => {
    const lines = [JSON.stringify({ showId: 'a', file: 'x.json', reason: 'skippedDuplicateOf' })];
    assert.deepEqual(analyzeExclusionLog(lines.join('\n')), []);
  });

  it('with knownFilesByShow, distinguishes a new-file spike from stale re-logging on the SAME day — the case a repeat-ratio-only heuristic masks', () => {
    // beetlejuice-2022: 94 files re-logged 3x today (282 lines) — all
    // already in the ledger from prior days. Without a ledger this reads
    // REPEATED_LOGGING purely from the ratio, same as with one; the real
    // test is the show below.
    const knownBeetlejuiceFiles = Array.from({ length: 94 }, (_, i) => `outlet-${i}.json`);
    const lines = [];
    for (let run = 0; run < 3; run++) {
      for (const file of knownBeetlejuiceFiles) {
        lines.push(exclusionLine({ showId: 'beetlejuice-2022', file, ts: `2026-04-17T0${run}:00:00.000Z` }));
      }
    }
    // some-show-2026: 30 stale known files re-logged 3x (90 lines) PLUS 2
    // brand-new files logged once each. Same-day repeat ratio for the whole
    // show (92/32 ≈ 2.9x) reads as pure REPEATED_LOGGING and would hide the
    // 2 new mistakes — the ledger diff must not.
    const knownOtherFiles = Array.from({ length: 30 }, (_, i) => `known-${i}.json`);
    for (let run = 0; run < 3; run++) {
      for (const file of knownOtherFiles) {
        lines.push(exclusionLine({ showId: 'some-show-2026', file, ts: `2026-04-17T0${run}:00:00.000Z` }));
      }
    }
    lines.push(exclusionLine({ showId: 'some-show-2026', file: 'genuinely-new-1.json' }));
    lines.push(exclusionLine({ showId: 'some-show-2026', file: 'genuinely-new-2.json' }));

    const knownFilesByShow = {
      'beetlejuice-2022': knownBeetlejuiceFiles,
      'some-show-2026': knownOtherFiles,
    };

    const results = analyzeExclusionLog(lines.join('\n'), { knownFilesByShow });
    const byShowId = Object.fromEntries(results.map(r => [r.showId, r]));

    assert.equal(byShowId['beetlejuice-2022'].category, 'REPEATED_LOGGING');
    assert.equal(byShowId['beetlejuice-2022'].newFileCount, 0);

    assert.equal(byShowId['some-show-2026'].category, 'NEEDS_REVIEW');
    assert.equal(byShowId['some-show-2026'].newFileCount, 2);
  });
});

describe('buildNextLedger', () => {
  it('unions previously-known files with files seen in today\'s log, per show', () => {
    const records = [
      JSON.parse(exclusionLine({ showId: 'a', file: 'new.json' })),
      JSON.parse(exclusionLine({ showId: 'a', file: 'already-known.json' })),
    ];
    const previous = { a: ['already-known.json'], b: ['untouched-today.json'] };
    const next = buildNextLedger(records, previous);
    assert.deepEqual(next.a.sort(), ['already-known.json', 'new.json']);
    // shows with no exclusions today keep their prior entries
    assert.deepEqual(next.b, ['untouched-today.json']);
  });

  it('starts from an empty ledger on first run', () => {
    const records = [JSON.parse(exclusionLine({ showId: 'a', file: 'x.json' }))];
    const next = buildNextLedger(records, {});
    assert.deepEqual(next, { a: ['x.json'] });
  });

  it('ignores exclusion reasons other than skippedWrongProduction', () => {
    const records = [{ showId: 'a', file: 'x.json', reason: 'skippedDuplicateOf' }];
    const next = buildNextLedger(records, {});
    assert.deepEqual(next, {});
  });
});
