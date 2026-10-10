import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getShowConsensusText } = require('./critic-consensus-lookup.js');

test('getShowConsensusText: reads .text under { shows: {...} } wrapper', () => {
  const consensus = { shows: { 'giant-2026': { text: 'Critics are raving.' } } };
  assert.equal(getShowConsensusText(consensus, 'giant-2026'), 'Critics are raving.');
});

test('getShowConsensusText: reads a bare id-keyed object (no shows wrapper)', () => {
  const consensus = { 'giant-2026': { text: 'Critics are raving.' } };
  assert.equal(getShowConsensusText(consensus, 'giant-2026'), 'Critics are raving.');
});

test('getShowConsensusText: falls back to .consensus when .text is absent', () => {
  const consensus = { shows: { 'giant-2026': { consensus: 'Old-style field.' } } };
  assert.equal(getShowConsensusText(consensus, 'giant-2026'), 'Old-style field.');
});

test('getShowConsensusText: falls back to slug when showId misses', () => {
  const consensus = { shows: { 'giant-the-musical': { text: 'By slug.' } } };
  assert.equal(getShowConsensusText(consensus, 'giant-2026', 'giant-the-musical'), 'By slug.');
});

test('getShowConsensusText: null when show is absent entirely', () => {
  const consensus = { shows: { 'other-2026': { text: 'x' } } };
  assert.equal(getShowConsensusText(consensus, 'giant-2026'), null);
});

test('getShowConsensusText: null when entry exists but text/consensus are both empty', () => {
  const consensus = { shows: { 'giant-2026': { text: '', consensus: '' } } };
  assert.equal(getShowConsensusText(consensus, 'giant-2026'), null);
});
