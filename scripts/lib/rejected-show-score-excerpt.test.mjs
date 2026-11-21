import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { rejectedShowScoreExcerptReason } = require('./rejected-show-score-excerpt');
const { safeWriteReview, _setShowsCacheForTest } = require('./review-write-guard');

const oldShow = { id: 'example-2008', title: 'Example', openingDate: '2008-02-01', closingDate: '2008-08-01' };
const show = { id: 'example-2026', title: 'Example', openingDate: '2026-11-01' };
// Synthetic text only. No private review text belongs in fixtures.
const review = { showId: show.id, outletId: 'times-uk', criticName: 'Clive Davis', url: null,
  publishDate: null, source: 'show-score-playwright', showScoreExcerpt: 'A fictional excerpt used solely to exercise the production identity guard.' };

function fixture(t, patch = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rejected-show-score-'));
  for (const s of [oldShow, show]) fs.mkdirSync(path.join(root, s.id));
  const prior = { ...review, showId: oldShow.id, publishDate: 'May 22nd, 2024', wrongProduction: true, ...patch };
  fs.writeFileSync(path.join(root, oldShow.id, 'times-uk--clive-davis.json'), JSON.stringify(prior));
  _setShowsCacheForTest(new Map([oldShow, show].map(s => [s.id, s])));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); _setShowsCacheForTest(null); });
  return root;
}

test('RULE21: gather shared writer flags a new URL-less, undated copied excerpt', t => {
  const root = fixture(t);
  const dest = path.join(root, show.id, 'times-uk--clive-davis.json');
  const result = safeWriteReview(dest, { ...review });
  assert.notEqual(result.wrote, false);
  const saved = JSON.parse(fs.readFileSync(dest, 'utf8'));
  assert.equal(saved.wrongProduction, true);
  assert.match(saved.wrongProductionNote, /example-2008/);
});

test('shared writer catches an excerpt merged into an existing empty stub', t => {
  const root = fixture(t);
  const dest = path.join(root, show.id, 'times-uk--clive-davis.json');
  fs.writeFileSync(dest, JSON.stringify({ ...review, showScoreExcerpt: null }));
  safeWriteReview(dest, { ...review });
  assert.equal(JSON.parse(fs.readFileSync(dest, 'utf8')).wrongProduction, true);
});

test('exact excerpt, same title, outlet and critic are all required', t => {
  const root = fixture(t);
  const reason = (r, s = show) => rejectedShowScoreExcerptReason(r, s, [oldShow, s], root);
  assert.match(reason(review), /example-2008/);
  for (const patch of [{ showScoreExcerpt: 'Brief praise' }, { showScoreExcerpt: review.showScoreExcerpt + ' Different.' },
    { outletId: 'guardian' }, { criticName: 'Another Critic' }, { criticName: 'Unknown' },
    { url: 'https://example.org/review' }, { publishDate: '2026-11-02' }, { fullText: 'Collected text' },
    { wrongProduction: false }, { wrongProductionManualClear: true }, { humanReviewScore: 80 },
    { assignedScore: 80 }, { llmScore: { score: 80 } }]) {
    assert.equal(reason({ ...review, ...patch }), null, JSON.stringify(patch));
  }
  assert.equal(reason(review, { ...show, title: 'Different Example' }), null);
  assert.equal(rejectedShowScoreExcerptReason(review, show, [show], root), null);
});

test('whitespace and case normalization preserve exact excerpt identity', t => {
  const root = fixture(t);
  assert.ok(rejectedShowScoreExcerptReason({ ...review, showScoreExcerpt: '  ' + review.showScoreExcerpt.toUpperCase().replaceAll(' ', '\n') }, show, [oldShow, show], root));
});

for (const patch of [{ wrongProduction: false }, { wrongProductionAutoCleared: true },
  { wrongProductionManualClear: true }, { humanReviewedWrongProduction: false },
  { publishDate: null }, { publishDate: 'unknown' }, { publishDate: oldShow.openingDate }, { publishDate: '2026-11-02' }]) {
  test(`a sibling is insufficient evidence: ${JSON.stringify(patch)}`, t => {
    const root = fixture(t, patch);
    assert.equal(rejectedShowScoreExcerptReason(review, show, [oldShow, show], root), null);
  });
}

test('declared prior-run coverage is kept', t => {
  const root = fixture(t);
  const returning = { ...show, priorRuns: [{ openingDate: '2024-05-01', closingDate: '2024-07-01' }] };
  assert.equal(rejectedShowScoreExcerptReason(review, returning, [oldShow, returning], root), null);
});

test('writer preserves a human-cleared existing record', t => {
  const root = fixture(t);
  const dest = path.join(root, show.id, 'times-uk--clive-davis.json');
  fs.writeFileSync(dest, JSON.stringify({ ...review, wrongProduction: false, wrongProductionManualClear: true }));
  safeWriteReview(dest, { ...review });
  assert.equal(JSON.parse(fs.readFileSync(dest, 'utf8')).wrongProduction, false);
});
