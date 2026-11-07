import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const registry = require('../../data/outlet-registry.json');
const { buildOutletMaps } = require('./outlet-region-map.js');
const { buildRegisteredOutletIds, evaluateForwardCrossMarketGuard } = require('./cross-market-guard.js');
const maps = buildOutletMaps(registry);
const registeredOutletIds = buildRegisteredOutletIds(registry);
const verdictFor = (canonicalOutlet, rawOutlet = canonicalOutlet) => evaluateForwardCrossMarketGuard({
  outletRegionMap: maps.outletRegionMap,
  registeredOutletIds,
  internationalTradeOutlets: maps.internationalTradeOutlets,
  canonicalOutlet,
  rawOutlet,
  url: `https://${registry.outlets[canonicalOutlet].domain}/review`,
  reviewDate: '2026-09-02',
});

for (const id of ['hollywood-reporter', 'variety', 'deadline']) {
  test(`${id}: London coverage needs no URL, prior-run or content-verification exemption`, () => {
    assert.equal(registry.outlets[id].coversInternational, true);
    assert.equal(verdictFor(id).shouldFlag, false);
    for (const alias of registry.outlets[id].aliases) {
      assert.equal(verdictFor('nypost', alias.toLowerCase()).shouldFlag, false);
    }
  });
}

test('US papers without international trade coverage remain guarded', () => {
  assert.equal(verdictFor('nypost').shouldFlag, true);
  assert.equal(verdictFor('nytimes').shouldFlag, true);
});

test('coverage map only accepts explicit boolean true and lowercases aliases', () => {
  const { internationalTradeOutlets } = buildOutletMaps({ outlets: {
    trade: { coversInternational: true, aliases: ['TRADE Alias'] },
    newspaper: { coversInternational: false },
    malformed: { coversInternational: 'true' },
  } });
  assert.deepEqual([...internationalTradeOutlets].sort(), ['trade', 'trade alias']);
});

test('scoring-delta notices changes to international coverage in the registry', () => {
  const { compareOutletRegistry } = require('./scoring-delta-data-inputs.js');
  const report = compareOutletRegistry(
    { outlets: { trade: { tier: 1 } } },
    { outlets: { trade: { tier: 1, coversInternational: true } } },
    { trade: 3 },
  );
  assert.equal(report.significant, true);
  assert.equal(report.changes[0].fields[0].field, 'coversInternational');
});

// Exercise the real discovery writer, then the rebuild's forward decision.
// The writer does not itself run this guard; the rebuild used to invalidate
// legitimate files created here. Keep fixtures separate from real show files.
test('createReviewFile THR and Variety London fixtures survive the forward guard', () => {
  const { createReviewFile } = require('../gather-reviews.js');
  const showId = `__test-bro2749-west-end-${process.pid}-2026`;
  const showDir = path.resolve('data/review-texts', showId);
  try {
    for (const id of ['hollywood-reporter', 'variety']) {
      const created = createReviewFile(showId, {
        outletId: id,
        outlet: registry.outlets[id].displayName,
        criticName: 'Fixture Critic',
        url: `https://${registry.outlets[id].domain}/2026/reviews/bro2749-london-${process.pid}/`,
        publishDate: '2026-09-02',
        source: 'serp',
      }, { allowWestEnd: true });
      assert.equal(created, true);
      const written = JSON.parse(fs.readFileSync(path.join(showDir, `${id}--fixture-critic.json`), 'utf8'));
      assert.notEqual(written.wrongProduction, true);
      assert.equal(verdictFor(written.outletId).shouldFlag, false);
    }
  } finally {
    fs.rmSync(showDir, { recursive: true, force: true });
  }
});
