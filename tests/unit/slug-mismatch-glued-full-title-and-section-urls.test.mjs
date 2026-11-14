/**
 * BRO-7223: false positives in the slug-mismatch lifetime sweep.
 * Run: node --test tests/unit/slug-mismatch-glued-full-title-and-section-urls.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { run, buildAcceptSlugs } = require('../../scripts/lib/opening-night-checks/slug-mismatch.check.js');

const runUrl = (show, outletId, url) =>
  run(show, { reviewsDoc: { [show.id]: [{ outletId, criticName: 'A Critic', url }] } });

describe('slug-mismatch: whole title glued with short words', () => {
  const show = { id: 'building-the-wall-off-broadway-2017', title: 'Building the Wall' };
  it('accepts buildingthewall', () => {
    assert.ok(buildAcceptSlugs(show).includes('buildingthewall'));
    assert.strictEqual(runUrl(show, 'curtainup', 'https://www.curtainup.com/buildingthewall17.html').severity, 'ok');
  });
  it('still errors on another show', () => {
    assert.notStrictEqual(runUrl(show, 'curtainup', 'https://www.curtainup.com/hamilton17.html').severity, 'ok');
  });
});

describe('slug-mismatch: Times section-folder + numeric id URL', () => {
  const show = { id: 'frankenstein-west-end-2011', title: 'Frankenstein' };
  it('is opaque, not a mismatch', () => {
    assert.strictEqual(runUrl(show, 'times-uk', 'http://www.thetimes.co.uk/tto/arts/stage/theatre/article2924370.ece').severity, 'ok');
  });
  it('still errors on a slugged Times URL for another show', () => {
    assert.notStrictEqual(runUrl(show, 'times-uk', 'http://www.thetimes.co.uk/tto/arts/stage/theatre/hamilton-review.ece').severity, 'ok');
  });
});
