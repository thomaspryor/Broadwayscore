// LIVE-DATA-LANE: reads data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessTextQuality, qualityOptsFor } = require('../../scripts/lib/content-quality');
const { selectScorableText } = require('../../scripts/lib/scorable-text');
const { getBestTextForScoring } = require('../../scripts/lib/text-quality');

// Synthetic browser boilerplate, not private review text. The long URL pushes
// the error message beyond the ordinary detector's first 300 characters.
const errorPage = 'The webpage at https://player.example/embed?review=the-imaginary-invalid-theater&token='
  + 'a'.repeat(400)
  + ' might be temporarily down or it may have moved permanently to a new web address.';
const excerpt = 'The Imaginary Invalid is a disappointing revival. The staging feels lifeless despite the energetic performances.';
const record = { showId: 'the-imaginary-invalid-2026', fullText: errorPage, dtliExcerpt: excerpt, contentTier: 'truncated' };

test('browser failure is rejected before the collector saves it', () => {
  assert.equal(assessTextQuality(errorPage, record.showId, 'The Imaginary Invalid').quality, 'garbage');
});

test('both scoring selectors use the excerpt instead of the browser error', () => {
  assert.deepEqual(selectScorableText(record), { text: excerpt, isExcerpt: true });
  const actualInput = getBestTextForScoring(record);
  assert.equal(actualInput.type, 'excerpt');
  assert.equal(actualInput.text, excerpt);
});

test('an error page without excerpts never becomes scoring input', () => {
  const noExcerpt = { ...record, dtliExcerpt: null };
  assert.equal(selectScorableText(noExcerpt), null);
  assert.equal(getBestTextForScoring(noExcerpt).status, 'insufficient');
});

test('ordinary prose about moving stays eligible', () => {
  const fullText = ('The Imaginary Invalid is a brilliant comedy. Its characters might be temporarily down, '
    + 'but they find renewed energy. The production has moved permanently to a new theatre. ').repeat(8);
  assert.equal(selectScorableText({ ...record, fullText }).isExcerpt, false);
  assert.equal(getBestTextForScoring({ ...record, fullText }).type, 'fullText');
});

test('an embedded player failure does not discard the real review around it', () => {
  const fullText = ('The Imaginary Invalid is a brilliant comedy with outstanding performances. ').repeat(25) + errorPage;
  assert.equal(selectScorableText({ ...record, fullText }).isExcerpt, false);
  assert.equal(getBestTextForScoring({ ...record, fullText }).type, 'fullText');
});

const capsule = {
  showId: 'school-days-off-west-end-2026', source: 'theatre-record', url: null,
  fullText: ('A dutiful replica of the old television film, immersing us in a life-size gym. '
    + 'Alice brings warmth to the brainy newcomer while Bob gives her rival an engaging swagger. '
    + 'The sugary finale leaves little room for surprise. ').repeat(2),
};

test('a print capsule does not need generic theater keywords to reach scoring', () => {
  assert.equal(selectScorableText(capsule)?.text, capsule.fullText);
  assert.notEqual(assessTextQuality(capsule.fullText, capsule.showId, undefined, qualityOptsFor(capsule)).quality, 'garbage');
});

test('the capsule exception does not admit scraped ledes or browser errors', () => {
  assert.equal(selectScorableText({ ...capsule, source: 'url-ingest' }), null);
  assert.equal(selectScorableText({ ...capsule, url: 'https://example.com/review' }), null);
  assert.equal(selectScorableText({ ...capsule, fullText: errorPage }), null);
});

test('explicit non-theater content remains rejected for print capsules', () => {
  const fullText = 'Breaking news: ' + 'Residents reported the incident to officials this morning. '.repeat(10);
  assert.ok(fullText.length >= 500 && fullText.length < 1000);
  assert.equal(selectScorableText({ ...capsule, fullText }), null);
});

test('keyword exemption is limited to 300-999 character print capsules', () => {
  for (const length of [99, 100, 299, 300, 999, 1000]) {
    assert.equal(qualityOptsFor({ ...capsule, fullText: 'x'.repeat(length) }).printCapsule === true,
      length >= 300 && length < 1000);
  }
});
