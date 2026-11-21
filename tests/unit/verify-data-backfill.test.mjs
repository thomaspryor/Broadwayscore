import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseArgs, verifyBackfill, verifyHubImages, main } = require('../../scripts/lib/verify-data-backfill.js');
const { isSafeCheckCommand } = require('../../scripts/lib/verify-gate.js');

test('backfill probe requires explicit safe IDs and positive review minima', () => {
  const options = parseArgs(['--show=one-2026,two-2026', '--images', '--reviews=2']);
  assert.deepEqual(options, { showIds: ['one-2026', 'two-2026'], images: true, minReviews: 2, type: null });
  for (const args of [[], ['--show=../shows'], ['--show=one', '--reviews=0'], ['--show=one', '--fix'], ['--show=one', '--reviews=1', '--images']]) {
    assert.throws(() => parseArgs(args));
    assert.equal(isSafeCheckCommand(`node scripts/lib/verify-data-backfill.js ${args.join(' ')}`), false);
  }
  assert.equal(isSafeCheckCommand('node scripts/lib/verify-data-backfill.js --show=one-2026,two-2026 --images --reviews=2'), true);
});

test('backfill probe checks each show and uses the canonical image predicate', () => {
  const options = parseArgs(['--show=one,two,missing', '--images', '--reviews=1']);
  const results = verifyBackfill([
    { id: 'one', images: { poster: '/images/not-a-real-poster.jpg' } },
    { id: 'two', images: { poster: 'https://example.com/poster.jpg' } },
  ], [
    { showId: 'one', assignedScore: null }, { showId: 'two', assignedScore: 80 },
  ], options);
  assert.deepEqual(results.map(r => r.ok), [false, true, false]);
  assert.deepEqual(results[0].problems, ['usable image missing', 'scored reviews 0 < 1']);
  assert.ok(results[2].problems.includes('show missing'));
});

test('backfill CLI fails closed on missing data and unmet expectations, without writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-5266-'));
  try {
    assert.equal(main(['--show=one'], root), 2);
    fs.mkdirSync(path.join(root, 'data'));
    const shows = JSON.stringify({ shows: [{ id: 'one' }] });
    fs.writeFileSync(path.join(root, 'data', 'shows.json'), shows);
    fs.writeFileSync(path.join(root, 'data', 'reviews.json'), JSON.stringify({ reviews: [] }));
    assert.equal(main(['--show=one'], root), 0);
    assert.equal(main(['--show=one', '--images'], root), 1);
    assert.equal(main(['--show=one', '--reviews=1'], root), 1);
    assert.equal(main(['--show=missing'], root), 1);
    assert.equal(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf8'), shows);
    assert.deepEqual(fs.readdirSync(path.join(root, 'data')).sort(), ['reviews.json', 'shows.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// BRO-6506: a type correction needs its own expectation; "show found" passed before the fix.
test('--type: every listed show must carry the type; safe-form accepts it last', () => {
  assert.equal(parseArgs(['--show=one', '--type=musical']).type, 'musical');
  for (const args of [['--show=one', '--type=Musical'], ['--show=one', '--type=revue'], ['--show=one', '--type=musical', '--images']]) {
    assert.throws(() => parseArgs(args));
    assert.equal(isSafeCheckCommand(`node scripts/lib/verify-data-backfill.js ${args.join(' ')}`), false);
  }
  assert.equal(isSafeCheckCommand('node scripts/lib/verify-data-backfill.js --show=kilgallen-off-broadway-2026,wesley-off-broadway-2025 --type=musical'), true);
  const results = verifyBackfill([{ id: 'one', type: 'play' }, { id: 'two', type: 'musical' }], [], parseArgs(['--show=one,two', '--type=musical']));
  assert.deepEqual(results.map(r => r.ok), [false, true]);
  assert.deepEqual(results[0].problems, ['type play != musical']);
});

// BRO-6716: `--show=all` was a literal id that could never pass (card bounced twice).
test('selector words are refused as show ids, by the probe and by the safe-form gate', () => {
  for (const ids of ['all', 'a-2026,all', 'any', 'every', 'none']) {
    assert.throws(() => parseArgs([`--show=${ids}`, '--reviews=1']), /explicit show ids/);
    assert.equal(isSafeCheckCommand(`node scripts/lib/verify-data-backfill.js --show=${ids} --reviews=1`), false);
  }
  // Real ids that merely start with a selector word stay valid.
  for (const ids of ['all-shook-up-2026', 'allegiance-2015,anything-goes-2022', 'every-brilliant-thing-2026']) {
    assert.deepEqual(parseArgs([`--show=${ids}`]).showIds, ids.split(','));
    assert.equal(isSafeCheckCommand(`node scripts/lib/verify-data-backfill.js --show=${ids}`), true);
  }
  assert.equal(main(['--show=all', '--reviews=1'], '/nonexistent'), 2);
});

test('slow-market-grade fixed-window gap check is a safe form, only in its exact shape', () => {
  assert.equal(isSafeCheckCommand('node scripts/slow-market-grade.js --opened-from=2025-10-31 --opened-to=2026-10-31 --check-gaps'), true);
  for (const c of [
    'node scripts/slow-market-grade.js --opened-from=2025-10-31 --opened-to=2026-10-31',
    'node scripts/slow-market-grade.js --opened-from=2025-10-31 --opened-to=2026-10-31 --check-gaps --json; echo',
    'node scripts/slow-market-grade.js --show=a --check-gaps',
  ]) assert.equal(isSafeCheckCommand(c), false, c);
});

// BRO-7265: a city-hub slug with --images checks that hub's dual-model image audit.
test('verifyHubImages fails open or unbacked image items and warns on untriaged flags', () => {
  const shows = [{ id: 'a', images: { poster: '/p/a.webp' } }, { id: 'b', images: { poster: '/p/missing.webp' } }];
  const has = (p) => p === '/p/a.webp';
  const triage = (items) => ({ items });
  const clean = verifyHubImages('hub', triage({ 'image:a': { verdict: 'confirmed', status: 'fixed' }, 'image:c': { verdict: 'false-positive' } }), { remaining: [] }, shows, has);
  assert.equal(clean.ok, true);
  const open = verifyHubImages('hub', triage({ 'image:a': { verdict: 'confirmed', status: 'open' } }), { remaining: [{ item: 'image:a' }] }, shows, has);
  assert.deepEqual(open.problems, ['image:a still open']);
  const unbacked = verifyHubImages('hub', triage({ 'image:b': { verdict: 'confirmed', status: 'fixed' } }), {}, shows, has);
  assert.deepEqual(unbacked.problems, ['image:b marked fixed but no poster on disk']);
  const stale = verifyHubImages('hub', triage({}), { remaining: [{ item: 'image:a' }, { item: 'review:x' }] }, shows, has);
  assert.match(stale.problems[0], /scorecard\.json still lists 1 open image item/);
  const warn = verifyHubImages('hub', triage({ 'image:a': { verdict: 'confirmed', status: 'fixed' } }), { flags: [{ kind: 'image', id: 'a' }, { kind: 'image', id: 'd' }, { kind: 'review', id: 'e' }] }, shows, has);
  assert.equal(warn.ok, true);
  assert.deepEqual(warn.warnings, ['image:d flagged, not triaged']);
});

test('backfill CLI treats a city-hub slug as its image audit, --images only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-7265-'));
  try {
    const hubDir = path.join(root, 'data', 'audit', 'city-hub-dual', 'hub-x');
    fs.mkdirSync(hubDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'public', 'images'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'city-hubs.json'), JSON.stringify({ hubs: { 'hub-x': {} } }));
    fs.writeFileSync(path.join(root, 'data', 'shows.json'), JSON.stringify({ shows: [{ id: 'one', images: { poster: '/images/one.webp' } }] }));
    fs.writeFileSync(path.join(root, 'data', 'reviews.json'), JSON.stringify({ reviews: [] }));
    fs.writeFileSync(path.join(hubDir, 'scorecard.json'), JSON.stringify({ remaining: [], flags: [] }));
    const setTriage = (status) => fs.writeFileSync(path.join(hubDir, 'triage.json'), JSON.stringify({ items: { 'image:one': { verdict: 'confirmed', status } } }));
    setTriage('open');
    assert.equal(main(['--show=hub-x', '--images'], root), 1);
    setTriage('fixed');
    assert.equal(main(['--show=hub-x', '--images'], root), 1); // fixed, but no poster file under root/public
    fs.copyFileSync(new URL('../../public/images/shows/kaiju-regional-2026/poster.webp', import.meta.url), path.join(root, 'public', 'images', 'one.webp'));
    assert.equal(main(['--show=hub-x', '--images'], root), 0);
    assert.equal(main(['--show=hub-x'], root), 2);
    assert.equal(main(['--show=hub-x', '--images', '--reviews=1'], root), 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
