// LIVE-DATA-LANE: reads data/links-featured.json (read by the test); data/shows.json (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// TESTS-VS-DERIVED-DATA-EXEMPT: Referential integrity only; the configured showId must resolve, without pinning show facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withBioUtm } = require('../../scripts/lib/links-featured.js');
const featured = JSON.parse(fs.readFileSync(new URL('../../data/links-featured.json', import.meta.url), 'utf8'));

test('the featured video points to a real show with a page slug', () => {
  const { shows } = JSON.parse(fs.readFileSync(new URL('../../data/shows.json', import.meta.url), 'utf8'));
  const show = shows.find((s) => s.id === featured.showId);
  assert.ok(show, `Unknown featured show: ${featured.showId}`);
  assert.ok(show.slug);
  assert.ok(featured.label.trim());
});

test('bio attribution reaches the featured show and both market buttons', () => {
  const search = '?utm_source=instagram&utm_medium=social&utm_campaign=video&utm_content=compare-benjamin-button';
  for (const href of ['/show/the-curious-case-of-benjamin-button-off-broadway', '/', '/west-end']) {
    assert.equal(withBioUtm(href, search), `${href}${search}`);
  }
});

test('only UTM parameters carry through, preserving encoded values and the destination query and hash', () => {
  assert.equal(
    withBioUtm('/show/example?mode=critics&utm_source=old#reviews', '?utm_source=tiktok&utm_campaign=video%20%26%20review&signin=1&next=https://example.com'),
    '/show/example?mode=critics&utm_source=tiktok&utm_campaign=video+%26+review#reviews',
  );
});

test('direct visitors keep clean links', () => {
  assert.equal(withBioUtm('/west-end', ''), '/west-end');
  assert.equal(withBioUtm('/', '?signin=1'), '/');
});
