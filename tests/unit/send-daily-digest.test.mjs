/**
 * BRO-2379: generalizes BRO-75's sticky-flag repeat-vs-new categorization
 * (originally built only for skippedWrongProduction, see
 * scripts/lib/wrong-production-exclusion-analysis.js) to every exclusion
 * reason, and cross-checks it against send-daily-digest.js's
 * computeExclusionTrend spike detector.
 *
 * Real risk under test: computeExclusionTrend's original mean/stdev spike
 * detector only saw raw per-reason daily volume, which is exactly the shape
 * that produced BRO-75's false alarm — skippedWrongProduction=40,322 lines,
 * 77% of all exclusions, almost entirely the SAME already-flagged files
 * re-logged across rebuild passes, not new mistakes. These tests build a
 * fixture data/audit directory (never the real one) and assert that shape
 * is suppressed for ANY reason, not just skippedWrongProduction, while a
 * genuine new-exclusion spike still fires.
 *
 * The real functions are require()d (CLAUDE.md rule 15) — a regression in
 * either scripts/lib/exclusion-trend.js or send-daily-digest.js's wiring
 * fails these tests.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { computeExclusionTrend, hasChanges, buildDigestItems } = require('../../scripts/send-daily-digest.js');

const NOW = new Date('2026-04-17T12:00:00.000Z');

function isoDay(offsetDays) {
  return new Date(NOW.getTime() - offsetDays * 86400000).toISOString().slice(0, 10);
}

function exclusionLine({ showId, file, reason }) {
  return JSON.stringify({
    ts: `${isoDay(0)}T00:00:00.000Z`,
    script: 'rebuild-all-reviews',
    showId,
    file,
    reason,
    details: {},
  });
}

let auditDir;

beforeEach(() => {
  auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exclusion-trend-test-'));
});

afterEach(() => {
  fs.rmSync(auditDir, { recursive: true, force: true });
});

function writeDayLog(day, lines) {
  fs.writeFileSync(path.join(auditDir, `exclusions-${day}.jsonl`), lines.join('\n') + '\n');
}

describe('computeExclusionTrend — generalized sticky-flag repeat-vs-new (BRO-2379)', () => {
  it('suppresses a raw-volume spike that is entirely re-logging of already-known files, for a NON-wrongProduction reason', () => {
    // Baseline: this reason logs ~10 lines/day for a week (2 files x ~5
    // rebuild passes) — same shape BRO-75 found, just a different reason.
    const knownFiles = ['a.json', 'b.json'];
    for (let d = 1; d <= 7; d++) {
      const lines = [];
      for (let pass = 0; pass < 5; pass++) {
        for (const file of knownFiles) {
          lines.push(exclusionLine({ showId: 'show-x', file, reason: 'skippedNotReview' }));
        }
      }
      writeDayLog(isoDay(d), lines);
    }
    // Ledger already knows about both files as of yesterday.
    fs.writeFileSync(
      path.join(auditDir, 'exclusion-seen-files.json'),
      JSON.stringify({ skippedNotReview: { 'show-x': knownFiles } })
    );

    // Today: a rebuild storm re-logs the SAME 2 known files 20x each — raw
    // volume (40) is a massive spike vs the ~10/day baseline, but every
    // single line is a re-log of an already-known file.
    const todayLines = [];
    for (let pass = 0; pass < 20; pass++) {
      for (const file of knownFiles) {
        todayLines.push(exclusionLine({ showId: 'show-x', file, reason: 'skippedNotReview' }));
      }
    }
    writeDayLog(isoDay(0), todayLines);

    const trend = computeExclusionTrend(NOW, { auditDir, persistLedger: false });
    const entry = trend.topToday.find((t) => t.reason === 'skippedNotReview');
    assert.ok(entry, 'reason should still appear in topToday');
    assert.equal(entry.todayCount, 40);
    assert.equal(entry.newLines, 0, 'no lines should be attributed as genuinely new');
    assert.equal(entry.repeatedLines, 40);
    assert.equal(entry.spike, false, 'a pure re-logging spike must be suppressed');
    assert.equal(trend.spikes.find((t) => t.reason === 'skippedNotReview'), undefined);
  });

  it('still flags a genuine new-exclusion spike (not sticky re-logging)', () => {
    for (let d = 1; d <= 7; d++) {
      writeDayLog(isoDay(d), [exclusionLine({ showId: 'show-y', file: 'stable.json', reason: 'skippedDuplicateOf' })]);
    }
    fs.writeFileSync(
      path.join(auditDir, 'exclusion-seen-files.json'),
      JSON.stringify({ skippedDuplicateOf: { 'show-y': ['stable.json'] } })
    );

    // Today: 10 brand-new distinct files excluded for the first time —
    // not in the ledger, one line each (no repeat noise at all).
    const todayLines = [exclusionLine({ showId: 'show-y', file: 'stable.json', reason: 'skippedDuplicateOf' })];
    for (let i = 0; i < 10; i++) {
      todayLines.push(exclusionLine({ showId: 'show-z', file: `new-review-${i}.json`, reason: 'skippedDuplicateOf' }));
    }
    writeDayLog(isoDay(0), todayLines);

    const trend = computeExclusionTrend(NOW, { auditDir, persistLedger: false });
    const entry = trend.topToday.find((t) => t.reason === 'skippedDuplicateOf');
    assert.ok(entry);
    assert.equal(entry.newLines, 10);
    assert.equal(entry.spike, true, 'a genuinely new spike must still fire');
    assert.ok(trend.spikes.some((t) => t.reason === 'skippedDuplicateOf'));
    assert.ok(entry.needsReviewShows.includes('show-z'));
  });

  it('mixed volume (some new, some repeated) keeps the spike alive', () => {
    for (let d = 1; d <= 7; d++) {
      writeDayLog(isoDay(d), [exclusionLine({ showId: 'show-m', file: 'known.json', reason: 'skippedWrongProduction' })]);
    }
    fs.writeFileSync(
      path.join(auditDir, 'exclusion-seen-files.json'),
      JSON.stringify({ skippedWrongProduction: { 'show-m': ['known.json'] } })
    );

    const todayLines = [];
    for (let pass = 0; pass < 10; pass++) {
      todayLines.push(exclusionLine({ showId: 'show-m', file: 'known.json', reason: 'skippedWrongProduction' }));
    }
    todayLines.push(exclusionLine({ showId: 'show-m', file: 'genuinely-new.json', reason: 'skippedWrongProduction' }));
    writeDayLog(isoDay(0), todayLines);

    const trend = computeExclusionTrend(NOW, { auditDir, persistLedger: false });
    const entry = trend.topToday.find((t) => t.reason === 'skippedWrongProduction');
    assert.equal(entry.newLines, 1);
    assert.equal(entry.repeatedLines, 10);
    assert.equal(entry.spike, true);
  });

  it('falls back to the same-day ratio heuristic with no ledger yet, still suppressing a stale-repeat-shaped spike', () => {
    for (let d = 1; d <= 7; d++) {
      const lines = [];
      for (let pass = 0; pass < 3; pass++) {
        lines.push(exclusionLine({ showId: 'show-n', file: 'x.json', reason: 'skippedNoBody' }));
      }
      writeDayLog(isoDay(d), lines);
    }
    // No ledger file at all — first-ever run.
    const todayLines = [];
    for (let pass = 0; pass < 30; pass++) {
      todayLines.push(exclusionLine({ showId: 'show-n', file: 'x.json', reason: 'skippedNoBody' }));
    }
    writeDayLog(isoDay(0), todayLines);

    const trend = computeExclusionTrend(NOW, { auditDir, persistLedger: false });
    const entry = trend.topToday.find((t) => t.reason === 'skippedNoBody');
    // 30 lines / 1 distinct file = 30x repeat multiplier -> REPEATED_LOGGING
    // even without a ledger, so the spike should still be suppressed.
    assert.equal(entry.spike, false);
  });

  it('persists a generalized cross-reason ledger to disk when persistLedger is true', () => {
    writeDayLog(isoDay(0), [
      exclusionLine({ showId: 'show-p', file: 'p1.json', reason: 'skippedNotReview' }),
      exclusionLine({ showId: 'show-p', file: 'p2.json', reason: 'skippedDuplicateOf' }),
    ]);

    computeExclusionTrend(NOW, { auditDir, persistLedger: true });

    const ledgerPath = path.join(auditDir, 'exclusion-seen-files.json');
    assert.ok(fs.existsSync(ledgerPath));
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.deepEqual(ledger.skippedNotReview['show-p'], ['p1.json']);
    assert.deepEqual(ledger.skippedDuplicateOf['show-p'], ['p2.json']);
  });

  it('does not write the ledger when persistLedger is false', () => {
    writeDayLog(isoDay(0), [exclusionLine({ showId: 'show-q', file: 'q.json', reason: 'skippedNotReview' })]);
    computeExclusionTrend(NOW, { auditDir, persistLedger: false });
    assert.equal(fs.existsSync(path.join(auditDir, 'exclusion-seen-files.json')), false);
  });

  it('a brand-new show under an already-ledgered reason is treated as fully new, not same-day ratio noise', () => {
    // The reason has ledger history (other shows), but 'show-brand-new' has
    // NEVER appeared under it before. Codex review finding: a missing
    // per-show ledger entry must mean "definitively zero known files", not
    // "no evidence available" (which would wrongly fall back to the same-day
    // ratio heuristic and misread a real new-show spike as repeat noise).
    fs.writeFileSync(
      path.join(auditDir, 'exclusion-seen-files.json'),
      JSON.stringify({ skippedDuplicateOf: { 'some-other-show': ['x.json'] } })
    );
    for (let d = 1; d <= 7; d++) {
      writeDayLog(isoDay(d), [exclusionLine({ showId: 'some-other-show', file: 'x.json', reason: 'skippedDuplicateOf' })]);
    }
    // Today: show-brand-new gets flagged 20x across 10 distinct files by
    // multiple rebuild passes — a same-day ratio (20/10=2x) would read as
    // REPEATED_LOGGING under the old fallback, even though this show has
    // zero history and every file is genuinely new.
    const todayLines = [exclusionLine({ showId: 'some-other-show', file: 'x.json', reason: 'skippedDuplicateOf' })];
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < 10; i++) {
        todayLines.push(exclusionLine({ showId: 'show-brand-new', file: `f${i}.json`, reason: 'skippedDuplicateOf' }));
      }
    }
    writeDayLog(isoDay(0), todayLines);

    const trend = computeExclusionTrend(NOW, { auditDir, persistLedger: false });
    const entry = trend.topToday.find((t) => t.reason === 'skippedDuplicateOf');
    assert.ok(entry);
    assert.equal(entry.newLines, 20, 'all 20 lines from the brand-new show must count as new');
    assert.ok(entry.needsReviewShows.includes('show-brand-new'));
  });

  it('a mixed real-file + sentinel group never lets sentinel volume hide inside "repeated"', () => {
    // skippedBlockedUrl: rebuild-all-reviews.js sometimes logs a real file,
    // gather-reviews.js always logs '-'. One already-known real file plus
    // 100 sentinel-tagged (unidentifiable) lines must not let the group's
    // REPEATED_LOGGING verdict (driven by the known real file) swallow the
    // 100 lines that carry no repeat evidence at all.
    fs.writeFileSync(
      path.join(auditDir, 'exclusion-seen-files.json'),
      JSON.stringify({ skippedBlockedUrl: { 'show-mix': ['known.json'] } })
    );
    for (let d = 1; d <= 7; d++) {
      writeDayLog(isoDay(d), [exclusionLine({ showId: 'show-mix', file: 'known.json', reason: 'skippedBlockedUrl' })]);
    }
    const todayLines = [exclusionLine({ showId: 'show-mix', file: 'known.json', reason: 'skippedBlockedUrl' })];
    for (let i = 0; i < 100; i++) {
      todayLines.push(exclusionLine({ showId: 'show-mix', file: '-', reason: 'skippedBlockedUrl' }));
    }
    writeDayLog(isoDay(0), todayLines);

    const trend = computeExclusionTrend(NOW, { auditDir, persistLedger: false });
    const entry = trend.topToday.find((t) => t.reason === 'skippedBlockedUrl');
    assert.ok(entry);
    assert.equal(entry.todayCount, 101);
    assert.equal(entry.newLines, 100, 'the 100 sentinel lines must count as new regardless of the known real file');
    assert.equal(entry.repeatedLines, 1);
    assert.equal(entry.spike, true, 'a real 100-line spike must not be hidden by one known real file');
  });

  it('never sticky-suppresses reasons that always log the file:"-" sentinel (show-level reasons, e.g. skippedUpcomingShows)', () => {
    // Baseline: this show logs the reason once per rebuild pass (3x/day),
    // every day, all with exclusion-logger's file:'-' default — there is no
    // real per-file identity to diff against a ledger.
    for (let d = 1; d <= 7; d++) {
      const lines = [];
      for (let pass = 0; pass < 3; pass++) {
        lines.push(exclusionLine({ showId: 'show-r', file: '-', reason: 'skippedUpcomingShows' }));
      }
      writeDayLog(isoDay(d), lines);
    }
    fs.writeFileSync(
      path.join(auditDir, 'exclusion-seen-files.json'),
      JSON.stringify({ skippedUpcomingShows: { 'show-r': [] } })
    );

    // Today: a genuinely new show enters the same reason, logged 3x (one
    // per rebuild pass) — same per-show shape as every prior day. Without
    // the file:'-' carve-out, a same-day ratio heuristic (3 lines / 1
    // "file") would misread this as REPEATED_LOGGING and mute the spike.
    const todayLines = [];
    for (let pass = 0; pass < 3; pass++) {
      todayLines.push(exclusionLine({ showId: 'show-r', file: '-', reason: 'skippedUpcomingShows' }));
    }
    // 8 more distinct shows newly hit the same reason today — a real spike.
    for (let i = 0; i < 8; i++) {
      for (let pass = 0; pass < 3; pass++) {
        todayLines.push(exclusionLine({ showId: `new-show-${i}`, file: '-', reason: 'skippedUpcomingShows' }));
      }
    }
    writeDayLog(isoDay(0), todayLines);

    const trend = computeExclusionTrend(NOW, { auditDir, persistLedger: false });
    const entry = trend.topToday.find((t) => t.reason === 'skippedUpcomingShows');
    assert.ok(entry);
    assert.equal(entry.todayCount, 27);
    assert.equal(entry.newLines, 27, 'sentinel-only groups must count fully as new, never sticky-suppressed');
    assert.equal(entry.repeatedLines, 0);
    assert.equal(entry.spike, true, 'a real spike across 8 new shows must not be muted by the file:"-" sentinel');
  });

  it('persisting the ledger never stores the file:"-" sentinel', () => {
    writeDayLog(isoDay(0), [
      exclusionLine({ showId: 'show-s', file: '-', reason: 'skippedUpcomingShows' }),
      exclusionLine({ showId: 'show-s', file: 'real.json', reason: 'skippedWrongProduction' }),
    ]);
    computeExclusionTrend(NOW, { auditDir, persistLedger: true });
    const ledger = JSON.parse(fs.readFileSync(path.join(auditDir, 'exclusion-seen-files.json'), 'utf8'));
    assert.deepEqual(ledger.skippedUpcomingShows['show-s'], []);
    assert.deepEqual(ledger.skippedWrongProduction['show-s'], ['real.json']);
  });

  it('returns zeroed trend when no exclusion logs exist for the window', () => {
    const trend = computeExclusionTrend(NOW, { auditDir, persistLedger: false });
    assert.deepEqual(trend.spikes, []);
    assert.deepEqual(trend.novelReasons, []);
    assert.deepEqual(trend.topToday, []);
    assert.equal(trend.todayTotal, 0);
  });
});

describe('send-daily-digest.js does not execute main() on require (guarded by require.main)', () => {
  it('exports pure functions without side effects', () => {
    assert.equal(typeof computeExclusionTrend, 'function');
    assert.equal(typeof hasChanges, 'function');
    assert.equal(typeof buildDigestItems, 'function');
  });
});
