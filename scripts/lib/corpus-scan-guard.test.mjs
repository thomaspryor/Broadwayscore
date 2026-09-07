import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertCorpusScanned, CorpusNotScannedError, summarizeWindowCoverage } = require('./corpus-scan-guard.js');

// SETUP ASSERTION (CLAUDE.md: a test whose setup silently fails looks exactly
// like a passing test). If the module ever stops exporting these, every case
// below would vacuously pass on `undefined`.
test('setup: the module exports the functions under test', () => {
  assert.equal(typeof assertCorpusScanned, 'function');
  assert.equal(typeof summarizeWindowCoverage, 'function');
  assert.equal(typeof CorpusNotScannedError, 'function');
});

test('assertCorpusScanned throws only when gating on an empty scan', () => {
  assert.throws(() => assertCorpusScanned(0, { gate: true }), CorpusNotScannedError);
  assert.doesNotThrow(() => assertCorpusScanned(0, { gate: false }));
  assert.doesNotThrow(() => assertCorpusScanned(1, { gate: true }));
});

// The real numbers measured on the corpus on 2026-09-07, which are what
// motivated BRO-2348. If the arithmetic ever silently changes shape, this is
// the case that catches it.
const REAL = {
  windowDays: 30,
  corpusShows: 2943,
  eligibleShows: 2601,
  windowShows: 132,
  openedShows: 22,
  showsWithTexts: 72,
  filesParsed: 999,
};

test('separates the four populations that a single "scanned" number conflates', () => {
  const s = summarizeWindowCoverage(REAL);
  assert.equal(s.upcomingShows, 110, 'window filter has no upper bound: 132 - 22 opened');
  assert.equal(s.skippedNoTexts, 60, 'selected but had no review-texts dir: 132 - 72');
  assert.equal(s.notExamined, 2811, 'corpus minus the window: 2943 - 132');
  assert.equal(s.ineligibleShows, 342, 'no openingDate at all: 2943 - 2601');
});

test('the examined count is the number of shows actually opened, not the window size', () => {
  const s = summarizeWindowCoverage(REAL);
  // The whole point of the card: 72 is the honest number, 132 is the one the
  // old line printed, and they must never be conflated again.
  assert.equal(s.showsWithTexts, 72);
  assert.notEqual(s.showsWithTexts, s.windowShows);
  assert.match(s.lines[0], /examined 72 of 2943 corpus shows/);
});

test('reports the no-upper-bound window and the every-window exclusion explicitly', () => {
  const text = summarizeWindowCoverage(REAL).lines.join('\n');
  assert.match(text, /110 not yet opened/);
  assert.match(text, /no upper bound/);
  assert.match(text, /342 carry no openingDate and are excluded at EVERY window/);
  assert.match(text, /60 selected show\(s\) had no data\/review-texts directory/);
  assert.match(text, /not a statement about the corpus/i);
});

test('full coverage reports zero blind spots rather than a misleading remainder', () => {
  const s = summarizeWindowCoverage({
    windowDays: 100000,
    corpusShows: 500,
    eligibleShows: 500,
    windowShows: 500,
    openedShows: 500,
    showsWithTexts: 500,
    filesParsed: 4000,
  });
  assert.equal(s.notExamined, 0);
  assert.equal(s.ineligibleShows, 0);
  assert.equal(s.upcomingShows, 0);
  assert.equal(s.skippedNoTexts, 0);
});

test('an empty scan never reports negative or invented coverage', () => {
  const s = summarizeWindowCoverage({
    windowDays: 30,
    corpusShows: 2943,
    eligibleShows: 2601,
    windowShows: 0,
    openedShows: 0,
    showsWithTexts: 0,
    filesParsed: 0,
  });
  assert.equal(s.windowShows, 0);
  assert.equal(s.skippedNoTexts, 0);
  assert.equal(s.notExamined, 2943, 'nothing examined means the whole corpus is unexamined');
});

test('nonsense or missing inputs clamp instead of producing negative counts', () => {
  const s = summarizeWindowCoverage({
    corpusShows: 10,
    eligibleShows: 999, // larger than the corpus
    windowShows: 999, // larger than the corpus
    openedShows: 999, // larger than the window
    showsWithTexts: -5, // negative
    filesParsed: undefined,
  });
  assert.equal(s.eligibleShows, 10);
  assert.equal(s.windowShows, 10);
  assert.equal(s.openedShows, 10);
  assert.equal(s.showsWithTexts, 0);
  assert.equal(s.filesParsed, 0);
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'number') assert.ok(v >= 0, `${k} must never be negative, got ${v}`);
  }
});

test('called with no arguments it does not throw and reports an empty corpus', () => {
  const s = summarizeWindowCoverage();
  assert.equal(s.corpusShows, 0);
  assert.equal(s.notExamined, 0);
  assert.ok(Array.isArray(s.lines) && s.lines.length > 0);
});
