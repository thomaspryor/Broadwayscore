// BRO-6212: the number beside the Critics' Take is the show's real review count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { consensusDisplayCount } = require('../../scripts/lib/consensus-display-count.js');
const { computeSlimCriticScore } = require('../../scripts/lib/slim-critic-score.js');
const fs = require('node:fs');
const path = require('node:path');

test('score count wins over the stored generation-time count', () => {
  assert.equal(consensusDisplayCount({ rc: 23 }, 27), 23);
});

test('no score (hidden / announced) keeps the stored count; nothing at all is 0', () => {
  assert.equal(consensusDisplayCount(null, 27), 27);
  assert.equal(consensusDisplayCount(undefined, undefined), 0);
  assert.equal(consensusDisplayCount({ rc: 0 }, 5), 5);
});

// Real data: for every show with a take and a score, the displayed count equals the published rc.
test('real data: displayed count equals the slim score count for Benjamin Button (both runs)', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const shows = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf8'));
  const list = Array.isArray(shows) ? shows : shows.shows;
  const reviews = JSON.parse(fs.readFileSync(path.join(root, 'data', 'reviews.json'), 'utf8')).reviews;
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'data', 'outlet-registry.json'), 'utf8'));
  const consensus = JSON.parse(fs.readFileSync(path.join(root, 'data', 'critic-consensus.json'), 'utf8')).shows;
  for (const id of ['the-curious-case-of-benjamin-button-off-broadway-2026', 'the-curious-case-of-benjamin-button-west-end-2024']) {
    const show = list.find((s) => s.id === id);
    const r = computeSlimCriticScore(show, reviews.filter((x) => x.showId === id), registry);
    assert.ok(r.scoreResult, id);
    assert.equal(consensusDisplayCount(r.scoreResult, consensus[id].reviewCount), r.scoreResult.rc, id);
  }
});
