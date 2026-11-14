import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { archiveSnapshotFetchUrl } = createRequire(import.meta.url)('./archive-snapshot-url.js');

test('builds the id_ snapshot url from an https page and a 14-digit timestamp', () => {
  assert.equal(archiveSnapshotFetchUrl('https://bachtrack.com/review-x', '20260409195415'),
    'https://web.archive.org/web/20260409195415id_/https://bachtrack.com/review-x');
});
test('refuses anything that is not a pinned snapshot (no capture requests)', () => {
  assert.equal(archiveSnapshotFetchUrl('https://bachtrack.com/review-x', ''), null);
  assert.equal(archiveSnapshotFetchUrl('https://bachtrack.com/review-x', '2026'), null);
  assert.equal(archiveSnapshotFetchUrl('https://bachtrack.com/review-x', 'save'), null);
  assert.equal(archiveSnapshotFetchUrl('javascript:alert(1)', '20260409195415'), null);
  assert.equal(archiveSnapshotFetchUrl('not a url', '20260409195415'), null);
});

test('verifyFetchedUrl checks an archived page against the original url', () => {
  const s = createRequire(import.meta.url)('./scraper.js');
  const orig = 'https://bachtrack.com/review-x';
  const html = `<html><head><title>x</title><link rel="canonical" href="${orig}"/></head><body>${'a'.repeat(600)}</body></html>`;
  const snap = `https://web.archive.org/web/20260409195415id_/${orig}`;
  assert.equal(s.verifyFetchedUrl(html, snap).verified, true);
  assert.equal(s.verifyFetchedUrl(html.replace(orig, 'https://bachtrack.com/other'), snap).verified, false);
});
