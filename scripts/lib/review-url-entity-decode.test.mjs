import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decodeUrlEntities, sanitizeReviewRecord } = require('./review-url-entity-decode.js');
const { safeWriteReview } = require('./review-write-guard.js');
const { urlCanonicallyChanged } = require('./url-change-invariant.js');

const ESC = 'https://www.variety.com/review/VE1117941667.html?categoryid=33&amp;cs=1&amp;ref=ssp';
const RAW = 'https://www.variety.com/review/VE1117941667.html?categoryid=33&cs=1&ref=ssp';

test('decodes &amp;, numeric and double-escaped forms; leaves others alone', () => {
  assert.equal(decodeUrlEntities(ESC), RAW);
  assert.equal(decodeUrlEntities('http://a.com/?x=1&#38;y=2&#x26;z=3'), 'http://a.com/?x=1&y=2&z=3');
  assert.equal(decodeUrlEntities('http://a.com/?x=1&amp;amp;y=2'), 'http://a.com/?x=1&y=2');
  assert.equal(decodeUrlEntities('http://a.com/?q=&lt;b'), 'http://a.com/?q=&lt;b');
  assert.equal(decodeUrlEntities(undefined), undefined);
});

test('sanitizeReviewRecord strips leading <img> and returns same object when clean', () => {
  const clean = { url: RAW, fullText: 'Hello' };
  assert.equal(sanitizeReviewRecord(clean), clean);
  const d = sanitizeReviewRecord({ url: ESC, fullText: '<img src="a.jpg" alt="5 > 3"> Body text' });
  assert.equal(d.url, RAW);
  assert.equal(d.fullText, 'Body text');
  assert.equal(sanitizeReviewRecord({ fullText: 'Prose with <img> inside' }).fullText, 'Prose with <img> inside');
});

test('entity-decoded url is the SAME url for the url-change invariant', () => {
  assert.equal(urlCanonicallyChanged(ESC, RAW), false);
});

test('safeWriteReview decodes at the chokepoint and keeps verdict fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4403-'));
  const sd = path.join(dir, 'fela-2009'); fs.mkdirSync(sd);
  const f = path.join(sd, 'variety--unknown.json');
  const rec = { showId: 'fela-2009', outlet: 'Variety', url: ESC, fullText: '<img src="x.jpg"> Review body long enough.', contentTier: 'excerpt', llmScore: { score: 70 } };
  fs.writeFileSync(f, JSON.stringify(rec));
  const r = safeWriteReview(f, { ...rec });
  assert.ok(r.wrote);
  const out = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(out.url, RAW);
  assert.ok(!out.fullText.startsWith('<img'));
  assert.deepEqual(out.llmScore, { score: 70 });
  assert.ok(!out._urlChangedClear);
});
