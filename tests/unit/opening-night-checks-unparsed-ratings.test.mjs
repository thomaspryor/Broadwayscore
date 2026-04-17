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
  it('Guardian with null originalScore → warning with fix command', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'the-guardian', originalRating: null, url: 'https://guardian.com/review' }
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
    assert.match(result.message, /the-guardian/);
    assert.match(result.message, /recover-explicit-ratings/);
  });

  it('Guardian with parsed originalScore (80) → ok', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'the-guardian', originalRating: '4/5 stars', url: 'https://guardian.com/review' }
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, true);
    assert.equal(result.severity, 'ok');
  });

  it('outlet not in RATING_SCHEMA_OUTLETS with null score → ok (not our concern)', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'some-blog', originalRating: null, url: 'https://blog.com/review' }
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, true);
    assert.equal(result.severity, 'ok');
  });

  it('multiple outlets missing → multiple warnings in message', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'the-guardian', originalRating: null, url: 'https://guardian.com/review' },
      { outletId: 'ny-post', originalRating: null, url: 'https://nypost.com/review' },
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
    assert.match(result.message, /the-guardian/);
    assert.match(result.message, /ny-post/);
    assert.equal(result.details.missing.length, 2);
  });

  it('wrongProduction review is skipped even if score is null', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'the-guardian', originalRating: null, wrongProduction: true, url: 'https://guardian.com/review' }
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, true);
  });
});
