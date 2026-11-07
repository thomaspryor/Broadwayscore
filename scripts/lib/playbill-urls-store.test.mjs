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
// The merge-logic tests use placeholder URLs, so they bypass the BRO-2893 write
// guard explicitly; the guard has its own tests below and in
// playbill-title-match.test.mjs.
const OPEN = { guard: () => ({ ok: true, reason: null }) };

// THE BUG THIS FILE EXISTS FOR. Two writers each load, each add their own show,
// each save. Under the old whole-file write the second save discarded the
// first's entry with no error and no log.
test('two interleaved writers: BOTH entries survive', () => {
  const file = tmpCache({ 'pre-existing-2020': 'https://playbill.com/production/pre-2020' });

  const a = S.loadPlaybillUrls(file);
  const b = S.loadPlaybillUrls(file); // B loaded before A saved — the whole race

  a.data.shows['show-a-2026'] = 'https://playbill.com/production/a-2026';
  b.data.shows['show-b-2026'] = 'https://playbill.com/production/b-2026';

  S.savePlaybillUrls(file, a.data, a.snapshot, OPEN);
  const bResult = S.savePlaybillUrls(file, b.data, b.snapshot, OPEN);

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
  S.savePlaybillUrls(file, peer.data, peer.snapshot, OPEN);

  mine.data.shows['new-2026'] = 'https://playbill.com/production/new-2026';
  S.savePlaybillUrls(file, mine.data, mine.snapshot, OPEN);

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
  S.savePlaybillUrls(file, peer.data, peer.snapshot, OPEN);

  S.savePlaybillUrls(file, mine.data, mine.snapshot, OPEN);

  assert.equal(read(file).shows['contested-2026'], 'https://playbill.com/production/fresh-2026',
    'a delete decided against a stale value must not remove a fresher one');
});

test('my delete DOES land when disk still holds the value it was decided against', () => {
  const file = tmpCache({ 'stale-2026': 'https://playbill.com/production/stale-2026' });
  const mine = S.loadPlaybillUrls(file);
  delete mine.data.shows['stale-2026'];
  const r = S.savePlaybillUrls(file, mine.data, mine.snapshot, OPEN);
  assert.equal(read(file).shows['stale-2026'], undefined);
  assert.equal(r.deletes, 1);
});

test('BRO-2910: a stale set does NOT overwrite a peer set made after my load', () => {
  const file = tmpCache({});
  const mine = S.loadPlaybillUrls(file);
  mine.data.shows['same-2026'] = 'https://playbill.com/production/mine-2026';
  const peer = S.loadPlaybillUrls(file);
  peer.data.shows['same-2026'] = 'https://playbill.com/production/peer-2026';
  S.savePlaybillUrls(file, peer.data, peer.snapshot, OPEN);
  const r = S.savePlaybillUrls(file, mine.data, mine.snapshot, OPEN);
  assert.equal(read(file).shows['same-2026'], 'https://playbill.com/production/peer-2026');
  assert.deepEqual(r.conflicts, [{ id: 'same-2026', mine: 'https://playbill.com/production/mine-2026', disk: 'https://playbill.com/production/peer-2026' }]);
  assert.equal(mine.data.shows['same-2026'], 'https://playbill.com/production/peer-2026',
    'working copy adopts the persisted value');
});

// The card's exact interleaving: A resolves X, B corrects to Y, A saves last.
test('BRO-2910: a stale set cannot restore a value a peer has since corrected', () => {
  const file = tmpCache({ k: 'https://playbill.com/production/x' });
  const a = S.loadPlaybillUrls(file);                 // A's baseline: X
  const b = S.loadPlaybillUrls(file);
  b.data.shows.k = 'https://playbill.com/production/y'; // B corrects to Y
  S.savePlaybillUrls(file, b.data, b.snapshot, OPEN);
  a.data.shows.k = 'https://playbill.com/production/z'; // A re-resolves from stale X
  S.savePlaybillUrls(file, a.data, a.snapshot, OPEN);
  assert.equal(read(file).shows.k, 'https://playbill.com/production/y');
});

test('a set still lands when disk holds exactly my baseline value', () => {
  const file = tmpCache({ k: 'old' });
  const a = S.loadPlaybillUrls(file);
  a.data.shows.k = 'new';
  const r = S.savePlaybillUrls(file, a.data, a.snapshot, OPEN);
  assert.equal(read(file).shows.k, 'new');
  assert.equal(r.sets, 1);
  assert.deepEqual(r.conflicts, []);
});

test('computeDelta separates sets from deletes and ignores untouched ids', () => {
  const snapshot = { a: '1', b: '2', c: '3' };
  const current = { shows: { a: '1', b: 'CHANGED', d: 'NEW' } };
  const d = S.computeDelta(snapshot, current);
  assert.deepEqual(d.sets, { b: 'CHANGED', d: 'NEW' });
  assert.deepEqual(d.deletes, { c: '3' });
  assert.deepEqual(d.was, { b: '2' });
});

test('applyDelta leaves ids this process never touched exactly as disk has them', () => {
  const onDisk = { shows: { untouched: 'disk-value', peer_added: 'peer-value' }, lastUpdated: 'x' };
  const { data: merged } = S.applyDelta(onDisk, { sets: { mine: 'my-value' }, deletes: {} });
  assert.equal(merged.shows.untouched, 'disk-value');
  assert.equal(merged.shows.peer_added, 'peer-value');
  assert.equal(merged.shows.mine, 'my-value');
});

test('the write is atomic and leaves no tmp file behind', () => {
  const file = tmpCache({ x: 'https://playbill.com/production/x' });
  const mine = S.loadPlaybillUrls(file);
  mine.data.shows['y'] = 'https://playbill.com/production/y';
  S.savePlaybillUrls(file, mine.data, mine.snapshot, OPEN);
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'), 'trailing newline convention preserved');
});

test('ONLY a missing file loads as empty; corruption throws instead of authorising a wipe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbu-store-bad-'));

  // First run: no file. This is the one recoverable case.
  assert.deepEqual(S.loadPlaybillUrls(path.join(dir, 'nope.json')).data.shows, {});

  // Everything else must throw. Returning {} here is what turns a transient
  // corruption into "the cache is empty, write my 3 entries over it".
  const garbage = path.join(dir, 'garbage.json');
  fs.writeFileSync(garbage, '{ not json');
  assert.throws(() => S.loadPlaybillUrls(garbage), S.PlaybillUrlsCacheError);

  // Right outer shape, wrong type for `shows` — an array is not a map and would
  // behave as an empty object through Object.entries, silently.
  const wrongShape = path.join(dir, 'wrong.json');
  fs.writeFileSync(wrongShape, JSON.stringify({ shows: [], lastUpdated: null }));
  assert.throws(() => S.loadPlaybillUrls(wrongShape), S.PlaybillUrlsCacheError);

  const notAnObject = path.join(dir, 'scalar.json');
  fs.writeFileSync(notAnObject, '42');
  assert.throws(() => S.loadPlaybillUrls(notAnObject), S.PlaybillUrlsCacheError);
});

test('a corrupt file also stops the SAVE, so the delta cannot overwrite it', () => {
  // save() re-reads before writing. If that read swallowed corruption, the
  // merge would proceed against {} and the atomic write (allowShrink:true)
  // would replace a damaged-but-recoverable file with this run's few entries.
  const file = tmpCache({ a: 'u-a', b: 'u-b' });
  const mine = S.loadPlaybillUrls(file);
  mine.data.shows.c = 'u-c';
  fs.writeFileSync(file, '{ truncated mid-write');
  assert.throws(() => S.savePlaybillUrls(file, mine.data, mine.snapshot, OPEN), S.PlaybillUrlsCacheError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ truncated mid-write',
    'the damaged file must be left exactly as found for a human to inspect');
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
  S.savePlaybillUrls(file, mine.data, mine.snapshot, OPEN);
  assert.deepEqual(Object.keys(read(file).shows), ['c']);
});

test('lastUpdated is refreshed on every save and is not treated as an entry', () => {
  const file = tmpCache({ a: 'u-a' });
  const mine = S.loadPlaybillUrls(file);
  mine.data.shows.b = 'u-b';
  S.savePlaybillUrls(file, mine.data, mine.snapshot, OPEN);
  const out = read(file);
  assert.ok(Date.parse(out.lastUpdated) > 0, 'lastUpdated should be a fresh ISO timestamp');
  assert.deepEqual(Object.keys(out.shows).sort(), ['a', 'b']);
});

// The multi-save caller. Without re-baselining, save #2 replays save #1's sets
// and clobbers a value a peer corrected in between — which is worse than the
// lost update this whole module exists to fix, because it destroys a CORRECTION.
test('openPlaybillUrls: a second save does not replay the first save\'s writes', () => {
  const file = tmpCache({});
  const session = S.openPlaybillUrls(file, OPEN);

  session.data.shows['a-2026'] = 'https://playbill.com/production/a-first';
  session.save();

  // A peer corrects a-2026 between our two saves.
  const peer = S.loadPlaybillUrls(file);
  peer.data.shows['a-2026'] = 'https://playbill.com/production/a-corrected';
  S.savePlaybillUrls(file, peer.data, peer.snapshot, OPEN);

  session.data.shows['b-2026'] = 'https://playbill.com/production/b';
  session.save();

  const final = read(file).shows;
  assert.equal(final['a-2026'], 'https://playbill.com/production/a-corrected',
    "the second save replayed the first save's set and destroyed the peer's correction");
  assert.equal(final['b-2026'], 'https://playbill.com/production/b');
});

test('openPlaybillUrls: entries a peer adds between saves survive both', () => {
  const file = tmpCache({});
  const session = S.openPlaybillUrls(file, OPEN);
  session.data.shows['mine-1'] = 'u1';
  session.save();

  const peer = S.loadPlaybillUrls(file);
  peer.data.shows['peer-1'] = 'p1';
  S.savePlaybillUrls(file, peer.data, peer.snapshot, OPEN);

  session.data.shows['mine-2'] = 'u2';
  const r = session.save();

  const final = read(file).shows;
  assert.deepEqual(Object.keys(final).sort(), ['mine-1', 'mine-2', 'peer-1']);
  assert.equal(r.recovered, 1);
});

// BRO-2910 acceptance. The tests above drive writer A's whole save before writer
// B begins, so they cannot exercise the read-to-rename overlap. Here real child
// processes race load -> set -> save on one shared temp file. Without the lock
// in savePlaybillUrls, two writers re-read the same base and the later rename
// drops the earlier one's entry (verified by removing the lock: entries lost).
test('BRO-2910: concurrent PROCESSES racing saves lose no entry', async () => {
  const { execFile } = await import('node:child_process');
  const file = tmpCache({ base: 'https://playbill.com/production/base' });
  const lib = require.resolve('./playbill-urls-store.js');
  const WORKERS = 6;
  const PER_WORKER = 40;
  const worker = `
    const S = require(${JSON.stringify(lib)});
    const [file, w, n] = process.argv.slice(1);
    const OPEN = { guard: () => ({ ok: true, reason: null }) };
    // Start together so the saves overlap instead of running back to back.
    const go = Number(process.argv[4]);
    while (Date.now() < go) { /* spin */ }
    for (let i = 0; i < Number(n); i++) {
      const s = S.loadPlaybillUrls(file);
      s.data.shows['w' + w + '-' + i] = 'u' + w + '-' + i;
      S.savePlaybillUrls(file, s.data, s.snapshot, OPEN);
    }
  `;
  const go = Date.now() + 1500;
  await Promise.all(Array.from({ length: WORKERS }, (_, w) => new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', worker, file, String(w), String(PER_WORKER), String(go)],
      { timeout: 60000 }, (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  })));
  const shows = read(file).shows;
  const missing = [];
  for (let w = 0; w < WORKERS; w++) {
    for (let i = 0; i < PER_WORKER; i++) if (shows[`w${w}-${i}`] !== `u${w}-${i}`) missing.push(`w${w}-${i}`);
  }
  assert.deepEqual(missing, [], `${missing.length} entries lost to the read-to-rename race`);
  assert.equal(shows.base, 'https://playbill.com/production/base');
  assert.equal(fs.existsSync(`${file}.lock`), false, 'lock released');
});

// BRO-2893: the cache can only receive entries the matcher accepts, whichever
// writer saves. The DEFAULT guard (no opts) reads the shows.json next to the
// cache, which is how every production writer calls the store.
function cacheWithCorpus(shows, cached = {}) {
  const file = tmpCache(cached);
  fs.writeFileSync(path.join(path.dirname(file), 'shows.json'), JSON.stringify(shows));
  return file;
}
const HAMILTON = { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway', venue: 'Richard Rodgers Theatre' };
const ISH = { id: 'ish-off-west-end-2026', title: 'Ish', category: 'off-west-end', venue: 'Some London Theatre' };
const MUCH_ADO = { id: 'much-ado-about-nothing-2026', title: 'Much Ado About Nothing', category: 'broadway', venue: 'Winter Garden Theatre' };

test('BRO-2893: a writer cannot persist a URL the matcher rejects (wrong title)', () => {
  const file = cacheWithCorpus([HAMILTON]);
  const s = S.openPlaybillUrls(file);
  s.data.shows['hamilton-2015'] = 'https://playbill.com/production/hadestown-broadway-walter-kerr-theatre-2019';
  const r = s.save();
  assert.equal(read(file).shows['hamilton-2015'], undefined, 'wrong-title URL was cached');
  assert.deepEqual(r.refused.map((x) => x.reason), ['title-mismatch']);
  assert.equal(s.data.shows['hamilton-2015'], undefined, 'refused set reverted in the working copy');
});

test('BRO-2893: cross-market and regional-for-Broadway attributions are refused', () => {
  const file = cacheWithCorpus([ISH, MUCH_ADO]);
  const s = S.loadPlaybillUrls(file);
  s.data.shows[ISH.id] = 'https://playbill.com/production/ish-off-broadway-some-theatre-2026';
  s.data.shows[MUCH_ADO.id] = 'https://playbill.com/production/much-ado-about-nothing-regional-playmakers-repertory-company-2023';
  const r = S.savePlaybillUrls(file, s.data, s.snapshot);
  assert.deepEqual(read(file).shows, {});
  assert.deepEqual(r.refused.map((x) => x.reason).sort(), ['cross-market', 'regional-page-for-non-regional-show']);
});

test('BRO-2893: a correct URL still lands, and an id the corpus lacks is refused', () => {
  const file = cacheWithCorpus([HAMILTON]);
  const s = S.loadPlaybillUrls(file);
  s.data.shows['hamilton-2015'] = 'https://playbill.com/production/hamilton-broadway-richard-rodgers-theatre-2015';
  s.data.shows['no-such-show-2026'] = 'https://playbill.com/production/no-such-show-broadway-x-theatre-2026';
  const r = S.savePlaybillUrls(file, s.data, s.snapshot);
  assert.equal(read(file).shows['hamilton-2015'], 'https://playbill.com/production/hamilton-broadway-richard-rodgers-theatre-2015');
  assert.equal(read(file).shows['no-such-show-2026'], undefined);
  assert.deepEqual(r.refused.map((x) => x.reason), ['unknown-show']);
});

test('BRO-2893: existing entries are never re-judged by the write guard', () => {
  // A legacy entry the matcher cannot verify (Moulin Rouge's vault URL shape)
  // must survive another writer's save untouched.
  const legacy = 'https://playbill.com/production/moulin-rouge-the-musical-hirschfeld-theatre-2019-2020';
  const file = cacheWithCorpus([HAMILTON, { id: 'moulin-rouge-2019', title: 'Moulin Rouge!', venue: 'Al Hirschfeld Theatre' }],
    { 'moulin-rouge-2019': legacy });
  const s = S.loadPlaybillUrls(file);
  s.data.shows['hamilton-2015'] = 'https://playbill.com/production/hamilton-broadway-richard-rodgers-theatre-2015';
  S.savePlaybillUrls(file, s.data, s.snapshot);
  assert.equal(read(file).shows['moulin-rouge-2019'], legacy);
});

test('BRO-2893: a refused REPLACEMENT evicts the old URL instead of restoring it', () => {
  // enrich-off-broadway-dates evicts a dead cached URL, then sets the fresh one.
  // If the guard refuses the fresh one, restoring the dead URL would pin it
  // forever (re-fetched, re-evicted and re-searched on every run).
  const dead = 'https://playbill.com/production/hamilton-broadway-richard-rodgers-theatre-2015';
  const file = cacheWithCorpus([HAMILTON], { 'hamilton-2015': dead });
  const s = S.openPlaybillUrls(file);
  delete s.data.shows['hamilton-2015'];
  s.data.shows['hamilton-2015'] = 'https://playbill.com/production/hadestown-broadway-walter-kerr-theatre-2019';
  const r = s.save();
  assert.deepEqual(r.refused.map((x) => x.reason), ['title-mismatch']);
  assert.equal(r.deletes, 1);
  assert.equal(read(file).shows['hamilton-2015'], undefined, 'dead URL restored on disk');
  assert.equal(s.data.shows['hamilton-2015'], undefined, 'dead URL restored in the working copy');
});

test('BRO-2893: opts.showsPath points the default guard at another corpus (--data-dir)', () => {
  const file = cacheWithCorpus([]); // the cache's own corpus does not know the show
  const alt = path.join(path.dirname(file), 'candidate-shows.json');
  fs.writeFileSync(alt, JSON.stringify({ shows: [HAMILTON] }));
  const url = 'https://playbill.com/production/hamilton-broadway-richard-rodgers-theatre-2015';
  const a = S.loadPlaybillUrls(file);
  a.data.shows['hamilton-2015'] = url;
  assert.deepEqual(S.savePlaybillUrls(file, a.data, a.snapshot).refused.map((x) => x.reason), ['unknown-show']);
  const b = S.loadPlaybillUrls(file);
  b.data.shows['hamilton-2015'] = url;
  const r = S.savePlaybillUrls(file, b.data, b.snapshot, { showsPath: alt });
  assert.deepEqual(r.refused, []);
  assert.equal(read(file).shows['hamilton-2015'], url);
});
