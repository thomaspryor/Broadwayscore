import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { buildArchiveData, isArchiveIdentityMismatch } = require('../../scripts/lib/stagedoor-identity.js');

const show = { id: 12, category: 'london', slug: 'hamilton', title: 'Hamilton', ourShowId: 'hamilton-london-2017' };

test('writer persists the scraped pageTitle alongside our own title', () => {
  const d = buildArchiveData({ show, reviews: [], pageTitle: '  Hamilton  ', today: '2026-10-13' });
  assert.equal(d.pageTitle, 'Hamilton');
  assert.equal(d.title, 'Hamilton');
  assert.equal(d.stagedoorUrl, '/london/12-hamilton/critic-reviews');
});

test('pageTitle absent (legacy archive) falls back to title + ourShowId checks', () => {
  const d = buildArchiveData({ show, reviews: [], pageTitle: null, today: '2026-10-13' });
  assert.equal(isArchiveIdentityMismatch(d, 'hamilton-london-2017', 'Hamilton'), false);
});

test('wrong Stagedoor page under the right showId is caught by pageTitle', () => {
  // title is our own (passes by construction); the scraped page is another show
  const d = buildArchiveData({ show, reviews: [], pageTitle: 'Six the Musical', today: '2026-10-13' });
  assert.equal(isArchiveIdentityMismatch(d, 'hamilton-london-2017', 'Hamilton'), true);
});

test('wrong ourShowId and missing title still fail', () => {
  const d = buildArchiveData({ show, reviews: [], pageTitle: 'Hamilton', today: '2026-10-13' });
  assert.equal(isArchiveIdentityMismatch(d, 'other-show', 'Hamilton'), true);
  assert.equal(isArchiveIdentityMismatch({ ...d, title: '' }, 'hamilton-london-2017', 'Hamilton'), true);
});
