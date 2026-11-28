// LIVE-DATA-LANE: reads data/outlet-registry.json (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
/**
 * BRO-2263: "Quality: outlet domain moves" fired for theatrereviews.design,
 * which name-matches the registered outlet theatre-reviews-limited. The host is
 * now registered (theatrereviews-design), so the detector must stay quiet for
 * it, and must still flag a genuinely unregistered host that name-matches an
 * outlet (so adding a domainAlias is what clears the alert).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findProbableDomainMoves } = require('../../scripts/lib/silent-exclusion-detectors.js');
const registry = require('../../data/outlet-registry.json');

test('theatrereviews.design is a registered host, not a probable domain move', () => {
  const moves = findProbableDomainMoves(registry.outlets, [{ host: 'theatrereviews.design' }]);
  assert.deepEqual(moves, []);
});

test('an alias on the outlet clears a name-matching unregistered host', () => {
  const outlets = {
    'example-review': { displayName: 'Example Review', domain: 'examplereview.com', aliases: ['example review'] },
  };
  const host = 'examplereview.substack.com';
  const before = findProbableDomainMoves(outlets, [{ host }]);
  const after = findProbableDomainMoves(
    { 'example-review': { ...outlets['example-review'], domainAliases: [host] } },
    [{ host }],
  );
  assert.equal(after.length, 0);
  assert.equal(before.length, 1);
});
