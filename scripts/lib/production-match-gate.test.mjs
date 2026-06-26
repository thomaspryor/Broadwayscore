import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { productionMatchSignals, passesProductionMatch } = require('./production-match-gate.js');

const sinatra = {
  id: 'sinatra-the-musical-west-end-2026',
  title: 'Sinatra The Musical',
  venue: 'Aldwych Theatre',
  openingDate: '2026-06-24',
  cast: [{ name: 'Joel Harper-Jackson', role: 'Frank Sinatra' }, { name: 'Ana Villafane' }],
};

// The Truth: generic title, EMPTY cast — must lean on venue + year + slug tokens.
const truth = {
  id: 'the-truth-a-comedy-by-florian-zeller-west-end-2026',
  title: 'The Truth',
  venue: 'Apollo Theatre',
  openingDate: '2026-06-24',
  cast: [],
};

test('signals: venue token, year, surname; drops generic words', () => {
  const { tokens } = productionMatchSignals(sinatra);
  assert.ok(tokens.has('aldwych'), 'venue token');
  assert.ok(tokens.has('2026'), 'year');
  assert.ok(tokens.has('harper-jackson') || tokens.has('villafane'), 'surname');
  assert.ok(!tokens.has('theatre'), 'drops generic venue word');
  assert.ok(!tokens.has('the'), 'drops stopword');
});

test('The Truth (empty cast): distinguishing slug tokens survive', () => {
  const { tokens } = productionMatchSignals(truth);
  assert.ok(tokens.has('apollo'), 'venue');
  assert.ok(tokens.has('2026'), 'year');
  assert.ok(tokens.has('florian'), 'playwright slug token');
  assert.ok(tokens.has('zeller'), 'playwright slug token');
  assert.ok(!tokens.has('truth'), 'title word excluded');
  assert.ok(!tokens.has('comedy'), 'structural slug word excluded');
});

test('passes when the result ties to THIS production', () => {
  // wrong production of The Truth (2016, Menier) — should FAIL
  assert.equal(passesProductionMatch(
    { title: 'The Truth review', description: 'Menier Chocolate Factory, 2016 — a sharp farce', url: 'https://x.com/the-truth-review-2016' },
    truth), false);
  // right production — venue in snippet → PASS
  assert.equal(passesProductionMatch(
    { title: 'The Truth review', description: 'Apollo Theatre — Florian Zeller comedy', url: 'https://x.com/the-truth-review' },
    truth), true);
  // right production — playwright slug token in snippet → PASS
  assert.equal(passesProductionMatch(
    { title: 'The Truth — review', description: 'Zeller’s comedy of deceit opens in the West End', url: 'https://blog/the-truth' },
    truth), true);
});

test('boundary match: year does not hit a longer number; reject when no signal', () => {
  assert.equal(passesProductionMatch({ title: 'Sinatra review', description: 'show id 20261 something', url: '' }, sinatra), false);
  assert.equal(passesProductionMatch({ title: 'Sinatra The Musical review', description: 'a glossy biography', url: 'https://x/sinatra-review' }, sinatra), false);
  assert.equal(passesProductionMatch({ title: 'Sinatra review', description: 'Aldwych Theatre opening', url: '' }, sinatra), true);
});

test('no signals available → reject (safe default)', () => {
  assert.equal(passesProductionMatch({ title: 'anything', description: 'anything' }, { id: '', title: '', venue: '', cast: [] }), false);
});
