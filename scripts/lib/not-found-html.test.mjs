// BRO-7147: a 200 "Page not found" template from an unlocker must count as a
// failed fetch so the archive.org copy is read (Stoker Wilde, susanelkin.co.uk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isNotFoundHtml } = require('./soft-404-body.js');
const { fetchWithArchiveFallback } = require('./fetch-archive-fallback.js');

const chrome = '<nav>Home Reviews Contact</nav>'.repeat(40);
const notFound = `<html><head><title>Page not found - Susan Elkin</title></head><body>${chrome}<h1>Oops! That page can&rsquo;t be found.</h1></body></html>`;
const review = `<html><head><title>Stoker Wilde review - Susan Elkin</title></head><body>${chrome}<article>${'A fine evening. '.repeat(80)}</article></body></html>`;

test('not-found templates are recognised by a whole title segment only', () => {
  assert.equal(isNotFoundHtml(notFound), true);
  assert.equal(isNotFoundHtml('<title>404 | Site</title>'), true);
  assert.equal(isNotFoundHtml('<title>Oops! That page can&#8217;t be found. &#8211; Blog</title>'), true);
  assert.equal(isNotFoundHtml('<title>Page Not Found | The Stage</title>'), true);
  assert.equal(isNotFoundHtml(review), false);
  assert.equal(isNotFoundHtml('<title>Review: 404 at the Bush Theatre - Site</title>'), false);
  assert.equal(isNotFoundHtml('<title>Not Found - Theatre Review</title>'), false);
  assert.equal(isNotFoundHtml('no title here'), false);
});

test('a live not-found template falls through to the archive copy', async () => {
  const calls = [];
  const fetchPageFn = async (u) => { calls.push(u); return { content: u.includes('web.archive.org') ? review : notFound, source: 'brightdata' }; };
  const fetchJson = async () => [['timestamp'], ['20261029051941']];
  const got = await fetchWithArchiveFallback('https://susanelkin.co.uk/stoker-wilde/', { fetchPageFn, fetchJson });
  assert.equal(got.via, 'archive');
  assert.equal(got.snapshot, '20261029051941');
  assert.equal(calls.length, 2);
});

test('an archive copy that is itself a not-found template is refused', async () => {
  const got = await fetchWithArchiveFallback('https://susanelkin.co.uk/x/', {
    fetchPageFn: async () => ({ content: notFound }), fetchJson: async () => [['timestamp'], ['20261029051941']] });
  assert.equal(got.html, null);
  assert.match(got.error, /not-found template/);
});

test('a real live page is used as-is with no archive lookup', async () => {
  let cdx = 0;
  const got = await fetchWithArchiveFallback('https://susanelkin.co.uk/stoker-wilde/', {
    fetchPageFn: async () => ({ content: review }), fetchJson: async () => { cdx += 1; return null; } });
  assert.equal(got.via, 'live');
  assert.equal(cdx, 0);
});
