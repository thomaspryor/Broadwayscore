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

test('body-having files are stamped too; an existing stamp is left alone', () => {
  const bodied = setScoreSourcePreservingProvenance({ ...guardianStub(), fullText: 'x'.repeat(500) }, 'anchored-v6');
  // body present at scoring time: still stamped, so clearing the body later cannot flip it
  assert.equal(bodied.scoreProvenance, 'page-parsed');
  const bodiedAgg = setScoreSourcePreservingProvenance({ ...guardianStub(), scoreSource: 'show-score-stars', fullText: 'x'.repeat(500) }, 'anchored-v6');
  assert.equal(bodiedAgg.scoreProvenance, undefined);
  const stamped = setScoreSourcePreservingProvenance({ ...guardianStub(), scoreProvenance: 'aggregator-inherited' }, 'anchored-v6');
  assert.equal(stamped.scoreProvenance, 'aggregator-inherited');
  assert.equal(setScoreSourcePreservingProvenance(null, 'x'), null);
});

// BRO-6053: no writer may overwrite scoreSource with an LLM method label directly; the helper
// stamps scoreProvenance first. Scans the real sources (baseline zero).
test('no script assigns an LLM method label to scoreSource outside the provenance helper', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../scripts');
  const bare = /\bscoreSource\s*=\s*['"`](llm-v\d+|anchored-v\d+|manual-cleared-haiku-fallback)['"`]/;
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(js|mjs|ts)$/.test(e.name) || /\.test\./.test(e.name)) continue;
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (bare.test(line) && !/^\s*(\/\/|\*)/.test(line) && !/console\./.test(line)) hits.push(`${path.relative(root, p)}:${i + 1}`);
      });
    }
  };
  walk(root);
  assert.deepEqual(hits, [], 'use setScoreSourcePreservingProvenance(data, label): ' + hits.join(', '));
});

test('stale-verdict parking stamps page-parsed provenance before the label is parked', () => {
  const { parkTextDerivedScore } = require('../../scripts/lib/stale-automated-text-verdict.js');
  const d = { ...guardianStub(), scoreSource: 'anchored-v6', assignedScore: 56, bucket: 'Mixed', originalScoreNormalized: 60 };
  d.originalScoreSource = 'json-ld';
  const parked = parkTextDerivedScore(d, '2026-10-24T00:00:00.000Z');
  assert.ok(parked);
  assert.equal(d.scoreSource, 'explicit-after-stale-verdict-clear');
  assert.equal(d.scoreProvenance, 'page-parsed');
});
