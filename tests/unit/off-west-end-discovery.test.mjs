import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  selectMissingT1T2Outlets, getLondonSupplementalOutlets, reviewSearchKeyword,
  rotateMissingOutlets, findStalledReviewStubs, warnStalledReviewStubs,
} = require('../../scripts/lib/opening-night-discovery-policy');

const registry = { outlets: {
  whatsonstage: { tier: 2, region: 'london', domain: 'whatsonstage.com' },
  thestage: { tier: 1, region: 'london', domain: 'thestage.co.uk' },
  'everything-theatre': { tier: 3, region: 'london', domain: 'everythingtheatre.co.uk' },
  'the-spy-in-the-stalls': { tier: 4, region: 'london', domain: 'thespyinthestalls.com' },
  'west-end-best-friend': { tier: 3, region: 'london', domain: 'westendbestfriend.co.uk' },
  theatreandtonic: { tier: 3, region: 'london', domain: 'theatreandtonic.com' },
  thereviewshub: { tier: 2, region: 'london', domain: 'thereviewshub.com' },
  readaboutstuff: { tier: 4, region: 'london', domain: 'readaboutstuff.com' },
  'us-only': { tier: 1, region: 'us', domain: 'example.com' },
} };
const show = { id: 'holy-fool-off-west-end-2026', title: 'Holy Fool', category: 'off-west-end', openingDate: '2026-09-04' };

test('clean opening-night plan queries all eight known outlets, including T4', () => {
  const found = new Set();
  const tierFor = id => registry.outlets[id].tier;
  const main = selectMissingT1T2Outlets(registry, found, 'west-end', tierFor);
  const extra = getLondonSupplementalOutlets(registry, found, show, new Date('2026-09-04T12:00:00Z'));
  assert.deepEqual(new Set([...main, ...extra].map(o => o.id)), new Set(Object.keys(registry.outlets).filter(id => id !== 'us-only')));
  assert.equal(reviewSearchKeyword(show), 'review');
});

test('region=london and region=uk are eligible; US-only outlets are excluded', () => {
  const r = { outlets: { london: { region: 'london' }, uk: { region: 'uk' }, us: { region: 'us' }, dual: { region: 'us', isDualMarket: true } } };
  assert.deepEqual(selectMissingT1T2Outlets(r, new Set(['uk']), 'west-end', () => 1).map(o => o.id), ['london', 'dual']);
  assert.deepEqual(selectMissingT1T2Outlets(r, new Set(), 'broadway', () => 1).map(o => o.id), ['london', 'us', 'dual']);
});

test('supplement preserves West End day-two timing, market isolation and dedup', () => {
  const now = new Date('2026-09-04T12:00:00Z');
  assert.deepEqual(getLondonSupplementalOutlets(registry, new Set(), { ...show, category: 'west-end' }, now), []);
  assert.deepEqual(getLondonSupplementalOutlets(registry, new Set(), { ...show, category: 'broadway' }, now), []);
  const extra = getLondonSupplementalOutlets(registry, new Set(['readaboutstuff']), show, now);
  assert.ok(!extra.some(o => o.id === 'readaboutstuff'));
  assert.equal(reviewSearchKeyword({ category: 'west-end' }), 'West End review');
  assert.equal(reviewSearchKeyword({ category: 'off-broadway' }), 'Off-Broadway review');
  assert.equal(reviewSearchKeyword({ category: 'broadway' }), 'Broadway review');
});

test('real registry and tier selector include the eight outlets and rotate past missing nationals', () => {
  const realRegistry = require('../../data/outlet-registry.json');
  const { getMissingT1T2Outlets } = require('../../scripts/lib/opening-night-readiness');
  const main = getMissingT1T2Outlets('__bro2854_clean_state__', 'west-end', show);
  const extra = getLondonSupplementalOutlets(realRegistry, new Set(main.map(o => o.id)), show, new Date('2026-09-04T12:00:00Z'));
  const plan = [...main, ...extra];
  const queried = new Set();
  for (let offset = 0; offset < plan.length; offset += 12) {
    for (const outlet of rotateMissingOutlets(plan, offset).slice(0, 12)) queried.add(outlet.id);
  }
  for (const id of Object.keys(registry.outlets).filter(id => id !== 'us-only')) assert.ok(queried.has(id), `${id} never queried`);
  assert.deepEqual(rotateMissingOutlets([], 12), []);
  assert.deepEqual(rotateMissingOutlets([1, 2, 3], 4), [2, 3, 1]);
});

test('empty stubs alert after two hours even if another review is already scored', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2854-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = new Date('2026-09-05T08:00:00Z');
  const records = {
    'stalled.json': { contentTier: 'stub', fullText: '', firstSeenAt: '2026-09-05T05:48:00Z' },
    'boundary.json': { contentTier: 'stub', fullText: '', firstSeenAt: '2026-09-05T06:00:00Z' },
    'recent.json': { contentTier: 'stub', firstSeenAt: '2026-09-05T07:00:00Z' },
    'collected.json': { contentTier: 'complete', fullText: 'usable text', assignedScore: 80, firstSeenAt: '2026-09-05T01:00:00Z' },
    'excerpt.json': { contentTier: 'excerpt', fullText: '', firstSeenAt: '2026-09-05T01:00:00Z' },
    '_metadata.json': { contentTier: 'stub', firstSeenAt: '2026-09-05T01:00:00Z' },
  };
  for (const [file, record] of Object.entries(records)) fs.writeFileSync(path.join(dir, file), JSON.stringify(record));
  assert.deepEqual(findStalledReviewStubs(show, dir, now).map(r => r.file), ['stalled.json']);
  const messages = [];
  assert.equal(warnStalledReviewStubs(show, dir, { now, log: m => messages.push(m), githubActions: true }).length, 1);
  assert.match(messages[0], /^::warning::COLLECTION STALLED: holy-fool-off-west-end-2026\/stalled.json/);
  assert.deepEqual(findStalledReviewStubs(show, dir, new Date('2026-09-10T08:00:00Z')), []);
  assert.deepEqual(findStalledReviewStubs({ ...show, openingDate: null }, dir, now), []);
});

test('legacy files use mtime; malformed discovery clocks fall back to mtime', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2854-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of ['legacy.json', 'bad-clock.json']) {
    const p = path.join(dir, file);
    fs.writeFileSync(p, JSON.stringify({ contentTier: 'stub', fullText: null, firstSeenAt: file === 'bad-clock.json' ? 'bad' : undefined }));
    fs.utimesSync(p, new Date('2026-09-05T05:00:00Z'), new Date('2026-09-05T05:00:00Z'));
  }
  assert.equal(findStalledReviewStubs(show, dir, new Date('2026-09-05T08:00:00Z')).length, 2);
});
