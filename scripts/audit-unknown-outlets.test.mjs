import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { countResolvableUnknowns } = require('./audit-unknown-outlets.js');

function corpus(t, records) {
  const dir = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.unknown-outlets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const showDir = path.join(dir, 'show-2026');
  fs.mkdirSync(showDir);
  records.forEach((record, i) => {
    fs.writeFileSync(path.join(showDir, `${i}.json`), JSON.stringify(record));
  });
  return dir;
}

for (const [outletId, url] of [
  ['vocal', 'https://vocal.media/stories/a-review'],
  ['ticketline', 'https://www.ticketline.co.uk/show'],
  ['southbank', 'https://www.southbankcentre.co.uk/whats-on/show'],
  ['spincyclenyc', 'https://spincyclenyc.com/show'],
  ['playbill-listing', 'https://playbill.com/production/show'],
]) {
  test(`blocked review URL is not a resolvable unknown: ${outletId}`, (t) => {
    const dir = corpus(t, [{ outletId, url }]);
    assert.deepEqual(countResolvableUnknowns(dir, new Set()), {
      resolvableUnknowns: 0,
      totalFiles: 1,
      examples: [],
    });
  });
}

test('filters each record by URL while keeping legitimate reviews and file totals', (t) => {
  const dir = corpus(t, [
    { outletId: 'indieblog', url: 'https://vocal.media/stories/show' },
    { outletId: 'indieblog', url: 'https://indieblog.example/review' },
    { outletId: 'playbill', url: 'https://playbill.com/article/review-show' },
    { outletId: 'anotherblog', url: 'https://vocal.media.example/review' },
    { outletId: 'variety', url: 'https://variety.com/review' },
  ]);
  const result = countResolvableUnknowns(dir, new Set(['variety']));
  assert.equal(result.totalFiles, 5);
  assert.equal(result.resolvableUnknowns, 3);
  assert.deepEqual(result.examples, [
    { showDir: 'show-2026', file: '1.json', outletId: 'indieblog' },
    { showDir: 'show-2026', file: '2.json', outletId: 'playbill' },
    { showDir: 'show-2026', file: '3.json', outletId: 'anotherblog' },
  ]);
});

test('missing and malformed URLs do not hide otherwise resolvable outlets', (t) => {
  const dir = corpus(t, [
    { outletId: 'missingurl' },
    { outletId: 'malformedurl', url: 'not a URL' },
  ]);
  const result = countResolvableUnknowns(dir, new Set());
  assert.equal(result.totalFiles, 2);
  assert.equal(result.resolvableUnknowns, 2);
  assert.deepEqual(result.examples.map((example) => example.outletId), ['missingurl', 'malformedurl']);
});
