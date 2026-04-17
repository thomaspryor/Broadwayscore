import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const check = require('../../scripts/lib/opening-night-checks/unparsed-explicit-ratings.check.js');

function makeContext(reviews) {
  return { reviewsDoc: { 'test-2026': reviews }, reviewTextsRoot: '/tmp', driftState: {}, criticConsensusDoc: {}, now: new Date() };
}

describe('unparsed-explicit-ratings check', () => {
  it('Guardian (correct outletId "guardian") with null originalRating → warning with fix command', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'guardian', originalRating: null, url: 'https://guardian.com/review' }
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
    assert.match(result.message, /guardian/);
    assert.match(result.message, /recover-explicit-ratings/);
  });

  it('Guardian with parsed originalRating "4/5 stars" → ok', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'guardian', originalRating: '4/5 stars', url: 'https://guardian.com/review' }
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, true);
    assert.equal(result.severity, 'ok');
  });

  it('outlet not in RATING_SCHEMA_OUTLETS with null originalRating → ok (not our concern)', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'some-blog', originalRating: null, url: 'https://blog.com/review' }
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, true);
    assert.equal(result.severity, 'ok');
  });

  it('multiple outlets missing (correct IDs: guardian, nypost) → multiple warnings', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'guardian', originalRating: null, url: 'https://guardian.com/review' },
      { outletId: 'nypost', originalRating: null, url: 'https://nypost.com/review' },
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
    assert.match(result.message, /guardian/);
    assert.match(result.message, /nypost/);
    assert.equal(result.details.missing.length, 2);
  });

  it('wrongProduction review skipped even if originalRating is null', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'guardian', originalRating: null, wrongProduction: true, url: 'https://guardian.com/review' }
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, true);
  });

  it('RATING_SCHEMA_OUTLETS keys match real reviews.json outletId values', () => {
    // Regression guard: ensure outlet IDs haven't drifted back to wrong names
    const outlets = check.RATING_SCHEMA_OUTLETS;
    assert.ok('guardian' in outlets, 'should use "guardian" not "the-guardian"');
    assert.ok('nypost' in outlets, 'should use "nypost" not "ny-post"');
    assert.ok('telegraph' in outlets, 'should use "telegraph" not "the-telegraph"');
    assert.ok('timeout' in outlets, 'should use "timeout" not "time-out"');
    assert.ok('times-uk' in outlets, 'should use "times-uk" not "the-times"');
    assert.ok('standard' in outlets, 'should use "standard" not "evening-standard"');
    // Verify the wrong names are NOT present
    assert.ok(!('the-guardian' in outlets), '"the-guardian" is wrong outletId');
    assert.ok(!('ny-post' in outlets), '"ny-post" is wrong outletId');
  });
});
