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
