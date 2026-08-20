// BRO-219: dtli-count-mismatch.check.js had zero test coverage anywhere — its
// structural twin bww-rr-count-mismatch.check.js has both a no-network branch
// test file and a missingReviews-contract test in
// scripts/opening-night-checklist.test.mjs, dtli had neither. Same reason
// bww-rr's suite stays offline: run() fetches over the network for the
// slug-resolved path, which unit tests must not do. These two branches
// (non-Broadway/OB category, and no slug in data/dtli-slug-map.json) both
// return before any fetchPage call, so they're safe to exercise directly.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('dtli-count-mismatch check (no-network branches)', () => {
  it('west-end category short-circuits without touching the DTLI slug map or network', () => {
    const check = require('../../scripts/lib/opening-night-checks/dtli-count-mismatch.check.js');
    const show = { id: 'test-we-2026', title: 'Test WE', category: 'west-end', openingDate: '2026-04-15' };
    const context = { reviewsDoc: {}, reviewTextsRoot: '/tmp', driftState: {}, criticConsensusDoc: {}, now: new Date() };
    return check.run(show, context).then(result => {
      assert.equal(result.ok, true);
      assert.equal(result.severity, 'ok');
      assert.match(result.message, /DTLI not applicable/);
    });
  });

  it('no category defaults to broadway (in scope), not skipped', () => {
    const check = require('../../scripts/lib/opening-night-checks/dtli-count-mismatch.check.js');
    // No dtli-slug-map.json entry for this fixture id -> returns before fetchPage.
    const show = { id: 'bro-219-dtli-fixture-no-category-2099', title: 'No Category Fixture' };
    const context = { reviewsDoc: {}, reviewTextsRoot: '/tmp', driftState: {}, criticConsensusDoc: {}, now: new Date() };
    return check.run(show, context).then(result => {
      assert.equal(result.ok, true);
      assert.doesNotMatch(result.message, /DTLI not applicable/, 'a show with no category must be treated as broadway, not skipped');
    });
  });

  it('no DTLI slug for the show yet — warns and skips without a network call', () => {
    const check = require('../../scripts/lib/opening-night-checks/dtli-count-mismatch.check.js');
    const show = { id: 'bro-219-dtli-fixture-unmapped-2099', title: 'Unmapped Fixture', category: 'broadway' };
    const context = { reviewsDoc: {}, reviewTextsRoot: '/tmp', driftState: {}, criticConsensusDoc: {}, now: new Date() };
    return check.run(show, context).then(result => {
      assert.equal(result.ok, true);
      assert.equal(result.severity, 'warning');
      assert.match(result.message, /No DTLI slug/);
    });
  });

  it('off-broadway category is in DTLI scope (not skipped)', () => {
    const check = require('../../scripts/lib/opening-night-checks/dtli-count-mismatch.check.js');
    const show = { id: 'bro-219-dtli-fixture-ob-2099', title: 'OB Fixture', category: 'off-broadway' };
    const context = { reviewsDoc: {}, reviewTextsRoot: '/tmp', driftState: {}, criticConsensusDoc: {}, now: new Date() };
    return check.run(show, context).then(result => {
      assert.equal(result.ok, true);
      assert.doesNotMatch(result.message, /DTLI not applicable/);
    });
  });
});
