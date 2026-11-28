import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pdfUrlVariants, nonPdfHead } = require('./tr-pdf-url.js');

test('a plain dest link is tried as given, then by bare issue number', () => {
  assert.deepEqual(pdfUrlVariants('https://www.theatrerecord.com/archive/volume/41/dest/14_joseph_and_the_amazing_techn#page=3'), [
    'https://www.theatrerecord.com/archive/volume/41/dest/14_joseph_and_the_amazing_techn',
    'https://www.theatrerecord.com/archive/volume/41/dest/14',
  ]);
});

test('the 2:22 link (colon in the slug) also gets a percent-encoded variant', () => {
  assert.deepEqual(pdfUrlVariants('https://www.theatrerecord.com/archive/volume/41/dest/15:2_22___a_ghost_story'), [
    'https://www.theatrerecord.com/archive/volume/41/dest/15:2_22___a_ghost_story',
    'https://www.theatrerecord.com/archive/volume/41/dest/15%3A2_22___a_ghost_story',
    'https://www.theatrerecord.com/archive/volume/41/dest/15',
  ]);
});

test('page and issue links have no variants', () => {
  assert.deepEqual(pdfUrlVariants('https://www.theatrerecord.com/archive/volume/38/page/533'), ['https://www.theatrerecord.com/archive/volume/38/page/533']);
});

test('nonPdfHead strips markup and caps length', () => {
  assert.equal(nonPdfHead('<html><title>Not found</title>\n<body>Sorry</body>'), 'Not found Sorry');
  assert.equal(nonPdfHead('x'.repeat(500)).length, 120);
});
