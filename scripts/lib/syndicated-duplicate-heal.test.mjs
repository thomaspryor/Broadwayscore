/**
 * BRO-4415: a syndicated secondary loses its isSyndicatedDuplicate mark when its
 * primary is excluded for a PRIMARY-ONLY reason (wrongProduction of a misfiled
 * copy, wrongAttribution, garbage extraction), and keeps it when the reason also
 * applies to the duplicate (wrongShow, nonReview). Drives the real helper and the
 * real explainExclusion; shapes are the live cases (2026-10-15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { syndicatedDuplicateHealPlan, classifyPrimaryExclusion } = require('./syndicated-duplicate-heal.js');
const { explainExclusion } = require('./review-guards.js');

const FOLDER = 'show-a';
const SHOW = { id: FOLDER, title: 'Show A', openingDate: '2026-01-08', status: 'open' };
const TEXT = 'A long, complete review of the production at the theatre. '.repeat(30);

const secondary = (extra = {}) => ({
  showId: FOLDER, outletId: 'ew', outlet: 'Entertainment Weekly', criticName: 'Pat Critic',
  url: 'https://ew.com/show-a-review-1', publishDate: '2026-01-08', fullText: TEXT, fullTextLength: TEXT.length,
  isSyndicatedDuplicate: true, syndicatedPrimaryFile: `${FOLDER}/cbsnews--pat-critic.json`, syndicationSimilarity: 98,
  ...extra,
});
const primary = (extra = {}) => ({
  showId: FOLDER, outletId: 'cbsnews', outlet: 'CBS News', criticName: 'Pat Critic',
  url: 'https://www.cbsnews.com/news/show-a-review/', publishDate: '2026-01-09', fullText: TEXT, fullTextLength: TEXT.length,
  ...extra,
});

function run(sec, pri, file = 'ew--pat-critic.json') {
  const files = { [file]: sec, 'cbsnews--pat-critic.json': pri };
  return syndicatedDuplicateHealPlan({
    data: sec, file, folder: FOLDER,
    io: { exists: (f) => f in files, read: (f) => files[f] },
    explain: (d, f) => explainExclusion(d, SHOW, `/nonexistent/${FOLDER}/${f}`),
  });
}

test('wrongAttribution on the primary: mark is cleared', () => {
  const r = run(secondary(), primary({ wrongAttribution: true, wrongAttributionReason: 'EW critic filed under CBS' }));
  assert.equal(r.decision, 'clear');
  assert.equal(r.primaryWhy, 'wrongAttribution');
  assert.equal(r.cleared.isSyndicatedDuplicate, false);
  assert.equal(r.cleared.syndicatedPrimaryFile, null);
  assert.equal(explainExclusion(r.cleared, SHOW, '/x/ew--pat-critic.json'), null);
});

test('wrongProduction of a misfiled/dated copy (no CV text verdict): cleared', () => {
  const r = run(secondary(), primary({ wrongProduction: true }));
  assert.equal(r.decision, 'clear');
  assert.match(r.reason, /misfiled/);
});

test('wrongProduction from a CV text verdict: kept, unless the secondary carries a human wrongProduction clear', () => {
  const cv = { wrongProduction: true, wrongProductionReason: 'CV: text is about the Steppenwolf production' };
  const kept = run(secondary(), primary(cv));
  assert.equal(kept.decision, 'keep');
  assert.match(kept.reason, /shared exclusion/);
  const healed = run(secondary({ wrongProductionManualClear: true, wrongProductionManualClearReason: 'in-window review', wrongProductionManualClearBy: 'audit' }), primary(cv));
  assert.equal(healed.decision, 'clear');
});

test('wrongShow on the primary (also wrongProduction): the exclusion applies to the duplicate, mark kept', () => {
  assert.equal(run(secondary(), primary({ wrongShow: true })).decision, 'keep');
  const both = run(secondary(), primary({ wrongProduction: true, wrongShow: true, wrongProductionReason: 'preview at the Public' }));
  assert.equal(both.decision, 'keep');
  assert.equal(both.reason, 'shared exclusion (wrongProduction+wrongShow)');
});

test('nonReview on the primary (isNotReview): mark kept', () => {
  const r = run(secondary(), primary({ isNotReview: true, isNotReviewReason: 'fan archive page' }));
  assert.equal(r.decision, 'keep');
  assert.equal(r.primaryWhy, 'nonReview');
});

test('a not_a_review rejection on the primary is shared; a garbage_text rejection is primary-only', () => {
  assert.equal(run(secondary(), primary({ rejectionReason: 'not_a_review', rejectedAt: '2026-03-01T00:00:00Z' })).decision, 'keep');
  const g = run(secondary(), primary({ rejectionReason: 'garbage_text', rejectedAt: '2026-03-01T00:00:00Z' }));
  assert.equal(g.decision, 'clear');
});

test('guards: no same-article evidence, operator assertion, or a secondary that stays excluded keeps the mark', () => {
  const wa = { wrongAttribution: true };
  assert.equal(run(secondary({ syndicationSimilarity: null }), primary(wa)).reason, 'same-article not verified');
  assert.equal(run(secondary({ syndicationSimilarity: 20 }), primary(wa)).reason, 'same-article not verified');
  assert.equal(run(secondary({ wrongShowManualClear: true }), primary(wa)).reason, 'operator assertion on the secondary');
  const own = run(secondary({ isNotReview: true, isNotReviewReason: 'roundup' }), primary(wa));
  assert.equal(own.decision, 'keep');
  assert.match(own.reason, /secondary still excluded/);
});

test('not applicable or structural: live primary, cycle exclusions, self/dangling/cross-show pointers', () => {
  assert.equal(run(secondary(), primary()), null, 'primary scores: ordinary live duplicate');
  assert.equal(run(secondary(), primary({ isSyndicatedDuplicate: true, syndicatedPrimaryFile: `${FOLDER}/ew--pat-critic.json` })), null, 'cycle is the BRO-4411 path');
  assert.equal(run(secondary({ isSyndicatedDuplicate: false }), primary({ wrongAttribution: true })), null);
  const self = run(secondary({ syndicatedPrimaryFile: `${FOLDER}/ew--pat-critic.json` }), primary());
  assert.match(self.reason, /self-pointer/);
  const dangling = run(secondary({ syndicatedPrimaryFile: `${FOLDER}/gone--pat-critic.json` }), primary());
  assert.match(dangling.reason, /primary-missing/);
  const other = run(secondary({ syndicatedPrimaryFile: 'other-show/cbsnews--pat-critic.json' }), primary());
  assert.equal(other.reason, 'primary-in-other-show');
});

test('classifyPrimaryExclusion: unknown reasons default to shared', () => {
  assert.equal(classifyPrimaryExclusion({}, 'cvWrongArticleHighConfidence', {}).scope, 'shared');
  assert.equal(classifyPrimaryExclusion({}, 'crossOutletDuplicate', {}).scope, 'shared');
});

test('findLiveSyndicationPrimary (BRO-5396): matches full and partial copies, ignores duplicates, refuses when it cannot tell', () => {
  const { findLiveSyndicationPrimary } = require('./syndicated-duplicate-heal.js');
  const body = Array.from({ length: 120 }, (_, i) => `word${i} sentence about the show`).join(' ');
  const half = body.slice(Math.floor(body.length * 0.6));
  const files = {
    'sec.json': { fullText: body.replace('word3 ', '&#8220;word3 ') },
    'full.json': { fullText: `Intro. ${body} Outro.` },
    'half.json': { fullText: `${half} ${half.length > 0 ? 'tail' : ''}` },
    'other.json': { fullText: 'something entirely different '.repeat(60) },
    'dup.json': { fullText: body, isSyndicatedDuplicate: true },
  };
  const read = (f) => { if (f === 'bad.json') throw new Error('parse'); return files[f]; };
  const run = (siblings, data = files['sec.json']) => findLiveSyndicationPrimary({ data, file: 'sec.json', siblings, read });
  assert.deepEqual(run(['sec.json', 'full.json']), { file: 'full.json', undecidable: false });
  assert.deepEqual(run(['sec.json', 'half.json']), { file: 'half.json', undecidable: false }, 'partial copy found from the candidate side');
  assert.deepEqual(run(['sec.json', 'other.json', 'dup.json']), { file: null, undecidable: false });
  assert.equal(run(['sec.json', 'other.json', 'bad.json']).undecidable, true, 'unparseable sibling');
  assert.equal(run(['sec.json', 'full.json'], { fullText: 'short' }).undecidable, true, 'short secondary');
});
