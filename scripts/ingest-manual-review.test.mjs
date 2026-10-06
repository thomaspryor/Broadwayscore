import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assertIncomingBodyWritten, writeManualReview } = require('./lib/manual-review-url-reset');
const root = path.resolve(import.meta.dirname, '..');

function ingest({ corrupt = false, sameBody = false } = {}) {
  const dir = fs.mkdtempSync(path.join(root, '.tmp-bro3151-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.mkdirSync(path.join(dir, 'data', 'review-texts', 'fixture-2026'), { recursive: true });
    fs.symlinkSync(path.join(root, 'scripts', 'lib'), path.join(dir, 'scripts', 'lib'));
    fs.copyFileSync(path.join(root, 'scripts', 'ingest-manual-review.js'), path.join(dir, 'scripts', 'ingest-manual-review.js'));
    fs.writeFileSync(path.join(dir, 'data', 'shows.json'), JSON.stringify({ shows: [{ id: 'fixture-2026', title: 'Fixture', openingDate: '2026-09-10' }] }));
    const body = 'Fixture review text with a non-empty incoming body. '.repeat(70);
    const file = path.join(dir, 'data', 'review-texts', 'fixture-2026', 'guardian--unknown.json');
    fs.writeFileSync(file, JSON.stringify({ showId: 'fixture-2026', outletId: 'guardian', criticName: 'Unknown', url: 'https://www.theguardian.com/stage/old-review', fullText: sameBody ? body : '', contentTier: 'invalid', excludeFromScoring: true, rejectedAt: '2026-09-01', needsRefetch: true }));
    const preload = path.join(dir, 'preload.cjs');
    fs.writeFileSync(preload, `const fs = require('fs');
const writer = require(${JSON.stringify(path.join(root, 'scripts/lib/review-file-writer.js'))});
const original = writer.createOrMergeReviewFile;
writer.createOrMergeReviewFile = (show, input, options) => {
  const result = original(show, input, { ...options, reviewTextsDir: ${JSON.stringify(path.join(dir, 'data/review-texts'))} });
  if (${corrupt} && result.filepath) {
    const data = JSON.parse(fs.readFileSync(result.filepath));
    data.fullText = '';
    fs.writeFileSync(result.filepath, JSON.stringify(data));
  }
  return result;
};`);
    const result = spawnSync(process.execPath, ['--require', preload, path.join(dir, 'scripts/ingest-manual-review.js'), '--show=fixture-2026', '--outlet=guardian', '--critic=Unknown', '--url=https://www.theguardian.com/stage/new-review', '--text=' + body, '--no-rebuild', '--no-auto-extract'], { encoding: 'utf8' });
    return { ...result, data: JSON.parse(fs.readFileSync(file)), body };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

for (const sameBody of [false, true]) {
  test(`URL change preserves body and clears stale state (same body: ${sameBody})`, () => {
    const r = ingest({ sameBody });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.data.fullText, r.body);
    for (const key of ['excludeFromScoring', 'rejectedAt', 'needsRefetch']) {
      assert.ok(!r.data[key], `${key} survived URL change`);
      assert.ok(r.data._urlChangedClear.cleared.includes(key));
    }
  });
}
test('post-write body loss exits non-zero even when old body was valid', () => {
  const r = ingest({ corrupt: true, sameBody: true });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /incoming body.*empty fullText/i);
});

test('body assertion uses the production function', () => {
  assert.throws(() => assertIncomingBodyWritten('body', { fullText: '' }), /empty fullText/);
  assert.doesNotThrow(() => assertIncomingBodyWritten(null, { fullText: '' }));
});

test('refused merge restores the previous file', () => {
  const dir = fs.mkdtempSync(path.join(root, '.tmp-bro3151-'));
  const file = path.join(dir, 'review.json');
  const snapshot = JSON.stringify({ url: 'https://example.com/old', fullText: 'old body' });
  fs.writeFileSync(file, snapshot);
  try {
    assert.throws(() => writeManualReview({ preExisting: { path: file },
      url: 'https://example.com/new', incomingBody: 'new body',
      write: () => ({ action: 'skipped', reason: 'fixture-refusal' }),
    }), /fixture-refusal/);
    assert.equal(fs.readFileSync(file, 'utf8'), snapshot);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
