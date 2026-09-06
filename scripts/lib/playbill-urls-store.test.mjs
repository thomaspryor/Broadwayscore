import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const S = require('./playbill-urls-store.js');

function tmpCache(shows = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbu-store-'));
  const file = path.join(dir, 'playbill-urls.json');
  fs.writeFileSync(file, JSON.stringify({ shows, lastUpdated: null }, null, 2) + '\n');
  return file;
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// THE BUG THIS FILE EXISTS FOR. Two writers each load, each add their own show,
// each save. Under the old whole-file write the second save discarded the
// first's entry with no error and no log.
test('two interleaved writers: BOTH entries survive', () => {
  const file = tmpCache({ 'pre-existing-2020': 'https://playbill.com/production/pre-2020' });

  const a = S.loadPlaybillUrls(file);
  const b = S.loadPlaybillUrls(file); // B loaded before A saved — the whole race

  a.data.shows['show-a-2026'] = 'https://playbill.com/production/a-2026';
  b.data.shows['show-b-2026'] = 'https://playbill.com/production/b-2026';

  S.savePlaybillUrls(file, a.data, a.snapshot);
  const bResult = S.savePlaybillUrls(file, b.data, b.snapshot);

  const final = read(file).shows;
  assert.equal(final['show-a-2026'], 'https://playbill.com/production/a-2026',
    "A's entry was destroyed by B's save — this is the lost update");
  assert.equal(final['show-b-2026'], 'https://playbill.com/production/b-2026');
  assert.equal(final['pre-existing-2020'], 'https://playbill.com/production/pre-2020');
  assert.equal(bResult.recovered, 1, 'B should report recovering the 1 entry A added since B loaded');
  assert.equal(bResult.sets, 1);
});

// Remove the merge (write the working copy straight out) and this is what you get.
test('the same interleaving WITHOUT merge-on-write loses an entry (negative control)', () => {
  const file = tmpCache({ 'pre-existing-2020': 'https://playbill.com/production/pre-2020' });
  const a = S.loadPlaybillUrls(file);
  const b = S.loadPlaybillUrls(file);
  a.data.shows['show-a-2026'] = 'https://playbill.com/production/a-2026';
  b.data.shows['show-b-2026'] = 'https://playbill.com/production/b-2026';
  const naiveSave = (d) => fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
  naiveSave(a.data);
  naiveSave(b.data);
  const final = read(file).shows;
  assert.equal(final['show-a-2026'], undefined,
    'if this ever passes, the old write is no longer lossy and this test is obsolete');
  assert.equal(final['show-b-2026'], 'https://playbill.com/production/b-2026');
});

// `{...onDisk, ...mine}` is the obvious merge and it is wrong: my working copy
// still holds the pre-delete value, so the peer's eviction comes straight back.
test('a peer DELETE is not resurrected by my save', () => {
  const file = tmpCache({
    'evicted-2026': 'https://playbill.com/production/wrong-market-2026',
    'keep-2026': 'https://playbill.com/production/keep-2026',
  });
  const mine = S.loadPlaybillUrls(file);           // still holds evicted-2026

  const peer = S.loadPlaybillUrls(file);           // peer evicts it
  delete peer.data.shows['evicted-2026'];
  S.savePlaybillUrls(file, peer.data, peer.snapshot);

  mine.data.shows['new-2026'] = 'https://playbill.com/production/new-2026';
  S.savePlaybillUrls(file, mine.data, mine.snapshot);

  const final = read(file).shows;
  assert.equal(final['evicted-2026'], undefined, "the peer's eviction was resurrected");
  assert.equal(final['new-2026'], 'https://playbill.com/production/new-2026');
  assert.equal(final['keep-2026'], 'https://playbill.com/production/keep-2026');
});

// Deletes are compare-and-swap for this reason.
test('my STALE delete does not destroy a value a peer wrote after my read', () => {
  const file = tmpCache({ 'contested-2026': 'https://playbill.com/production/old-2026' });
  const mine = S.loadPlaybillUrls(file);
  delete mine.data.shows['contested-2026'];        // decided against the OLD value

  const peer = S.loadPlaybillUrls(file);
  peer.data.shows['contested-2026'] = 'https://playbill.com/production/fresh-2026';
  S.savePlaybillUrls(file, peer.data, peer.snapshot);

  S.savePlaybillUrls(file, mine.data, mine.snapshot);

  assert.equal(read(file).shows['contested-2026'], 'https://playbill.com/production/fresh-2026',
    'a delete decided against a stale value must not remove a fresher one');
});

test('my delete DOES land when disk still holds the value it was decided against', () => {
  const file = tmpCache({ 'stale-2026': 'https://playbill.com/production/stale-2026' });
  const mine = S.loadPlaybillUrls(file);
  delete mine.data.shows['stale-2026'];
  const r = S.savePlaybillUrls(file, mine.data, mine.snapshot);
  assert.equal(read(file).shows['stale-2026'], undefined);
  assert.equal(r.deletes, 1);
});

test('a set overwrites a peer set for the same id — last write wins, deliberately', () => {
  const file = tmpCache({});
  const mine = S.loadPlaybillUrls(file);
  mine.data.shows['same-2026'] = 'https://playbill.com/production/mine-2026';
  const peer = S.loadPlaybillUrls(file);
  peer.data.shows['same-2026'] = 'https://playbill.com/production/peer-2026';
  S.savePlaybillUrls(file, peer.data, peer.snapshot);
  S.savePlaybillUrls(file, mine.data, mine.snapshot);
  assert.equal(read(file).shows['same-2026'], 'https://playbill.com/production/mine-2026');
});

test('computeDelta separates sets from deletes and ignores untouched ids', () => {
  const snapshot = { a: '1', b: '2', c: '3' };
  const current = { shows: { a: '1', b: 'CHANGED', d: 'NEW' } };
  const d = S.computeDelta(snapshot, current);
  assert.deepEqual(d.sets, { b: 'CHANGED', d: 'NEW' });
  assert.deepEqual(d.deletes, { c: '3' });
});

test('applyDelta leaves ids this process never touched exactly as disk has them', () => {
  const onDisk = { shows: { untouched: 'disk-value', peer_added: 'peer-value' }, lastUpdated: 'x' };
  const merged = S.applyDelta(onDisk, { sets: { mine: 'my-value' }, deletes: {} });
  assert.equal(merged.shows.untouched, 'disk-value');
  assert.equal(merged.shows.peer_added, 'peer-value');
  assert.equal(merged.shows.mine, 'my-value');
});

test('the write is atomic and leaves no tmp file behind', () => {
  const file = tmpCache({ x: 'https://playbill.com/production/x' });
  const mine = S.loadPlaybillUrls(file);
  mine.data.shows['y'] = 'https://playbill.com/production/y';
  S.savePlaybillUrls(file, mine.data, mine.snapshot);
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'), 'trailing newline convention preserved');
});

test('a missing or unparseable cache file loads as empty rather than throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbu-store-bad-'));
  const missing = path.join(dir, 'nope.json');
  assert.deepEqual(S.loadPlaybillUrls(missing).data.shows, {});

  const garbage = path.join(dir, 'garbage.json');
  fs.writeFileSync(garbage, '{ not json');
  assert.deepEqual(S.loadPlaybillUrls(garbage).data.shows, {});

  // Right shape, wrong type for `shows` — an array is not a map and would make
  // every Object.entries() below behave like an empty object silently.
  const wrongShape = path.join(dir, 'wrong.json');
  fs.writeFileSync(wrongShape, JSON.stringify({ shows: [], lastUpdated: null }));
  assert.deepEqual(S.loadPlaybillUrls(wrongShape).data.shows, {});
});

test('an eviction that shrinks the file past the 5% guard still writes', () => {
  // The shrink gate exists for shows.json, where a 5% line drop means data
  // loss. This cache is small: removing 1 of 3 entries is a 30%+ line drop and
  // is a legitimate self-heal eviction. allowShrink must be set or the guard
  // turns a correct eviction into a thrown error.
  const file = tmpCache({ a: 'u-a', b: 'u-b', c: 'u-c' });
  const mine = S.loadPlaybillUrls(file);
  delete mine.data.shows.a;
  delete mine.data.shows.b;
  S.savePlaybillUrls(file, mine.data, mine.snapshot);
  assert.deepEqual(Object.keys(read(file).shows), ['c']);
});

test('lastUpdated is refreshed on every save and is not treated as an entry', () => {
  const file = tmpCache({ a: 'u-a' });
  const mine = S.loadPlaybillUrls(file);
  mine.data.shows.b = 'u-b';
  S.savePlaybillUrls(file, mine.data, mine.snapshot);
  const out = read(file);
  assert.ok(Date.parse(out.lastUpdated) > 0, 'lastUpdated should be a fresh ISO timestamp');
  assert.deepEqual(Object.keys(out.shows).sort(), ['a', 'b']);
});

// The multi-save caller. Without re-baselining, save #2 replays save #1's sets
// and clobbers a value a peer corrected in between — which is worse than the
// lost update this whole module exists to fix, because it destroys a CORRECTION.
test('openPlaybillUrls: a second save does not replay the first save\'s writes', () => {
  const file = tmpCache({});
  const session = S.openPlaybillUrls(file);

  session.data.shows['a-2026'] = 'https://playbill.com/production/a-first';
  session.save();

  // A peer corrects a-2026 between our two saves.
  const peer = S.loadPlaybillUrls(file);
  peer.data.shows['a-2026'] = 'https://playbill.com/production/a-corrected';
  S.savePlaybillUrls(file, peer.data, peer.snapshot);

  session.data.shows['b-2026'] = 'https://playbill.com/production/b';
  session.save();

  const final = read(file).shows;
  assert.equal(final['a-2026'], 'https://playbill.com/production/a-corrected',
    "the second save replayed the first save's set and destroyed the peer's correction");
  assert.equal(final['b-2026'], 'https://playbill.com/production/b');
});

test('openPlaybillUrls: entries a peer adds between saves survive both', () => {
  const file = tmpCache({});
  const session = S.openPlaybillUrls(file);
  session.data.shows['mine-1'] = 'u1';
  session.save();

  const peer = S.loadPlaybillUrls(file);
  peer.data.shows['peer-1'] = 'p1';
  S.savePlaybillUrls(file, peer.data, peer.snapshot);

  session.data.shows['mine-2'] = 'u2';
  const r = session.save();

  const final = read(file).shows;
  assert.deepEqual(Object.keys(final).sort(), ['mine-1', 'mine-2', 'peer-1']);
  assert.equal(r.recovered, 1);
});
