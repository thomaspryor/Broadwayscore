import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isWellFormedReviewUrl, recoverEmbeddedUrl, classifyUrlField } = require('../../scripts/lib/malformed-review-url.js');
const { findMalformed, findShippedMalformed } = require('../../scripts/audit-malformed-review-urls.js');

test('rejects urls lacking a dotted host or absolute http(s) form', () => {
  for (const u of ['/people/Jesse-Green/', '../reviews/x.html', '/article/BWW-Review-X', 'https://So', 'https://The%20show%20is%20a%20triple-decker', 'ftp://a.com/x', 'https://a.com/x y']) {
    assert.equal(isWellFormedReviewUrl(u), false, u);
  }
  assert.equal(isWellFormedReviewUrl('https://www.nytimes.com/2024/a.html'), true);
});

test('recovers embedded urls from protocol-upgrade damage', () => {
  assert.equal(recoverEmbeddedUrl('https://%20http:/www.newsday.com/a-1.4431993'), 'http://www.newsday.com/a-1.4431993');
  assert.equal(recoverEmbeddedUrl('https://%C2%A0http://deadline.com/2018/04/x/'), 'http://deadline.com/2018/04/x/');
  assert.equal(recoverEmbeddedUrl('https://www.nytimes.com/a.html '), 'https://www.nytimes.com/a.html');
  assert.equal(recoverEmbeddedUrl('/people/Jesse-Green/'), null);
});

test('classifyUrlField accepts empty and flags text-as-url', () => {
  assert.deepEqual(classifyUrlField(''), { ok: true });
  assert.deepEqual(classifyUrlField(null), { ok: true });
  assert.equal(classifyUrlField('[https://So](<https://So>)%20what').ok, false);
});

test('audit finds malformed files and shipped rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5162-'));
  fs.mkdirSync(path.join(dir, 'show-1'));
  fs.writeFileSync(path.join(dir, 'show-1', 'a.json'), JSON.stringify({ url: '/people/X/' }));
  fs.writeFileSync(path.join(dir, 'show-1', 'b.json'), JSON.stringify({ url: 'https://a.com/x' }));
  const bad = findMalformed(dir);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].file, 'a.json');
  const shipped = findShippedMalformed({ reviews: [{ showId: 's', outletId: 'o', url: 'https://So' }, { showId: 's', outletId: 'o', url: 'https://a.com/x' }] });
  assert.equal(shipped.length, 1);
  fs.rmSync(dir, { recursive: true });
});

test('review-write-guard refuses to store text or a relative path as a url', () => {
  const { safeWriteReview } = require('../../scripts/lib/review-write-guard.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5162-guard-'));
  const base = { showId: 'some-show-2020', outletId: 'newsday', criticName: 'A B', fullText: 'x'.repeat(200) };
  const cases = [
    ['/people/Jesse-Green/', null],
    ['https://%20http:/www.newsday.com/a-1.4431993', 'http://www.newsday.com/a-1.4431993'],
    ['https://www.nytimes.com/a.html', 'https://www.nytimes.com/a.html'],
  ];
  cases.forEach(([url, want], i) => {
    const fp = path.join(dir, `case${i}.json`);
    safeWriteReview(fp, { ...base, url }, { force: true });
    assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).url, want, url);
  });
  // a damaged incoming url must not wipe or replace an existing good url
  const fp = path.join(dir, 'existing.json');
  safeWriteReview(fp, { ...base, url: 'https://www.newsday.com/a-1.4431993' }, { force: true });
  safeWriteReview(fp, { ...base, url: '/people/Steve-Parks/' });
  assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).url, 'https://www.newsday.com/a-1.4431993');
  fs.rmSync(dir, { recursive: true });
});
