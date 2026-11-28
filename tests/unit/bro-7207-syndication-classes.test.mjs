// BRO-7207: same-critic outlet pairs that are one review shipped twice. Each class below is a reprint
// relationship syndication-pairs.js must know, so the rebuild shield drops the copy and the
// audit stops reporting it as unexplained. Requires the real functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getSyndicationPrimaries } = require('../../scripts/lib/syndication-pairs.js');
const { findSyndicatedCriticPairs, findUnexplainedSameCriticPairs } = require('../../scripts/audit-syndicated-critic-pairs.js');
const { pairs: allowlist } = require('../../scripts/config/same-critic-pairs-allowlist.json');

const CLASSES = [
  // [critic, secondary outlet, expected primary]
  ['Aleks Sierz', 'sierz-co-uk', 'artsdesk'],
  ['Aleks Sierz', 'sierz-co-uk', 'i-paper'],
  ['Aleks Sierz', 'sierz-co-uk', 'tribune'],
  ['Frank Scheck', 'reuters', 'hollywood-reporter'],
  ['David Rooney', 'reuters', 'hollywood-reporter'],
  ['Mark Kennedy', 'nbcny', 'ap'],
  ['Matt Windman', 'newsday', 'amny'],
  ['Justin Clarke', 'theatre-thoughts-aus', 'timeout-sydney'],
];

test('each BRO-7207 reprint class names its original outlet as the primary', () => {
  for (const [critic, secondary, primary] of CLASSES) {
    assert.ok(getSyndicationPrimaries(critic, secondary).includes(primary), `${critic}: ${secondary} should defer to ${primary}`);
  }
});

test('the originals never defer to the reprint, and other critics at the original outlet are untouched', () => {
  assert.deepEqual(getSyndicationPrimaries('Aleks Sierz', 'artsdesk'), []);
  assert.deepEqual(getSyndicationPrimaries('Frank Scheck', 'hollywood-reporter'), []);
  assert.deepEqual(getSyndicationPrimaries('Matt Windman', 'amny'), []);
  assert.deepEqual(getSyndicationPrimaries('Linda Winer', 'newsday'), []);
  assert.deepEqual(getSyndicationPrimaries('Justin Clarke', 'timeout-sydney'), []);
  assert.deepEqual(getSyndicationPrimaries('Unknown', 'sierz-co-uk'), []);
});

test('the audit reports these pairs as syndicated copies, not unexplained pairs', () => {
  const rows = CLASSES.map(([criticName, secondary, primary], i) => [
    { showId: `show-${i}`, outletId: primary, criticName },
    { showId: `show-${i}`, outletId: secondary, criticName },
  ]).flat();
  const { unexplained } = findUnexplainedSameCriticPairs(rows, []);
  assert.deepEqual(unexplained, []);
  const syndicated = findSyndicatedCriticPairs(rows);
  for (const [criticName, secondary, primary] of CLASSES) {
    assert.ok(syndicated.some((p) => p.criticName === criticName && p.secondary === secondary && p.primary === primary), `${criticName} ${secondary}->${primary}`);
  }
});

test('allowlist entries are unique and every BRO-7207 entry gives its evidence', () => {
  const keys = allowlist.map((e) => [e.showId, e.critic, ...[...e.outlets].sort()].join('|'));
  assert.equal(new Set(keys).size, keys.length, 'duplicate allowlist entry');
  const mine = allowlist.filter((e) => /^BRO-7207:/.test(e.reason || ''));
  assert.ok(mine.length >= 16);
  for (const e of mine) {
    assert.equal(e.outlets.length, 2, e.showId);
    assert.ok(/https?:\/\//.test(e.reason) || /Theatre Record/.test(e.reason), `${e.showId}: reason must cite urls or the Theatre Record source`);
  }
});
