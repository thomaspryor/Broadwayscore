// BRO-7131: the same-url teaser upgrade skips the lede/shingle proof, so it must
// only take a COMPLETE body. A same-url consent/paywall page must not replace a
// stored teaser on length alone. Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');

const show = 'example-show-2026';
const url = 'https://bachtrack.com/review-example-show-london-2026';
const teaser = 'A new staging of a rarely performed work returns with a different soprano in the demanding title role this autumn.';
const sentence = (i) => `The singers move across a bare stage while the orchestra plays with real urgency and the chorus fills the hall with sound number ${i}.`;

function run(incoming) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teaser-'));
  fs.mkdirSync(path.join(dir, show));
  const file = path.join(dir, show, 'bachtrack--jane-critic.json');
  fs.writeFileSync(file, JSON.stringify({ showId: show, outletId: 'bachtrack', outlet: 'Bachtrack', criticName: 'Jane Critic', url, fullText: teaser, contentTier: 'stub' }));
  createOrMergeReviewFile(show, { outletId: 'bachtrack', outlet: 'Bachtrack', criticName: 'Jane Critic', url, source: 'ingest-urls', replaceBadBody: true, fields: { fullText: incoming } }, { reviewTextsDir: dir, knownShowIds: [show] });
  return JSON.parse(fs.readFileSync(file, 'utf8')).fullText;
}

test('a same-url body that is still incomplete does not replace a stored teaser', () => {
  // 4x+ the words and a better tier than the stored stub, but only "truncated": the teaser rule needs complete.
  assert.equal(run(Array.from({ length: 12 }, (_, i) => sentence(i)).join(' ')), teaser);
});

test('a same-url complete body replaces a stored teaser', () => {
  const body = Array.from({ length: 40 }, (_, i) => sentence(i)).join(' ');
  assert.equal(run(body), body);
});
