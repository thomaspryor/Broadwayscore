import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findAffiliationFlags } = require('../../scripts/lib/critic-affiliations');

const row = (showId, outlet, extra = {}) => ({ showId, outlet, file: `${outlet}--critic.json`, ...extra });

test('known false affiliations are flagged even for a freelancer with fetched text', () => {
  const critics = {
    'david-rooney': {
      displayName: 'David Rooney',
      isFreelancer: true,
      knownOutlets: ['variety', 'hollywood-reporter', 'theatermania'],
      reviews: [row('9-to-5-2009', 'theatermania', { verified: true })],
    },
  };
  const before = structuredClone(critics);
  const flags = findAffiliationFlags(critics);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].criticSlug, 'david-rooney');
  assert.equal(flags[0].outlet, 'theatermania');
  assert.equal(flags[0].showId, '9-to-5-2009');
  assert.match(flags[0].reason, /Verify the article byline/);
  assert.deepEqual(critics, before, 'an advisory audit must not mutate records');
});

test('a single unverified false pair is flagged without a frequency threshold', () => {
  const flags = findAffiliationFlags({ 'david-rooney': {
    displayName: 'David Rooney', reviews: [row('s-2009', 'theatermania', { verified: false })],
  } });
  assert.equal(flags.length, 1);
});

test('legitimate bylines, other outlets, unnamed critics and non-reviews stay unchanged', () => {
  assert.deepEqual(findAffiliationFlags({
    'david-rooney': { displayName: 'David Rooney', reviews: [
      row('s-2009', 'variety'), row('s-2012', 'hollywood-reporter'),
      row('s-2009', 'theatermania', { nonReview: true }),
    ] },
    'david-finkle': { displayName: 'David Finkle', reviews: [row('evita-2012', 'theatermania')] },
    'andy-propst': { displayName: 'Andy Propst', reviews: [row('9-to-5-2009', 'theatermania')] },
    'brian-scott-lipton': { displayName: 'Brian Scott Lipton', reviews: [row('burn-the-floor-2009', 'theatermania')] },
    unknown: { displayName: 'Unknown', reviews: [row('s-2009', 'theatermania')] },
  }), []);
  assert.deepEqual(findAffiliationFlags({}), []);
});
