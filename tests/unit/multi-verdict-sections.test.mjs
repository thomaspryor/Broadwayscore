/**
 * BRO-4490: FT multi-review columns carry one star verdict per show. The star
 * extractor must take the run that ends this show's section, and must not
 * guess when the section cannot be told apart.
 *
 * Run: node --test tests/unit/multi-verdict-sections.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { splitVerdictSections, pickShowVerdict, multiVerdictStarStatus } = require('../../scripts/lib/multi-verdict-sections.js');
const { extractScore } = require('../../scripts/lib/score-extractors.js');
const { buildPlan } = require('../../scripts/audit-multi-verdict-stars.js');

// Invented prose in the FT column shape (no real review text).
const pad = 'The staging is careful and the cast commit to every scene. '.repeat(6);
const column = [
  `My Neighbour Totoro returns with its puppets. ${pad} My Neighbour Totoro is a tender family show. ★★★★★ To January 21, example.org`,
  ` Across town, Harbour Lights is a quieter affair. ${pad} The band are superb. ★★★☆☆ To December 3, example.org`,
  ` Finally, Paper Moons tells one family story. ${pad} The rows of coats remind us of other stories. ★★★☆☆ To November 12`,
].join('');

describe('splitVerdictSections / pickShowVerdict', () => {
  test('splits at each section-ending verdict run', () => {
    const s = splitVerdictSections(column);
    assert.equal(s.length, 3);
    assert.deepEqual(s.map((x) => x.filled), [5, 3, 3]);
  });

  test("picks the section that names the show, not the first or last run", () => {
    assert.equal(pickShowVerdict(column, 'My Neighbour Totoro').originalScore, '5/5 stars');
    assert.equal(pickShowVerdict(column, 'Harbour Lights').originalScore, '3/5 stars');
  });

  test('a single review is not split', () => {
    assert.equal(pickShowVerdict(`A fine evening. ${pad} ★★★★☆ To May 1`, 'Anything').status, 'single');
  });

  test('a mid-sentence decorative run does not end a section', () => {
    assert.equal(splitVerdictSections(`Rated ★★★★★ by fans. ${pad} A fine evening. ★★★★☆ To May 1`), null);
  });

  test('a title named equally in two sections is ambiguous', () => {
    const tied = column.replace('Across town, Harbour Lights', 'Across town, unlike My Neighbour Totoro, Harbour Lights')
      .replace(' My Neighbour Totoro is a tender', ' It is a tender');
    assert.equal(pickShowVerdict(tied, 'My Neighbour Totoro').status, 'ambiguous');
  });

  test('a title named nowhere is ambiguous', () => {
    assert.equal(pickShowVerdict(column, 'Unrelated Show').status, 'ambiguous');
  });
});

describe('extractScore on a multi-review FT column', () => {
  test("returns this show's section star", () => {
    const r = extractScore('', column, 'financialtimes', 'Harbour Lights');
    assert.equal(r.originalScore, '3/5 stars');
    assert.equal(r.normalizedScore, 60);
  });

  test('ambiguous (or no title): no star, even with a page-level json-ld rating', () => {
    const html = '<script type="application/ld+json">{"ratingValue": 5}</script>';
    assert.equal(extractScore(html, column, 'financialtimes', 'Unrelated Show'), null);
    assert.equal(extractScore(html, column, 'financialtimes'), null);
  });

  test('other outlets keep their existing star logic (scope is MULTI_VERDICT_OUTLETS)', () => {
    const r = extractScore('', column, 'guardian', 'Unrelated Show');
    assert.ok(r && r.source === 'unicode-stars-fallthrough');
  });
});

describe('multiVerdictStarStatus + audit plan', () => {
  const rec = (over) => ({ outletId: 'financialtimes', fullText: column, showTitle: 'My Neighbour Totoro', originalScore: '3/5 stars', ...over });
  test('mismatch names the section star', () => {
    const r = multiVerdictStarStatus(rec());
    assert.equal(r.kind, 'mismatch');
    assert.equal(r.want, '5/5 stars');
  });
  test('ok when stored star is the section star', () => {
    assert.equal(multiVerdictStarStatus(rec({ originalScore: '5/5 stars' })).kind, 'ok');
  });
  test('a human-verified rating is left alone', () => {
    assert.equal(multiVerdictStarStatus(rec({ originalScoreSource: 'manual-verified' })).kind, 'verified');
  });
  test('plan has one compare-and-set originalScore action per stored mismatch', () => {
    const plan = buildPlan('bro-4490', [
      { file: 'a/financialtimes--x.json', kind: 'mismatch', stored: '3/5 stars', want: '5/5 stars', mentions: [1, 0] },
      { file: 'b/financialtimes--x.json', kind: 'mismatch', stored: null, want: '4/5 stars', mentions: [1, 0] },
      { file: 'c/financialtimes--x.json', kind: 'ambiguous', stored: '3/5 stars', want: null, mentions: [1, 1] },
    ]);
    assert.equal(plan.status, 'pending');
    assert.equal(plan.plan.actions.length, 1);
    assert.deepEqual(
      { type: plan.plan.actions[0].type, field: plan.plan.actions[0].field, oldValue: plan.plan.actions[0].oldValue, newValue: plan.plan.actions[0].newValue },
      { type: 'review-field-edit', field: 'originalScore', oldValue: '3/5 stars', newValue: '5/5 stars' },
    );
  });
});

// Codex cross-check on BRO-4490: the LLM extractor is collect-review-texts'
// primary writer and read the page-level JSON-LD rating (or guessed a run).
describe('extractExplicitScore on a multi-review column', () => {
  const { extractExplicitScore } = require('../../scripts/lib/llm-score-extractor.js');
  const jsonLd5 = '<script type="application/ld+json">{"@type":"Review","reviewRating":{"@type":"Rating","ratingValue":"5","bestRating":"5"}}</script>';

  test("takes this show's section star, not the page's JSON-LD 5/5", async () => {
    const r = await extractExplicitScore({ text: column, html: jsonLd5, outletId: 'financialtimes', showTitle: 'Harbour Lights' });
    assert.equal(r.originalScore, '3/5 stars');
    assert.equal(r.normalizedScore, 60);
    assert.equal(r.source, 'unicode-stars');
    assert.equal(r.raw, '3/5 stars');
  });

  test('section path is taken even when the section star equals JSON-LD', async () => {
    const r = await extractExplicitScore({ text: column, html: jsonLd5, outletId: 'financialtimes', showTitle: 'My Neighbour Totoro' });
    assert.equal(r.originalScore, '5/5 stars');
    assert.equal(r.source, 'unicode-stars');
  });

  test('no title: the section is unknown, so no rating (never the page 5/5)', async () => {
    assert.equal(await extractExplicitScore({ text: column, html: jsonLd5, outletId: 'financialtimes' }), null);
  });

  test('extractScore and extractExplicitScore agree on the section star', async () => {
    const regex = extractScore(jsonLd5, column, 'financialtimes', 'Paper Moons');
    const llm = await extractExplicitScore({ text: column, html: jsonLd5, outletId: 'financialtimes', showTitle: 'Paper Moons' });
    assert.equal(regex.originalScore, llm.originalScore);
    assert.equal(regex.normalizedScore, llm.normalizedScore);
  });

  test('a single-review FT article keeps the normal path (JSON-LD)', async () => {
    const r = await extractExplicitScore({ text: `A fine evening. ${pad} ★★★★☆ To May 1`, html: jsonLd5, outletId: 'financialtimes', showTitle: 'Anything' });
    assert.notEqual(r.source, 'unicode-stars');
  });
});
