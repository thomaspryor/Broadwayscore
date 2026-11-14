// BRO-5924: marker-cut sections for a column with no venue boxes (NYT, two shows, one article).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sectionByMarkers, planSectionCopy } = require('./multishow-section-copy.js');

const A = 'Alpha opens the piece here and it is long enough to matter for the first show. '.repeat(14);
const B = 'Beta is the second show and the critic dislikes it for many different reasons. '.repeat(14);
const LEDE = 'Two shows opened this month, “Alpha” and “Beta”. ';
const TEXT = `${LEDE}The more compelling is the sprawling “Alpha,” a real mess. ${A}There’s still time. Unfortunately, I don’t think “Beta” works. ${B}None of us are getting any younger.`;
const source = { showId: 'beta-2026', outletId: 'nytimes', outlet: 'The New York Times', criticName: 'H S', url: 'https://www.nytimes.com/x.html', publishDate: '2026-10-21', contentTier: 'complete', fullText: TEXT, llmScore: { score: 42 }, ensembleData: { claudeScore: 42 } };

test('sectionByMarkers cuts between the markers, ignoring punctuation and case', () => {
  const r = sectionByMarkers(TEXT, 'The_more_compelling_is_the_sprawling', 'There_s_still_time');
  assert.equal(r.ok, true);
  assert.ok(r.text.startsWith('The more compelling is the sprawling “Alpha,”'));
  assert.ok(r.text.endsWith('There’s still time.'));
  assert.ok(!r.text.includes('Beta is the second'));
});

test('sectionByMarkers refuses a missing, repeated, short or reversed marker', () => {
  assert.equal(sectionByMarkers(TEXT, 'No_such_words_here', 'There_s_still_time').ok, false);
  assert.match(sectionByMarkers(TEXT, 'Alpha_opens_the_piece', 'There_s_still_time').reason, /occurs 14 times/);
  assert.match(sectionByMarkers(TEXT, 'too_short', 'There_s_still_time').reason, /4\+ words/);
  assert.match(sectionByMarkers(TEXT, 'getting_any_younger_x', 'x').reason, /4\+ words|occurs/);
  assert.match(sectionByMarkers(TEXT, 'None_of_us_are', 'The_more_compelling_is_the').reason, /before the start/);
});

const plan = (over = {}) => planSectionCopy({
  source, sourceShowId: 'beta-2026', targetShowId: 'alpha-2026', target: null, method: 'markers',
  expectStart: 'The_more_compelling_is_the_sprawling', expectEnd: 'There_s_still_time',
  section: sectionByMarkers(TEXT, 'The_more_compelling_is_the_sprawling', 'There_s_still_time'),
  ownSection: sectionByMarkers(TEXT, 'Unfortunately_I_don_t_think', 'are_getting_any_younger'), ...over,
});

test('marker split: child gets only its section, source is cut to its own and both are re-queued for scoring', () => {
  const p = plan();
  assert.equal(p.ok, true, p.reason);
  assert.ok(p.row.fullText.includes('Alpha opens') && !p.row.fullText.includes('Beta is the second'));
  assert.equal(p.row.multiShowSectionCopy.method, 'markers');
  assert.ok(p.parent.fullText.startsWith('Unfortunately') && !p.parent.fullText.includes('Alpha opens'));
  assert.equal(p.parent.llmScore, undefined, 'the whole-article score must not survive the trim');
  assert.equal(p.parent.ensembleData, undefined);
  assert.equal(p.parent.needsRescore, true);
  assert.equal(p.row.needsRescore, true);
  assert.deepEqual(p.parent.multiShowSplitChildShowIds, ['alpha-2026']);
});

test('marker split refuses an own section that is missing, tiny or overlaps the target section', () => {
  assert.equal(plan({ ownSection: { ok: false, reason: 'nope' } }).ok, false);
  assert.match(plan({ ownSection: { ok: true, text: 'short' } }).reason, /only 5 chars/);
  const overlap = sectionByMarkers(TEXT, 'The_more_compelling_is_the_sprawling', 'There_s_still_time');
  assert.match(plan({ ownSection: overlap }).reason, /overlap/);
});

test('without ownSection the source keeps its whole text (venue-box behaviour unchanged)', () => {
  const p = plan({ ownSection: null });
  assert.equal(p.ok, true);
  assert.equal(p.parent.fullText, TEXT);
  assert.equal(p.parent.multiShowSplitMethod, 'markers');
});

const OWN = () => sectionByMarkers(TEXT, 'Unfortunately_I_don_t_think', 'are_getting_any_younger');
const SEC = () => sectionByMarkers(TEXT, 'The_more_compelling_is_the_sprawling', 'There_s_still_time');
const planOwn = (src) => planSectionCopy({ source: src, sourceShowId: 'beta-2026', section: SEC(), target: null, targetShowId: 'alpha-2026',
  expectStart: 'The_more_compelling_is_the_sprawling', expectEnd: 'There_s_still_time', method: 'markers', ownSection: OWN() });

test('a locked or human-scored source is never trimmed', () => {
  assert.match(planOwn({ ...source, _locked: true }).reason, /_locked/);
  assert.match(planOwn({ ...source, manualContentTier: 'complete' }).reason, /manualContentTier/);
  assert.match(planOwn({ ...source, humanReviewScore: 40 }).reason, /humanReviewScore/);
});

test('the trimmed source loses every whole-article score field', () => {
  const r = planOwn({ ...source, assignedScore: 44, originalScore: 44, scoreSource: 'llm', llmMetadata: { m: 1 } });
  assert.equal(r.ok, true);
  for (const k of ['llmScore', 'ensembleData', 'assignedScore', 'originalScore', 'scoreSource', 'llmMetadata']) assert.equal(r.parent[k] ?? null, null, k);
});
