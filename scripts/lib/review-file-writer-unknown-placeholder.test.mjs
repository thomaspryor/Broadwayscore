// BRO-7569: an Unknown-critic, no-url placeholder (NYC Theatre roundup excerpt) must not be
// created beside a usable named review by the same outlet; it stays creatable when none exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');
const show = 'example-show-2026';

function setup(named) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unk-ph-'));
  fs.mkdirSync(path.join(dir, show));
  if (named) fs.writeFileSync(path.join(dir, show, 'nytimes--jesse-green.json'), JSON.stringify({ showId: show, outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Jesse Green', url: 'https://www.nytimes.com/2026/03/01/theater/example-show-review.html', fullText: 'x'.repeat(2500), contentTier: 'complete', ...named }));
  return dir;
}
const write = (dir) => createOrMergeReviewFile(show, { outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Unknown', url: '', source: 'nyc-theatre', fields: { nycTheatreExcerpt: 'A long enough excerpt of the review text for the roundup to carry.' } }, { reviewTextsDir: dir, knownShowIds: [show] });

test('skips the placeholder when the outlet already has a named review with a url', () => {
  const dir = setup({});
  const r = write(dir);
  assert.equal(r.action, 'skipped');
  assert.match(r.reason, /outlet-already-covered/);
  assert.equal(fs.existsSync(path.join(dir, show, 'nytimes--unknown.json')), false);
});

test('does not count a flagged or url-less sibling as coverage', () => {
  for (const flag of [{ wrongShow: true }, { duplicateOf: 'x' }, { url: null }]) {
    const dir = setup(flag);
    const r = write(dir);
    assert.doesNotMatch(String(r.reason || ''), /outlet-already-covered/, JSON.stringify(flag));
  }
});

test('creates the placeholder when the outlet has no other file', () => {
  const dir = setup(null);
  const r = write(dir);
  assert.doesNotMatch(String(r.reason || ''), /outlet-already-covered/);
});
