// BRO-4429: classifiers that read partial text must not drop real reviews.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const cq = require('./content-quality.js');
const cv = require('./content-verifier.js');
const { buildClassifySample } = require('./classify-sample.js');
const { nonReviewStampBlockReason } = require('./flagged-recovery.js');
const { applyReviewFieldEdit } = require('./review-field-edit.js');

const REVIEW = 'Cleansed is a brutal, brilliant revival that earns its cruelty. '.repeat(40);
const BLOB = '[{"id":"a1","title":"Nigel Farage says {Reform} will win","body":"' + 'x'.repeat(400) + '"},{"id":"a2","title":"more"}]';

test('stripLeadingJsonBlob removes the Standard-shaped blob, keeps the review', () => {
  const out = cq.stripLeadingJsonBlob(BLOB + '\n\n' + REVIEW);
  assert.ok(out.startsWith('Cleansed is'));
  assert.ok(!out.includes('Farage'));
});

test('stripLeadingJsonBlob leaves normal text and short JSON-looking text alone', () => {
  assert.equal(cq.stripLeadingJsonBlob(REVIEW), REVIEW);
  const short = '[{"id":1}] ' + REVIEW;
  assert.equal(cq.stripLeadingJsonBlob(short), short);
});

test('isGarbageContent: blob + real review is valid; blob alone is garbage', () => {
  assert.equal(cq.isGarbageContent(BLOB + '\n\n' + REVIEW).isGarbage, false);
  assert.equal(cq.isGarbageContent(BLOB).isGarbage, true);
  assert.equal(cq.isGarbageContent(BLOB.slice(0, -5)).isGarbage, true); // unbalanced
});

test('tier wordCount ignores the blob', () => {
  const t = cq.classifyContentTier({ fullText: BLOB + ' ' + REVIEW });
  const clean = cq.classifyContentTier({ fullText: REVIEW });
  assert.equal(t.wordCount, clean.wordCount);
});

test('no CV staleness hash site hashes raw fullText', () => {
  const fs = require('node:fs');
  for (const f of ['review-guards.js', 'rebuild-helpers.js', '../scoring-delta.js', '../rebuild-all-reviews.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/createHash\('md5'\)\.update\([a-zA-Z.]*fullText\.substring\(0, 2500\)/.test(src), f + ' hashes raw fullText');
  }
});

test('contentHash ignores a leading blob (CV reads the stripped text)', () => {
  assert.equal(cv.contentHash(BLOB + '\n\n' + REVIEW), cv.contentHash(REVIEW));
});

test('CV verdict from the 2500-char head of a longer article is partial-window', () => {
  const long = 'Opening scene-setting. '.repeat(300);
  assert.equal(cv.isCvVerdictFromPartialWindow({ wrongArticle: true, articleType: 'preview', confidence: 'high' }, long), true);
  assert.equal(cv.isCvVerdictFromPartialWindow({ wrongArticle: true, articleType: 'news', confidence: 'medium' }, long), true);
  // high-confidence interview is identifiable from the head
  assert.equal(cv.isCvVerdictFromPartialWindow({ wrongArticle: true, articleType: 'interview', confidence: 'high' }, long), false);
  // whole article fit in the window: verdict is complete
  assert.equal(cv.isCvVerdictFromPartialWindow({ wrongArticle: true, articleType: 'preview', confidence: 'medium' }, 'short '.repeat(100)), false);
  assert.equal(cv.isCvVerdictFromPartialWindow({ wrongArticle: false }, long), false);
  // different-show evidence is never advisory
  assert.equal(cv.isCvVerdictFromPartialWindow({ wrongArticle: true, wrongProduction: true, articleType: 'review', confidence: 'medium' }, long), false);
  // a high-confidence preview of a piece only slightly over the window stands
  assert.equal(cv.isCvVerdictFromPartialWindow({ wrongArticle: true, articleType: 'preview', confidence: 'high' }, 'w '.repeat(1500)), false);
});

test('"not a review" judged on a cut-off fetch of a /review/ URL is a truncation artifact (BRO-4563)', () => {
  // Baltimore Sun, Maybe Happy Ending tour, 2026-09-17: 1,952 chars of lede.
  const verdict = {
    wrongArticle: true, wrongProduction: false, articleType: 'news', articleTypeConfidence: 'high', confidence: 'high', truncated: false,
    issues: ['Article is not a review — it is a news/announcement piece about the national tour debut', 'Text is severely truncated at 1952 characters; the substantive review content appears to be missing'],
    reasoning: 'The text ends immediately after the lede and is heavily truncated.',
  };
  const lede = "Baltimore's theater scene benefits once again with the national tour debut of Maybe Happy Ending. ".repeat(19);
  const url = 'https://www.baltimoresun.com/2026/09/17/maybe-happy-ending-review/';
  assert.ok(lede.length < cv.CV_WINDOW_CHARS);
  assert.equal(cv.isCvVerdictFromTruncatedFetch(verdict, lede, url), true);
  assert.equal(cv.isCvVerdictFromTruncatedFetch({ ...verdict, issues: ['news piece'], reasoning: 'announcement', truncated: true }, lede, url), true, 'the truncated flag alone counts');
  // Any one condition missing: the verdict stands.
  assert.equal(cv.isCvVerdictFromTruncatedFetch({ ...verdict, issues: ['news piece'], reasoning: 'announcement' }, lede, url), false, 'verifier did not say it was cut off');
  assert.equal(cv.isCvVerdictFromTruncatedFetch(verdict, lede, 'https://www.baltimoresun.com/2026/09/17/maybe-happy-ending-tour-opens/'), false, 'URL does not say review');
  assert.equal(cv.isCvVerdictFromTruncatedFetch(verdict, lede, 'https://www.reviewjournal.com/2026/09/17/maybe-happy-ending-tour/'), false, 'review in the host is not the path');
  assert.equal(cv.isCvVerdictFromTruncatedFetch(verdict, 'w '.repeat(2000), url), false, 'the verifier saw a full window');
  assert.equal(cv.isCvVerdictFromTruncatedFetch({ ...verdict, articleType: 'interview' }, lede, url), false, 'an interview is clear from the head');
  assert.equal(cv.isCvVerdictFromTruncatedFetch({ ...verdict, wrongProduction: true }, lede, url), false);
  assert.equal(cv.isCvVerdictFromTruncatedFetch({ ...verdict, wrongArticle: false }, lede, url), false);
  assert.equal(cv.isCvVerdictFromTruncatedFetch(verdict, lede, 'not a url'), false);
  assert.equal(cv.isCvVerdictFromTruncatedFetch(null, lede, url), false);
  // Rebuild sees the collector's stamp through the partial-window check.
  assert.equal(cv.isCvVerdictFromPartialWindow({ ...verdict, truncatedFetch: true }, lede), true);
  assert.equal(cv.isCvVerdictFromPartialWindow(verdict, lede), false);
  assert.equal(cv.isCvVerdictFromPartialWindow({ ...verdict, articleType: 'interview', truncatedFetch: true }, lede), false);
  // A reverify replaces the cv object and drops the stamp: with the record,
  // rebuild re-derives it (fullText, or wrongFullText when the collector nulled it).
  assert.equal(cv.isCvVerdictFromPartialWindow(verdict, lede, { url, fullText: lede }), true);
  assert.equal(cv.isCvVerdictFromPartialWindow(verdict, null, { url, fullText: null, wrongFullText: lede }), true);
  assert.equal(cv.isCvVerdictFromPartialWindow(verdict, lede, { url: 'https://www.baltimoresun.com/2026/09/17/tour-opens/', fullText: lede }), false);
  // A roundup, year-in-review or /reviews/ section page is not one review.
  for (const u of [
    'https://www.baltimoresun.com/2026/09/17/maybe-happy-ending-review-roundup/',
    'https://www.baltimoresun.com/2026/12/30/theater-year-in-review/',
    'https://www.baltimoresun.com/entertainment/theater/reviews/',
  ]) assert.equal(cv.isCvVerdictFromTruncatedFetch(verdict, lede, u), false, u);
});

test('the collector stamps truncatedFetch and keeps the text instead of invalidating (BRO-4563)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../collect-review-texts.js', import.meta.url), 'utf8');
  assert.match(src, /isCvVerdictFromTruncatedFetch\(contentVerification, cleanedText, data\.url \|\| review\.url\) \? \{ truncatedFetch: true \}/);
  const branch = src.indexOf('if (data.contentVerification.truncatedFetch) {');
  const nulling = src.indexOf("data.incompleteReason = 'non_review';");
  assert.ok(branch > 0 && nulling > branch, 'the truncated-fetch branch runs before the non-review nulling');
});

test('classifier sample includes the region where the show is discussed', () => {
  const history = 'The history of the Paris Opera house is long and storied. '.repeat(60);
  const middle = 'Les Miserables Arena Concert Spectacular is thrilling; the staging soars. '.repeat(10);
  const tail = 'Four stars. '.repeat(60);
  const s = buildClassifySample('Les Miserables Arena Concert Spectacular', history + middle + history + tail);
  assert.ok(s.includes('staging soars'));
  assert.ok(s.length < 5000);
});

test('classifier sample strips the JSON blob and falls back to head+tail with no mentions', () => {
  const s = buildClassifySample('Cleansed', BLOB + REVIEW);
  assert.ok(!s.includes('Farage'));
  const nomention = buildClassifySample('Zzzzz Show', 'alpha '.repeat(2000) + 'omega');
  assert.ok(nomention.endsWith('omega'));
});

test('nonReviewStampBlockReason: CV review, manual clear, bot stub block the stamp', () => {
  assert.match(nonReviewStampBlockReason({ contentVerification: { isValid: true, confidence: 'high', articleType: 'review' } }), /content-verifier/);
  assert.match(nonReviewStampBlockReason({ wrongProductionManualClear: true }), /manually cleared/);
  assert.match(nonReviewStampBlockReason({}, true), /bot-truncated/);
  assert.equal(nonReviewStampBlockReason({ contentVerification: { isValid: true, confidence: 'medium' } }), null);
  assert.equal(nonReviewStampBlockReason({}), null);
});

test('review-field-edit accepts the Gemini non-review clear pair', () => {
  const rec = { isNonReview: true, nonReviewManualClear: null, fullText: 'x' };
  const a = applyReviewFieldEdit(rec, { field: 'nonReviewManualClear', oldValue: null, newValue: true }, { fixId: 't', at: 'now' });
  assert.equal(a.ok, true);
  const b = applyReviewFieldEdit(a.record, { field: 'isNonReview', oldValue: true, newValue: false }, { fixId: 't', at: 'now' });
  assert.equal(b.ok, true);
  assert.equal(b.record.isNonReview, false);
});

test('ensemble scoring text (getBestTextForScoring) excludes the JSON blob', () => {
  const { getBestTextForScoring } = require('./text-quality.js');
  const r = getBestTextForScoring({ fullText: BLOB + '\n\n' + REVIEW });
  assert.equal(r.type, 'fullText');
  assert.ok(!r.text.includes('Farage'));
  assert.ok(r.text.startsWith('Cleansed is'));
});

// A multi-show column (Theatrely on Hungry Women shape): the target show's
// section starts after the first 2,500 chars.
const COLUMN = [
  `The Other Play | Photo: Someone. ${'otherplay staging acting '.repeat(140)}`,
  `Meanwhile Hungry Women imagines a world without men and it is a thrilling night. ${'hungry '.repeat(200)}`,
  `${'middle '.repeat(250)}`,
  `In short, Hungry Women is hardly starved for material and I loved it. ${'closing '.repeat(40)}`,
].join('\n\n');

test('classifier sample finds a title with accents and a subtitle (shows.json form vs the critic\'s)', () => {
  const text = 'history '.repeat(500) + 'This “Les Misérables” at Radio City is enormous and it works. ' + 'mis '.repeat(100) + 'coda '.repeat(400);
  const s = buildClassifySample('Les Misérables: The Arena Concert Spectacular', text);
  assert.ok(s.includes('Radio City is enormous'), 'folded, subtitle-free variant matched');
});

test('classifier sample spreads windows instead of taking the earliest mentions', () => {
  const early = Array.from({ length: 6 }, (_, i) => `Hungry Women line ${i}. ${'e '.repeat(400)}`).join(' ');
  const text = 'head '.repeat(400) + early + 'filler '.repeat(900) + 'LATE: Hungry Women is the verdict here. ' + 'tail '.repeat(300);
  const s = buildClassifySample('Hungry Women', text);
  assert.ok(s.includes('LATE: Hungry Women is the verdict'));
});

test('content-verifier prompt carries the late section of a multi-show column after the 2,500-char head', () => {
  assert.ok(!COLUMN.slice(0, cv.CV_WINDOW_CHARS).includes('Hungry Women'), 'fixture: title absent from the head');
  const { prompt } = cv.buildVerificationPrompt({
    scrapedText: COLUMN, showTitle: 'Hungry Women', outletName: 'Theatrely', criticName: 'A Critic',
    market: 'off-broadway', publishDate: '2026-08-03',
  });
  assert.ok(prompt.includes('Hungry Women imagines a world without men'));
  assert.ok(prompt.includes('hardly starved'), 'ending included');
  assert.ok(prompt.includes('which is NOT truncation'));
});

test('wrong-show and wrong-production prompts reach the late section of a multi-show column', () => {
  const { buildWrongShowUserPrompt, buildWrongProductionUserPrompt } = require('./classifier-prompts.js');
  const show = { id: 'hw-2026', title: 'Hungry Women', type: 'play', market: 'off-broadway' };
  assert.ok(buildWrongShowUserPrompt({ show, showTitle: 'Hungry Women', showId: show.id, text: COLUMN }).includes('Hungry Women imagines'));
  const wp = buildWrongProductionUserPrompt({ show, result: { showId: show.id, showYear: 2026, signals: [] }, reviewData: { fullText: COLUMN }, revivals: [] });
  assert.ok(wp.includes('Hungry Women imagines'));
});

test('CV wrongArticle routes by family: not-a-review is never wrongShow', () => {
  const { cvWrongArticleFamily } = require('./review-guards.js');
  assert.equal(cvWrongArticleFamily({ wrongArticle: true, wrongProduction: false, articleType: 'preview' }), 'nonReview');
  assert.equal(cvWrongArticleFamily({ wrongArticle: true, wrongProduction: true }), 'wrongShow');
  assert.equal(cvWrongArticleFamily({ wrongArticle: false, wrongProduction: true }), null);
  assert.equal(cvWrongArticleFamily(null), null);
});

test('a human non-review clear stops CV re-promotion', () => {
  const { cvNonReviewHumanCleared } = require('./review-guards.js');
  assert.equal(cvNonReviewHumanCleared({ nonReviewManualClear: true }), true);
  assert.equal(cvNonReviewHumanCleared({ wrongArticleManualClear: true }), true);
  assert.equal(cvNonReviewHumanCleared({ humanReviewedWrongArticle: false }), true);
  assert.equal(cvNonReviewHumanCleared({ isNonReview: false }), false);
});
