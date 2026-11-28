// BRO-7798: replay-pending-bylines' byline pick. The meta reader (article:author) is a fallback only
// when no outlet rule answered "this page names nobody": on TheaterMania the meta tag is the editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readPageBylineWithMetaFallback } = require('../../scripts/lib/page-byline-for-show.js');

const body = '<article><p>' + 'The show is back on stage. '.repeat(30) + '</p></article>';
const page = (head) => `<html><head>${head}</head><body>${body}</body></html>`;

test('TheaterMania page with only the editor in article:author: no byline', () => {
  const html = page('<meta property="article:author" content="David Gordon">');
  assert.equal(readPageBylineWithMetaFallback({ html, url: 'https://www.theatermania.com/news/x_1/', outletId: 'theatermania' }), null);
});

test('outlet without a rule: article:author is still used as the fallback', () => {
  const html = page('<meta property="article:author" content="Jane Critic">');
  assert.equal(readPageBylineWithMetaFallback({ html, url: 'https://example-theatre-blog.com/review/', outletId: 'example-blog' }), 'Jane Critic');
});

test('no html: null, never throws', () => {
  assert.equal(readPageBylineWithMetaFallback({ html: '', url: 'https://x.com/', outletId: 'x' }), null);
});

// BRO-8255: "Michela Smith." (sentence-final period from prose) must not be stored as the critic name.
test('stripTrailingDot: strips a period after a name word, keeps initials and Jr./Sr.', () => {
  const { stripTrailingDot, readPageBylineForShow } = require('../../scripts/lib/page-byline-for-show.js');
  assert.equal(stripTrailingDot('Michela Smith.'), 'Michela Smith');
  assert.equal(stripTrailingDot('Michela Smith'), 'Michela Smith');
  assert.equal(stripTrailingDot('Jesse L. Green'), 'Jesse L. Green');
  assert.equal(stripTrailingDot('Ben Brantley J.'), 'Ben Brantley J.');
  assert.equal(stripTrailingDot('Robert Downey Jr.'), 'Robert Downey Jr.');
  assert.equal(stripTrailingDot('Tim Smith Sr.'), 'Tim Smith Sr.');
  assert.equal(stripTrailingDot("Peter O'Neill."), "Peter O'Neill");
  assert.equal(stripTrailingDot(null), null);
  // through the shared reader: a theater-pizzazz paragraph byline already stripped; the cased reader strips every path
  const res = readPageBylineForShow({ html: page('<meta name="author" content="Michela Smith.">'), url: 'https://example.com/x', outletId: 'artsfuse' });
  if (res.criticName) assert.doesNotMatch(res.criticName, /[a-z]\.$/);
});

// BRO-8255 class guard: the lowest reader strips too, so direct callers (ingest-urls, sweep-stored-bylines) cannot store "Name."
test('readPageByline itself strips a trailing period (direct callers bypass the show-aware wrapper)', () => {
  const { readPageByline, stripTrailingDot } = require('../../scripts/lib/page-byline.js');
  assert.equal(stripTrailingDot('Michela Smith.'), 'Michela Smith');
  assert.equal(stripTrailingDot('Robert Downey Jr.'), 'Robert Downey Jr.');
  const res = readPageByline({ html: page('<meta name="author" content="Michela Smith.">'), url: 'https://example.com/x', outletId: 'artsfuse' });
  if (res.criticName) assert.doesNotMatch(res.criticName, /[a-z]\.$/);
});
