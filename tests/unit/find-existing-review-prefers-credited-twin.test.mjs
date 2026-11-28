// BRO-7999: a URL held under two critics at one outlet (the wrongAttribution file and its
// correctly credited twin) matched whichever filename sorted first. 20 corpus pairs sorted the
// flagged file first (e.g. thewrap--benjamin-lindsay over thewrap--robert-hofler), so a
// re-ingest merged fresh text into the file the site excludes. The credited twin must win.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findExistingReviewFile } = require('../../scripts/lib/review-normalization');

const URL_ = 'https://www.thewrap.com/fixture-show-broadway-review/';
function dir(t, files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'credited-twin-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(d, name), JSON.stringify({ outletId: 'thewrap', ...data }));
  return d;
}

test('the credited twin wins over a wrongAttribution file that sorts first', (t) => {
  const d = dir(t, {
    'thewrap--a-wrong-critic.json': { criticName: 'A Wrong Critic', url: URL_, wrongAttribution: true },
    'thewrap--robert-hofler.json': { criticName: 'Robert Hofler', url: URL_ },
  });
  assert.equal(findExistingReviewFile(d, 'thewrap', 'Unknown', URL_).filename, 'thewrap--robert-hofler.json');
});

test('a credited www-folded twin still beats a flagged exact match', (t) => {
  const d = dir(t, {
    'thewrap--a-wrong-critic.json': { criticName: 'A Wrong Critic', url: URL_, wrongAttribution: true },
    'thewrap--robert-hofler.json': { criticName: 'Robert Hofler', url: URL_.replace('www.', '') },
  });
  assert.equal(findExistingReviewFile(d, 'thewrap', 'Unknown', URL_).filename, 'thewrap--robert-hofler.json');
});

test('a lone wrongAttribution file is still found (no duplicate file minted)', (t) => {
  const d = dir(t, { 'thewrap--a-wrong-critic.json': { criticName: 'A Wrong Critic', url: URL_, wrongAttribution: true } });
  assert.equal(findExistingReviewFile(d, 'thewrap', 'Unknown', URL_).filename, 'thewrap--a-wrong-critic.json');
});

test('two credited files keep the old first-match order', (t) => {
  const d = dir(t, {
    'thewrap--first-critic.json': { criticName: 'First Critic', url: URL_ },
    'thewrap--robert-hofler.json': { criticName: 'Robert Hofler', url: URL_ },
  });
  assert.equal(findExistingReviewFile(d, 'thewrap', 'Unknown', URL_).filename, 'thewrap--first-critic.json');
});
