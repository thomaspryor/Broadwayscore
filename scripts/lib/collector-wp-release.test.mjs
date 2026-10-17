/**
 * BRO-4185 C: collector-set wrongProduction flags (text quarantined in
 * wrongFullText) get the sweep's Sonnet second look. Requires the real
 * functions (CLAUDE.md §15).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  isCollectorWrongProductionCandidate,
  restoreQuarantinedText,
  stampCollectorWpRejection,
  quarantinedTextHash,
  classifyPriorRunWrongProduction,
  resetWrongContentTier,
  priorRunVerdictHash,
} = require('./collector-wp-release');

const show = { id: 'disgraced-2014', title: 'Disgraced', openingDate: '2014-10-23' };
const text = 'Ayad Akhtar\'s Disgraced arrives on Broadway with a ferocious dinner party. '.repeat(40);
const ctx = { inOwnWindow: () => true, isGarbage: () => false };
const base = {
  wrongProduction: true,
  wrongProductionReason: 'Collector LLM: wrong production (high) — reviews a different run',
  fullText: null,
  wrongFullText: text,
  publishDate: '2014-10-24',
};

describe('isCollectorWrongProductionCandidate', () => {
  test('matches a quarantined collector flag inside the run window', () => {
    assert.equal(isCollectorWrongProductionCandidate(base, show, ctx), true);
  });
  test('skips flags from other sources', () => {
    assert.equal(isCollectorWrongProductionCandidate({ ...base, wrongProductionReason: 'CV-promoted: x' }, show, ctx), false);
  });
  test('skips reviews dated outside the run window', () => {
    assert.equal(isCollectorWrongProductionCandidate(base, show, { ...ctx, inOwnWindow: () => false }), false);
  });
  test('skips garbage captures (the consent drain handles those)', () => {
    assert.equal(isCollectorWrongProductionCandidate(base, show, { ...ctx, isGarbage: () => true }), false);
  });
  test('skips short quarantined text and unquarantined files', () => {
    assert.equal(isCollectorWrongProductionCandidate({ ...base, wrongFullText: 'short' }, show, ctx), false);
    assert.equal(isCollectorWrongProductionCandidate({ ...base, fullText: text }, show, ctx), false);
  });
  test('skips operator-protected and wrongShow files', () => {
    assert.equal(isCollectorWrongProductionCandidate({ ...base, wrongProductionOverride: true }, show, ctx), false);
    assert.equal(isCollectorWrongProductionCandidate({ ...base, wrongProductionManualClear: true }, show, ctx), false);
    assert.equal(isCollectorWrongProductionCandidate({ ...base, wrongShow: true }, show, ctx), false);
  });
  test('asks once per distinct text', () => {
    const d = { ...base };
    stampCollectorWpRejection(d, '2026-09-28T00:00:00Z');
    assert.equal(d.collectorWpReverifiedHash, quarantinedTextHash(text));
    assert.equal(isCollectorWrongProductionCandidate(d, show, ctx), false);
    assert.equal(isCollectorWrongProductionCandidate({ ...d, wrongFullText: text + ' changed' }, show, ctx), true);
  });
});

describe('restoreQuarantinedText', () => {
  test('moves the text back and reclassifies the tier', () => {
    const d = { ...base, incompleteReason: 'wrong_content', incompleteDetail: 'Collector LLM' };
    restoreQuarantinedText(d, () => ({ contentTier: 'complete', tierReason: 'Full review text', wordCount: 500 }));
    assert.equal(d.fullText, text);
    // wrongFullText kept; the human article-type hatch is never set.
    assert.equal(d.wrongFullText, text);
    assert.equal(d.wrongArticleManualClear, undefined);
    assert.equal(d.incompleteReason, null);
    assert.equal(d.contentTier, 'complete');
  });
});

describe('classifyPriorRunWrongProduction', () => {
  // Totoro shape: current West End run, declared Barbican prior run.
  const totoro = {
    id: 'my-neighbour-totoro-west-end-2025', title: 'My Neighbour Totoro', openingDate: '2025-03-08',
    priorRuns: [{ venue: 'Barbican Theatre', openingDate: '2022-10-08', closingDate: '2023-01-21' }],
  };
  const barbicanReview = 'Phelim McDermott\'s Totoro at the Barbican is a wonder of puppetry. '.repeat(30);
  const collector = {
    wrongProduction: true,
    wrongProductionReason: 'Collector LLM: wrong production (high) — evaluates the Barbican production',
    publishDate: '2022-10-18',
    // Too thin to be usable, so the quarantined copy is judged.
    fullText: 'UK Edition nav chrome '.repeat(20),
    wrongFullText: barbicanReview,
  };
  const noGarbage = { isGarbage: () => false };

  test('collector flag inside a declared priorRun is a candidate, on the usable text', () => {
    const r = classifyPriorRunWrongProduction(collector, totoro, noGarbage);
    assert.equal(r.bucket, 'candidate');
    assert.equal(r.textField, 'wrongFullText');
    assert.equal(r.text, barbicanReview);
    // A longer live fullText is judged as is.
    const live = classifyPriorRunWrongProduction({ ...collector, fullText: barbicanReview + ' more', wrongFullText: 'short' }, totoro, noGarbage);
    assert.equal(live.textField, 'fullText');
  });
  test('ordinal publishDate still matches the window', () => {
    assert.equal(classifyPriorRunWrongProduction({ ...collector, publishDate: 'October 18th, 2022' }, totoro, noGarbage).bucket, 'candidate');
  });
  test('tourLegs windows count too', () => {
    const tour = { id: 't', title: 'T', openingDate: '2026-01-01', tourLegs: [{ venue: 'Curran', startDate: '2022-10-01', endDate: '2022-11-01' }] };
    assert.equal(classifyPriorRunWrongProduction(collector, tour, noGarbage).bucket, 'candidate');
  });
  test('outside every declared window, or no declared runs, is not classified', () => {
    assert.equal(classifyPriorRunWrongProduction({ ...collector, publishDate: '2024-06-01' }, totoro, noGarbage), null);
    assert.equal(classifyPriorRunWrongProduction(collector, { ...totoro, priorRuns: undefined }, noGarbage), null);
    assert.equal(classifyPriorRunWrongProduction({ ...collector, wrongProduction: false }, totoro, noGarbage), null);
  });
  test('ensemble rejections are listed for rescore, never candidates', () => {
    const r = classifyPriorRunWrongProduction({ ...collector, rejectedBy: 'ensemble-scoreability-check', rejectionReason: 'wrong_production' }, totoro, noGarbage);
    assert.equal(r.bucket, 'ensemble');
  });
  test('operator free-text reasons are report-only', () => {
    for (const reason of [
      'audit-2026-06-21-prior-production-contamination',
      'Re-excluded 2026-08-09 (owner question): original Edinburgh Fringe review',
      'URL/content is the Aug 2025 Edinburgh Fringe run (BRO-2382 triage 2026-08-31)',
      'contamination-adjudicated: national-tour',
    ]) {
      assert.equal(classifyPriorRunWrongProduction({ ...collector, wrongProductionReason: reason }, totoro, noGarbage).bucket, 'operator', reason);
    }
  });
  test('note-only auto flags, duplicates, wrongShow and protected files are left alone', () => {
    assert.equal(classifyPriorRunWrongProduction({ ...collector, wrongProductionReason: null, wrongProductionNote: 'Date guard: x' }, totoro, noGarbage).bucket, 'other');
    assert.equal(classifyPriorRunWrongProduction({ ...collector, duplicateOf: 'x.json' }, totoro, noGarbage).bucket, 'other');
    assert.equal(classifyPriorRunWrongProduction({ ...collector, wrongShow: true }, totoro, noGarbage).bucket, 'other');
    assert.equal(classifyPriorRunWrongProduction({ ...collector, wrongProductionOverride: true }, totoro, noGarbage).bucket, 'other');
  });
  test('no usable text / garbage text is no-text', () => {
    assert.equal(classifyPriorRunWrongProduction({ ...collector, fullText: null, wrongFullText: 'tiny' }, totoro, noGarbage).bucket, 'no-text');
    assert.equal(classifyPriorRunWrongProduction(collector, totoro, { isGarbage: () => true }).bucket, 'no-text');
  });
  test('asks once per judged text: stamping that text settles it', () => {
    const d = { ...collector };
    stampCollectorWpRejection(d, '2026-09-29T00:00:00Z', barbicanReview, priorRunVerdictHash(barbicanReview, totoro));
    assert.equal(classifyPriorRunWrongProduction(d, totoro, noGarbage).bucket, 'settled');
    assert.equal(classifyPriorRunWrongProduction({ ...d, wrongFullText: barbicanReview + ' refetched' }, totoro, noGarbage).bucket, 'candidate');
  });
  test('a corrected run declaration re-opens a settled verdict on unchanged text', () => {
    const d = { ...collector };
    stampCollectorWpRejection(d, '2026-09-29T00:00:00Z', barbicanReview, priorRunVerdictHash(barbicanReview, totoro));
    const corrected = { ...totoro, priorRuns: totoro.priorRuns.map((r) => ({ ...r, venue: `${r.venue} (corrected)` })) };
    assert.equal(classifyPriorRunWrongProduction(d, corrected, noGarbage).bucket, 'candidate');
  });
  test('a human-confirmed or non-review file is never re-asked', () => {
    assert.equal(classifyPriorRunWrongProduction({ ...collector, humanReviewedWrongProduction: true }, totoro, noGarbage).bucket, 'other');
    assert.equal(classifyPriorRunWrongProduction({ ...collector, isNonReview: true }, totoro, noGarbage).bucket, 'other');
  });
  test('after a url rewrite the quarantined copy is not used (it may be the old article)', () => {
    const d = { ...collector, fullText: '', _urlChangedClear: { at: '2026-09-01T00:00:00Z' } };
    assert.equal(classifyPriorRunWrongProduction(d, totoro, noGarbage).bucket, 'no-text');
  });
  test('a longer garbage capture does not shadow a shorter usable review', () => {
    const chrome = 'Menu Subscribe Sign in '.repeat(400);
    const d = { ...collector, fullText: chrome, wrongFullText: barbicanReview };
    const r = classifyPriorRunWrongProduction(d, totoro, { isGarbage: (t) => t === chrome });
    assert.equal(r.bucket, 'candidate');
    assert.equal(r.textField, 'wrongFullText');
  });
});

describe('resetWrongContentTier', () => {
  test('clears the collector wrong_content marker and reclassifies, keeping the text', () => {
    const d = { fullText: 'live', incompleteReason: 'wrong_content', incompleteDetail: 'Collector LLM: x', contentTier: 'invalid' };
    resetWrongContentTier(d, () => ({ contentTier: 'complete', tierReason: 'ok', wordCount: 1 }));
    assert.equal(d.fullText, 'live');
    assert.equal(d.incompleteReason, null);
    assert.equal(d.incompleteDetail, null);
    assert.equal(d.contentTier, 'complete');
  });
});
