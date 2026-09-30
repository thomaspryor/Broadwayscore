// TESTS-VS-DERIVED-DATA-EXEMPT: pure-function unit tests against synthetic fixtures, no live shows.json facts asserted.
/**
 * BRO-4429: classifiers read part of a review's text and dropped real reviews.
 * Each block pins one root cause, with a synthetic fixture shaped like the
 * verified case (no review text is copied here):
 *   - Standard / Cleansed: homepage JSON array stored ahead of the review
 *     → text-cleaning strips it, content tier judges the prose.
 *   - NY Sun Les Mis / Hungry Women Theatrely column / Saviors TheaterMania:
 *     the verdict lives past the first 2,500 chars → the classifier sample
 *     carries the passages that name the show and the ending.
 *   - Electra/Persona NYT: Gemini stamped "preview" over a manual clear, a
 *     high-confidence CV "review" and bot-stub text → stamp blocked.
 *   - Saviors: the rebuild's main loop promoted a pure not-a-review CV
 *     verdict to wrongShow → routed to the non-review family, and a human
 *     clear stops re-promotion.
 *   - review-field-edit: a cloud plan can clear the Gemini flag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stripLeadingJsonBlob, hasLeadingJsonBlob, cleanText } = require('./text-cleaning.js');
const { classifyContentTier } = require('./content-quality.js');
const { sampleTextForClassifier, geminiNonReviewStampBlocker, SAMPLE_GAP } = require('./classifier-partial-text.js');
const { buildVerificationPrompt } = require('./content-verifier.js');
const { cvWrongArticleFamily, cvNonReviewHumanCleared } = require('./review-guards.js');
const { applyReviewFieldEdit } = require('./review-field-edit.js');

const STAMP = { fixId: 'test', at: '2026-09-30T00:00:00.000Z' };

// Homepage article-list JSON, the shape a standard.co.uk wayback fetch stored.
function homepageJson(n = 40) {
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({
    id: 1292000 + i,
    path: `/news/politics/story-${i}-b${1292000 + i}.html`,
    title: `Politics headline number ${i} about a minister`,
    standfirst: 'A short standfirst for the homepage card',
  })));
}

function para(words, seed) {
  return Array.from({ length: words }, (_, i) => `${seed}${i % 7 === 6 ? '.' : ''}`).join(' ');
}

const REVIEW_PROSE = [
  'Culture | Theatre',
  'There were more walkouts than I have seen in a theatre from this gruelling, gripping production of Cleansed.',
  `${para(120, 'staging')} The revival of Cleansed is a hard watch, but it is impeccably done and the cast is superb.`,
  `${para(120, 'performance')} It is certainly one of the finest productions of the year and I recommend it.`,
].join('\n\n');

test('text-cleaning strips a leading homepage JSON blob and keeps the review', () => {
  const text = `${homepageJson()}\n \n ${REVIEW_PROSE}`;
  assert.equal(hasLeadingJsonBlob(text), true);
  const stripped = stripLeadingJsonBlob(text);
  assert.ok(stripped.startsWith('Culture | Theatre'), stripped.slice(0, 40));
  assert.ok(!cleanText(text).includes('"path"'), 'cleanText drops the blob at write time');
  assert.ok(cleanText(text).includes('impeccably done'));
});

test('text-cleaning leaves editor notes and bracketed prose alone', () => {
  for (const text of [
    `[Note: This review was originally published in November.] ${REVIEW_PROSE}`,
    `[Title of Show] is a self-referential meta-musical. ${REVIEW_PROSE}`,
    `{Updated} ${REVIEW_PROSE}`,
    `["short"] ${REVIEW_PROSE}`, // valid JSON but under the 200-char floor
  ]) {
    assert.equal(hasLeadingJsonBlob(text), false, text.slice(0, 30));
    assert.equal(stripLeadingJsonBlob(text), text);
  }
});

test('LLM scoring input skips a leading JSON blob (ensemble garbage_text rejection)', () => {
  const { getBestTextForScoring } = require('./text-quality.js');
  const best = getBestTextForScoring({ fullText: `${homepageJson()}\n \n ${REVIEW_PROSE}` });
  assert.equal(best.type, 'fullText');
  assert.ok(best.text.startsWith('Culture | Theatre'), best.text.slice(0, 40));
  assert.ok(!best.text.includes('"standfirst"'));
});

test('content tier judges the prose behind a JSON blob, and a JSON-only text is not complete', () => {
  const withBlob = classifyContentTier({ fullText: `${homepageJson()}\n${REVIEW_PROSE}` });
  const prose = classifyContentTier({ fullText: REVIEW_PROSE });
  assert.equal(withBlob.contentTier, prose.contentTier);
  assert.equal(withBlob.wordCount, prose.wordCount, 'JSON tokens are not counted as review words');
  const jsonOnly = classifyContentTier({ fullText: homepageJson(80) });
  assert.notEqual(jsonOnly.contentTier, 'complete');
});

// A long review whose lead is background and whose verdict comes late (NY Sun
// Les Mis shape) or a multi-show column whose first section is another show
// (Theatrely Hungry Women shape).
const LONG_COLUMN = [
  `The Other Play | Photo: Someone. ${para(420, 'otherplay')}`,
  `Meanwhile Hungry Women imagines a world without men and it is a thrilling night. ${para(200, 'hungry')}`,
  `${para(200, 'middle')}`,
  `In short, Hungry Women is hardly starved for material and I loved it. ${para(60, 'closing')}`,
].join('\n\n');

test('classifier sample carries the passages that name the show, not just the lead', () => {
  assert.ok(LONG_COLUMN.length > 6000, `fixture too short: ${LONG_COLUMN.length}`);
  assert.ok(LONG_COLUMN.slice(0, 2500).indexOf('Hungry Women') === -1, 'fixture: title absent from the old CV window');
  const { text, sampled } = sampleTextForClassifier(LONG_COLUMN, 'Hungry Women', { budget: 4000 });
  assert.equal(sampled, true);
  assert.ok(text.length <= 4000 + 4 * SAMPLE_GAP.length, `sample over budget: ${text.length}`);
  assert.ok(text.includes('Hungry Women imagines a world without men'), 'first mention window');
  assert.ok(text.includes('hardly starved'), 'ending / late mention');
  assert.ok(text.startsWith('The Other Play'), 'head kept');
});

test('classifier sample matches a title with diacritics and a subtitle', () => {
  const text = [
    para(500, 'history'),
    `This “Les Misérables” at Radio City is the opposite: rather than intimate, it is enormous. ${para(80, 'mis')}`,
    para(400, 'coda'),
  ].join('\n\n');
  const { text: sample } = sampleTextForClassifier(text, 'Les Misérables: The Arena Concert Spectacular', { budget: 3000 });
  assert.ok(sample.includes('Radio City'), 'accented mention found through the folded title variant');
});

test('short bodies are sent whole, after the JSON blob is dropped', () => {
  const { text, sampled, length } = sampleTextForClassifier(`${homepageJson()}\n${REVIEW_PROSE}`, 'Cleansed', { budget: 6000 });
  assert.equal(sampled, false);
  assert.equal(length, REVIEW_PROSE.length);
  assert.ok(!text.includes('"path"'));
});

test('content-verifier prompt shows the late section of a multi-show column', () => {
  const { prompt } = buildVerificationPrompt({
    scrapedText: LONG_COLUMN, showTitle: 'Hungry Women', outletName: 'Theatrely',
    criticName: 'A Critic', market: 'off-broadway', publishDate: '2026-08-03',
  });
  assert.ok(prompt.includes('Hungry Women imagines a world without men'));
  assert.ok(prompt.includes('"[...]" marks omitted text, which is NOT truncation'));
  assert.ok(!prompt.includes('first 2500 chars'));
});

test('Gemini stamp is blocked by a human clear, a high-confidence CV review, and bot-stub text', () => {
  // Electra/Persona NYT shape: all three at once; the human clear is reported first.
  const electra = {
    url: 'https://www.nytimes.com/2026/09/03/theater/some-show-review.html',
    fullText: para(300, 'nyt'),
    wrongProductionManualClear: true,
    truncationSignals: ['nyt_bot_stub'],
    contentVerification: { articleType: 'review', articleTypeConfidence: 'high', wrongArticle: false, isValid: true },
  };
  assert.equal(geminiNonReviewStampBlocker(electra), 'manual-clear:wrongProduction');
  assert.equal(geminiNonReviewStampBlocker({ ...electra, wrongProductionManualClear: undefined }), 'cv-high-confidence-review');
  assert.equal(geminiNonReviewStampBlocker({ ...electra, wrongProductionManualClear: undefined, contentVerification: undefined }), 'bot-stub-text');
  assert.equal(geminiNonReviewStampBlocker({ nonReviewManualClear: true }), 'manual-clear:nonReview');
  assert.equal(geminiNonReviewStampBlocker({ fullText: para(300, 'x'), humanReviewScore: 70 }), 'human-score');
});

test('Gemini stamp is allowed on an ordinary record and on a low-confidence CV', () => {
  const plain = { url: 'https://example.com/news/casting-announced', fullText: para(400, 'news') };
  assert.equal(geminiNonReviewStampBlocker(plain), null);
  assert.equal(geminiNonReviewStampBlocker({ ...plain, contentVerification: { articleType: 'review', confidence: 'low' } }), null);
  assert.equal(geminiNonReviewStampBlocker({ ...plain, contentVerification: { articleType: 'preview', confidence: 'high', wrongArticle: true } }), null);
});

test('RC2 short-extraction guard still blocks (review-marker URL, short body)', () => {
  assert.equal(
    geminiNonReviewStampBlocker({ url: 'https://example.com/reviews/show-review/', fullText: 'Accept all cookies to continue.' }),
    'short-extraction',
  );
});

test('CV wrongArticle routes by family: not-a-review is never wrongShow', () => {
  // Saviors TheaterMania shape: CV said preview (wrongArticle) with no wrongProduction.
  assert.equal(cvWrongArticleFamily({ wrongArticle: true, wrongProduction: false, articleType: 'preview' }), 'nonReview');
  assert.equal(cvWrongArticleFamily({ wrongArticle: true, wrongProduction: true }), 'wrongShow');
  assert.equal(cvWrongArticleFamily({ wrongArticle: false, wrongProduction: true }), null);
  assert.equal(cvWrongArticleFamily(null), null);
});

test('a human non-review clear stops CV re-promotion', () => {
  assert.equal(cvNonReviewHumanCleared({ nonReviewManualClear: true }), true);
  assert.equal(cvNonReviewHumanCleared({ wrongArticleManualClear: true }), true);
  assert.equal(cvNonReviewHumanCleared({ humanReviewedWrongArticle: false }), true);
  assert.equal(cvNonReviewHumanCleared({ isNonReview: false }), false);
  assert.equal(cvNonReviewHumanCleared(null), false);
});

test('review-field-edit lets a cloud plan clear a Gemini isNonReview stamp', () => {
  const rec = { isNonReview: true, nonReviewType: 'news', nonReviewClassifiedBy: 'gemini' };
  const a = applyReviewFieldEdit(rec, { field: 'isNonReview', oldValue: true, newValue: false }, STAMP);
  assert.equal(a.ok, true, a.reason);
  assert.equal(a.record.isNonReview, false);
  const b = applyReviewFieldEdit(a.record, { field: 'nonReviewManualClear', oldValue: null, newValue: true }, STAMP);
  assert.equal(b.ok, true, b.reason);
  const c = applyReviewFieldEdit(rec, { field: 'wrongArticleManualClear', oldValue: null, newValue: true }, STAMP);
  assert.equal(c.ok, true, c.reason);
});

test('review-field-edit refuses to un-set the manual clears or a non-boolean isNonReview', () => {
  const rec = { isNonReview: false, nonReviewManualClear: true, wrongArticleManualClear: true };
  assert.equal(applyReviewFieldEdit(rec, { field: 'nonReviewManualClear', oldValue: true, newValue: false }, STAMP).ok, false);
  assert.equal(applyReviewFieldEdit(rec, { field: 'wrongArticleManualClear', oldValue: true, newValue: null }, STAMP).ok, false);
  assert.equal(applyReviewFieldEdit(rec, { field: 'isNonReview', oldValue: false, newValue: 'no' }, STAMP).ok, false);
});
