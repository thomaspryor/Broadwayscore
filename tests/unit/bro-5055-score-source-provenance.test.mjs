// BRO-5055: LLM scoring overwrote scoreSource ('guardian-star-svg' -> 'anchored-v6'),
// flipping bodyless provenance to aggregator-inherited, so the rebuild dropped
// page-parsed body-less West End reviews (annie-west-end-2017 6->3, 2026-10-22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { setScoreSourcePreservingProvenance } = require('../../scripts/lib/score-source-provenance.js');
const { bodylessScoreProvenance, isBodylessAggregatorScoreUncorroborated } = require('../../scripts/lib/review-guards.js');

const show = { id: 'annie-west-end-2017', title: 'Annie', venue: 'Piccadilly Theatre', category: 'west-end', cast: [] };

// guardian--michael-billington.json as of review-texts 7f7d8fd (before LLM scoring).
const guardianStub = () => ({
  showId: show.id, outletId: 'guardian', outlet: 'The Guardian', criticName: 'Michael Billington',
  url: 'https://www.theguardian.com/stage/2017/jun/05/annie-review-piccadilly-theatre-miranda-hart',
  fullText: null, originalScore: 60, scoreSource: 'guardian-star-svg', source: 'show-score-playwright',
  showScoreExcerpt: 'Miranda Hart makes a game West End debut as Miss Hannigan in a revival that is lively enough',
  contentTier: 'excerpt', firstSeenAt: '2026-10-22T18:03:46.300Z',
});

test('reproduces the drop: a bare overwrite flips page-parsed to excluded', () => {
  const before = guardianStub();
  assert.equal(isBodylessAggregatorScoreUncorroborated(before, show), false);
  const after = { ...guardianStub(), scoreSource: 'anchored-v6', assignedScore: 56 };
  assert.equal(isBodylessAggregatorScoreUncorroborated(after, show), true);
});

test('preserving overwrite keeps the page-parsed file included', () => {
  for (const label of ['anchored-v6', 'llm-v6', 'manual-cleared-haiku-fallback']) {
    const d = setScoreSourcePreservingProvenance(guardianStub(), label);
    assert.equal(d.scoreSource, label);
    assert.equal(d.scoreProvenance, 'page-parsed');
    assert.equal(bodylessScoreProvenance(d), 'page-parsed');
    assert.equal(isBodylessAggregatorScoreUncorroborated(d, show), false);
  }
});

test('aggregator-inherited files are never stamped (legacy rollout exemption intact)', () => {
  const legacy = { ...guardianStub(), scoreSource: 'show-score-stars', firstSeenAt: undefined };
  const d = setScoreSourcePreservingProvenance(legacy, 'anchored-v6');
  assert.equal(d.scoreProvenance, undefined);
  assert.equal(isBodylessAggregatorScoreUncorroborated(d, show), false); // pre-rollout, still exempt
  const fresh = setScoreSourcePreservingProvenance({ ...guardianStub(), scoreSource: 'show-score-stars' }, 'anchored-v6');
  assert.equal(fresh.scoreProvenance, undefined);
  assert.equal(isBodylessAggregatorScoreUncorroborated(fresh, show), true); // same verdict as before overwrite
});

test('files with a body or an existing stamp are left alone', () => {
  const bodied = setScoreSourcePreservingProvenance({ ...guardianStub(), fullText: 'x'.repeat(500) }, 'anchored-v6');
  assert.equal(bodied.scoreProvenance, undefined);
  const stamped = setScoreSourcePreservingProvenance({ ...guardianStub(), scoreProvenance: 'aggregator-inherited' }, 'anchored-v6');
  assert.equal(stamped.scoreProvenance, 'aggregator-inherited');
  assert.equal(setScoreSourcePreservingProvenance(null, 'x'), null);
});
