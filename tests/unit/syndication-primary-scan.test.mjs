/**
 * BRO-5352: the "is there a live primary file for this critic in the show dir"
 * scan lives once, in syndication-pairs.js hasLiveSyndicationPrimary. Four
 * copies had drifted across review-guards, rebuild-all-reviews and t1-silent-gap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { hasLiveSyndicationPrimary, isPrimaryFileFor } = require('../../scripts/lib/syndication-pairs.js');
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

function withDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synd-scan-'));
  try {
    for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), typeof body === 'string' ? body : JSON.stringify(body));
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PRIMARIES = ['chicago-tribune'];
const CRITIC = 'Chris Jones';

test('live primary file is found; flagged, unparseable, or other-critic files are not', () => {
  withDir({ 'chicago-tribune--chris-jones.json': { wrongShow: false } }, (d) => assert.equal(hasLiveSyndicationPrimary(d, PRIMARIES, CRITIC), true));
  withDir({ 'chicago-tribune--chris-jones.json': { wrongProduction: true } }, (d) => assert.equal(hasLiveSyndicationPrimary(d, PRIMARIES, CRITIC), false));
  withDir({ 'chicago-tribune--chris-jones.json': '{ nope' }, (d) => assert.equal(hasLiveSyndicationPrimary(d, PRIMARIES, CRITIC), false));
  withDir({ 'chicago-tribune--chris-jones-smith.json': {} }, (d) => assert.equal(hasLiveSyndicationPrimary(d, PRIMARIES, CRITIC), false));
});

test('extraCheck narrows, fileNames reuses a caller listing, unreadable dir throws', () => {
  withDir({ 'chicago-tribune--chris-jones.json': { score: 0 } }, (d) => {
    assert.equal(hasLiveSyndicationPrimary(d, PRIMARIES, CRITIC, { extraCheck: (p) => p.score > 0 }), false);
    assert.equal(hasLiveSyndicationPrimary(d, PRIMARIES, CRITIC, { fileNames: [] }), false);
    assert.equal(hasLiveSyndicationPrimary(d, PRIMARIES, CRITIC, { fileNames: ['chicago-tribune--chris-jones.json'] }), true);
  });
  assert.throws(() => hasLiveSyndicationPrimary('/nonexistent-dir-bro5352', PRIMARIES, CRITIC));
  assert.equal(isPrimaryFileFor('chicago-tribune--chris-jones-2.json', PRIMARIES, CRITIC), true);
});

test('no inline copy of the sibling-primary scan remains outside syndication-pairs.js', () => {
  for (const f of ['scripts/lib/review-guards.js', 'scripts/rebuild-all-reviews.js', 'scripts/lib/t1-silent-gap.js']) {
    const src = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.doesNotMatch(src, /isPrimaryFileFor\(/, `${f} must use hasLiveSyndicationPrimary`);
    assert.doesNotMatch(src, /isLiveSyndicationPrimary\(/, `${f} must use hasLiveSyndicationPrimary`);
  }
});
