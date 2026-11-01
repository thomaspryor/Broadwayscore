// BRO-6716: a fresh fetch of the same url replaces a stored body that is a
// DIFFERENT real article (Standard travel piece, TheWrap review of another
// show) when an automated verdict already says so. Requires the real writer
// and predicates (CLAUDE.md §15). Fixtures are invented prose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer.js');
const { isRightArticleReplacementForWrongBody } = require('../../scripts/lib/junk-body.js');
const { containsTitlePhrase } = require('../../scripts/lib/title-phrase.js');

const SHOW = 'synthetic-noon-west-end-2026';
const TITLE = 'Synthetic Noon';
const URL1 = 'https://www.standard.co.uk/culture/theatre/synthetic-noon-theatre-review-b1000001.html';
const OTHER = 'A weekend in the hills offers spa treatments, long walks and a hotel restaurant with a strong wine list. '.repeat(12);
const REVIEW = 'Synthetic Noon theatre review: the lead brings charisma to a bold real-time staging at the Harold Pinter. '
  + 'The adaptation takes risks and the storytelling is propulsive, though the second half sags before a taut finish. '.repeat(12);

function setup(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6716-wb-'));
  fs.mkdirSync(path.join(dir, SHOW));
  fs.writeFileSync(path.join(dir, SHOW, 'standard--jane-doe.json'), JSON.stringify({
    showId: SHOW, outletId: 'standard', outlet: 'Evening Standard', criticName: 'Jane Doe', url: URL1,
    publishDate: '2026-01-11', fullText: OTHER, contentTier: 'invalid', ...data,
  }, null, 2));
  return dir;
}
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, SHOW, 'standard--jane-doe.json'), 'utf8'));
const ingest = (dir, fullText = REVIEW, extra = {}) => createOrMergeReviewFile(SHOW, {
  outletId: 'standard', outlet: 'Evening Standard', criticName: 'Jane Doe', url: URL1, source: 'ingest-urls',
  replaceBadBody: true, showTitle: TITLE, fields: { fullText }, ...extra,
}, { reviewTextsDir: dir });

test('title phrase: full title only, inside the window', () => {
  assert.equal(containsTitlePhrase('Music fills the room in a new musical about a city.', 'Music City'), false);
  assert.equal(containsTitlePhrase('The Playboy of the Western World: a strong turn', 'The Playboy of the Western World'), true);
  assert.equal(containsTitlePhrase('x '.repeat(900) + 'Synthetic Noon', TITLE, { within: 1500 }), false, 'late mention');
  assert.equal(containsTitlePhrase('Hamlet', 'Fun'), false, 'short title never matches');
});

test('a flagged wrong-article body is replaced by the right review of the same url', () => {
  const dir = setup({ wrongShow: true, wrongShowReason: 'CV-promoted: travel article, not a review',
    llmScore: { score: 70 }, assignedScore: 70, rejectionReason: 'not_a_review', rejectedBy: 'ensemble-scoreability-check', rejectedAt: '2026-01-20T00:00:00Z' });
  ingest(dir);
  const d = read(dir);
  assert.equal(d.fullText, REVIEW);
  assert.ok(d.wrongBodyReplacedAt);
  assert.equal(d.rejectionReason, null, 'text-quality rejection of the old body is void');
  assert.equal(d.wrongShow, true, 'flags stay for the heals / a person to decide');
  assert.equal(d.llmScore, null, 'score of the old body is parked');
});

test('a model-classified isNonReview on the wrong body does not keep its score alive', () => {
  const dir = setup({ wrongShow: true, wrongShowReason: 'CV-promoted: travel article', isNonReview: true, nonReviewType: 'feature',
    nonReviewClassifiedBy: 'gemini', llmScore: { score: 70 }, assignedScore: 70 });
  ingest(dir);
  const d = read(dir);
  assert.equal(d.fullText, REVIEW);
  assert.equal(d.llmScore, null, 'score of the travel piece is parked');
  assert.equal(d.isNonReview, true, 'flag itself stays for a person or plan');
});

test('a wrong_production rejection survives the body swap', () => {
  const dir = setup({ wrongProduction: true, rejectionReason: 'wrong_production', rejectedBy: 'ensemble-scoreability-check', rejectedAt: '2026-01-20T00:00:00Z' });
  ingest(dir);
  const d = read(dir);
  assert.equal(d.fullText, REVIEW);
  assert.equal(d.rejectionReason, 'wrong_production');
});

test('no swap without a verdict, with a person ruling, when both name the show, or on a late mention', () => {
  let dir = setup({});
  ingest(dir);
  assert.equal(read(dir).fullText, OTHER, 'no automated verdict');
  dir = setup({ wrongShow: true, wrongShowNote: 'checked by hand' });
  ingest(dir);
  assert.equal(read(dir).fullText, OTHER, 'human note');
  const storedNamesShow = 'Synthetic Noon, an older notice of the same title. ' + OTHER;
  dir = setup({ wrongShow: true, fullText: storedNamesShow });
  ingest(dir);
  assert.equal(read(dir).fullText, storedNamesShow, 'stored body already names the show: one real review never replaces another');
  dir = setup({ wrongShow: true });
  ingest(dir, OTHER + OTHER + ' Related: Synthetic Noon review.');
  assert.equal(read(dir).fullText, OTHER, 'title only in a related-reads link past the opening');
  dir = setup({ wrongShow: true, humanReviewScore: 64 });
  ingest(dir);
  assert.equal(read(dir).fullText, OTHER, 'a person scored it');
  dir = setup({ wrongShow: true, originalScore: 4, originalScoreCapturedFrom: 'fullText' });
  ingest(dir);
  assert.equal(read(dir).fullText, OTHER, 'a rating read out of the wrong body would survive the swap');
  dir = setup({ wrongShow: true });
  ingest(dir, REVIEW, { replaceBadBody: false });
  assert.equal(read(dir).fullText, OTHER, 'only explicit single-url ingests swap bodies');
});

test('predicate: incoming must be review-sized', () => {
  assert.equal(isRightArticleReplacementForWrongBody(OTHER, 'Synthetic Noon is fine.', TITLE, { wrongShow: true }), false);
  assert.equal(isRightArticleReplacementForWrongBody(OTHER, REVIEW, TITLE, { wrongShow: true }), true);
});
