import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { unwrapWaybackUrl } = createRequire(import.meta.url)('./unwrap-wayback-url.js');

test('snapshot url unwraps to the original article url', () => {
  const snap = 'http://web.archive.org/web/20130411215232/http://www.telegraph.co.uk/culture/a.html';
  assert.deepEqual(unwrapWaybackUrl(snap), { fetchUrl: snap, url: 'http://www.telegraph.co.uk/culture/a.html' });
});
test('id_ flavored snapshot unwraps', () => {
  const snap = 'https://web.archive.org/web/20130810225614id_/https://www.independent.co.uk/x-8563017.html';
  assert.equal(unwrapWaybackUrl(snap).url, 'https://www.independent.co.uk/x-8563017.html');
});
test('plain urls pass through unchanged', () => {
  const u = 'https://www.standard.co.uk/a.html';
  assert.deepEqual(unwrapWaybackUrl(u), { fetchUrl: u, url: u });
});
