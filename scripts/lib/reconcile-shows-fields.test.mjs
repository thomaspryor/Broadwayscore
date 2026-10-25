// Task #1817 repro + fix: push-core-data's post-rebase field reconciliation
// used to restore a RECONCILABLE field from remote whenever our local value
// was null, even when WE had just deliberately cleared it this run (e.g.
// fix-shared-ibdb-urls.js nulling a shared ibdbUrl). That silently reverted
// the self-heal on every push retry, so the fix never landed on origin/main.
//
// Run: node --test scripts/lib/reconcile-shows-fields.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { reconcileShowFields, reconcileShowsJson } = require('./reconcile-shows-fields.js');

test('#1817 repro: does NOT restore a field this run deliberately cleared', () => {
  // Baseline (pre-run snapshot) had the stale shared ibdbUrl.
  const base = { ibdbUrl: 'https://www.ibdb.com/broadway-production/the-sound-of-music-4849' };
  // Self-heal already nulled it in our local working tree this run.
  const local = { id: 'the-sound-of-music-2027', ibdbUrl: null };
  // origin/main never received a prior fix — still has the stale shared URL.
  const remote = { id: 'the-sound-of-music-2027', ibdbUrl: 'https://www.ibdb.com/broadway-production/the-sound-of-music-4849' };

  const recovered = reconcileShowFields(local, remote, base);

  assert.strictEqual(recovered, 0);
  assert.strictEqual(local.ibdbUrl, null, 'must not resurrect the deliberately-cleared value');
});

test('genuine recovery: restores a field this run never touched', () => {
  const base = { venue: null };
  const local = { id: 'some-show', venue: null };
  const remote = { id: 'some-show', venue: 'Imperial Theatre' };

  const recovered = reconcileShowFields(local, remote, base);

  assert.strictEqual(recovered, 1);
  assert.strictEqual(local.venue, 'Imperial Theatre');
});

test('no base available: falls back to old permissive behavior (documented limitation)', () => {
  const local = { id: 'some-show', venue: null };
  const remote = { id: 'some-show', venue: 'Imperial Theatre' };

  const recovered = reconcileShowFields(local, remote, null);

  assert.strictEqual(recovered, 1);
});

test('second-opinion follow-up: a genuinely NEW remote value (differs from baseline) is still recovered even though baseline was non-empty', () => {
  // We nulled the field this run (self-heal-style clear), AND a concurrent
  // writer legitimately updated it on remote to a value baseline never saw.
  const base = { officialUrl: 'https://old.example.com' };
  const local = { id: 'some-show', officialUrl: null };
  const remote = { id: 'some-show', officialUrl: 'https://new-legit-update.example.com' };

  const recovered = reconcileShowFields(local, remote, base);

  assert.strictEqual(recovered, 1);
  assert.strictEqual(local.officialUrl, 'https://new-legit-update.example.com');
});

test('local already has a value: never overwritten regardless of remote/base', () => {
  const base = { venue: null };
  const local = { id: 'some-show', venue: 'Our Venue' };
  const remote = { id: 'some-show', venue: 'Remote Venue' };

  const recovered = reconcileShowFields(local, remote, base);

  assert.strictEqual(recovered, 0);
  assert.strictEqual(local.venue, 'Our Venue');
});

test('reconcileShowsJson: whole-show re-add only when base also lacked it', () => {
  const base = { shows: [{ id: 'a' }] };
  const local = { shows: [{ id: 'a' }] };
  const remote = { shows: [{ id: 'a' }, { id: 'b-concurrent-add' }, { id: 'c-deleted-by-us' }] };
  // base already had 'c-deleted-by-us' too, meaning WE deleted it this run.
  base.shows.push({ id: 'c-deleted-by-us' });

  const { readded } = reconcileShowsJson(local, remote, base, undefined, []);

  assert.strictEqual(readded, 1);
  const ids = local.shows.map((s) => s.id);
  assert.ok(ids.includes('b-concurrent-add'), 'concurrent add must be recovered');
  assert.ok(!ids.includes('c-deleted-by-us'), 'deliberate delete must survive');
});

test('reconcileShowsJson: end-to-end #1817 repro across the full pipeline', () => {
  const url = 'https://www.ibdb.com/broadway-production/the-sound-of-music-4849';
  const base = { shows: [
    { id: 'the-sound-of-music-1998', ibdbUrl: url },
    { id: 'the-sound-of-music-2027', ibdbUrl: url },
  ] };
  const local = { shows: [
    { id: 'the-sound-of-music-1998', ibdbUrl: url },
    { id: 'the-sound-of-music-2027', ibdbUrl: null }, // self-heal cleared this
  ] };
  const remote = { shows: [
    { id: 'the-sound-of-music-1998', ibdbUrl: url },
    { id: 'the-sound-of-music-2027', ibdbUrl: url }, // origin never got a prior fix
  ] };

  const { recovered } = reconcileShowsJson(local, remote, base, undefined, []);

  assert.strictEqual(recovered, 0);
  const revival = local.shows.find((s) => s.id === 'the-sound-of-music-2027');
  assert.strictEqual(revival.ibdbUrl, null, 'the self-heal fix must survive reconciliation');
});

// BRO-5011: standard 3-way pass. -X ours lets our whole hunk win, so a field
// this run never touched (local === baseline) loses a concurrent remote
// change unless reconcile puts it back. Incident: execute-approved-fix nulled
// a-dolls-house-off-west-end-2026 images.thumbnail while fetch-show-images ran.
const IMG = (o) => ({
  thumbnail: '/images/shows/x/thumbnail.jpg',
  poster: '/images/shows/x/poster.jpg',
  hero: null,
  ...o,
});

test('BRO-5011: plan nulls thumbnail, fetch keeps baseline -> merged keeps null', () => {
  const base = { id: 'x', images: IMG() };
  const local = { id: 'x', images: IMG({ thumbnail: null }) };
  const remote = { id: 'x', images: IMG() };
  const recovered = reconcileShowFields(local, remote, base);
  assert.strictEqual(recovered, 0);
  assert.strictEqual(local.images.thumbnail, null);
});

test('BRO-5011: fetch changes hero while plan nulls thumbnail -> both kept', () => {
  const base = { id: 'x', images: IMG() };
  const local = { id: 'x', images: IMG({ thumbnail: null }) };
  const remote = { id: 'x', images: IMG({ hero: '/images/shows/x/hero.jpg' }) };
  const recovered = reconcileShowFields(local, remote, base);
  assert.strictEqual(recovered, 1);
  assert.deepStrictEqual(local.images, IMG({ thumbnail: null, hero: '/images/shows/x/hero.jpg' }));
});

test('BRO-5011: images untouched locally, remote restored thumbnail -> remote wins', () => {
  const base = { id: 'x', images: IMG({ thumbnail: null }) };
  const local = { id: 'x', images: IMG({ thumbnail: null }), status: 'closed' };
  const remote = { id: 'x', images: IMG() };
  reconcileShowFields(local, remote, base);
  assert.strictEqual(local.images.thumbnail, '/images/shows/x/thumbnail.jpg');
  assert.strictEqual(local.status, 'closed');
});

test('BRO-5011: same images sub-key changed on both sides -> ours wins', () => {
  const base = { id: 'x', images: IMG() };
  const local = { id: 'x', images: IMG({ hero: '/a.jpg' }) };
  const remote = { id: 'x', images: IMG({ hero: '/b.jpg' }) };
  reconcileShowFields(local, remote, base);
  assert.strictEqual(local.images.hero, '/a.jpg');
});

test('BRO-5011: non-safelisted scalar changed only on remote -> remote wins', () => {
  const base = { id: 'x', status: 'previews', closingDate: null };
  const local = { id: 'x', status: 'previews', closingDate: null };
  const remote = { id: 'x', status: 'open', closingDate: '2027-01-04' };
  const recovered = reconcileShowFields(local, remote, base);
  assert.strictEqual(recovered, 2);
  assert.strictEqual(local.status, 'open');
  assert.strictEqual(local.closingDate, '2027-01-04');
});

test('BRO-5011: scalar changed on both sides -> ours wins', () => {
  const base = { id: 'x', status: 'previews' };
  const local = { id: 'x', status: 'closed' };
  const remote = { id: 'x', status: 'open' };
  reconcileShowFields(local, remote, base);
  assert.strictEqual(local.status, 'closed');
});

test('BRO-5011: remote deleted a key we never touched -> deleted locally', () => {
  const base = { id: 'x', provisional: true };
  const local = { id: 'x', provisional: true };
  const remote = { id: 'x' };
  reconcileShowFields(local, remote, base);
  assert.ok(!('provisional' in local));
});

test('BRO-5011: we deleted a key remote left alone -> stays deleted', () => {
  const base = { id: 'x', provisional: true };
  const local = { id: 'x' };
  const remote = { id: 'x', provisional: true };
  reconcileShowFields(local, remote, base);
  assert.ok(!('provisional' in local));
});

test('BRO-5011 cousin: a deliberately cleared array field (tourLegs) is not resurrected', () => {
  const legs = () => [{ city: 'Chicago', start: '2026-01-01' }];
  const base = { id: 'x', tourLegs: legs() };
  const local = { id: 'x', tourLegs: null };
  const remote = { id: 'x', tourLegs: legs() };
  const recovered = reconcileShowFields(local, remote, base);
  assert.strictEqual(recovered, 0);
  assert.strictEqual(local.tourLegs, null);
});

test('BRO-5011: no baseline row -> 3-way pass skipped, -X ours result kept', () => {
  const local = { id: 'x', status: 'previews', images: IMG({ thumbnail: null }) };
  const remote = { id: 'x', status: 'open', images: IMG() };
  const recovered = reconcileShowFields(local, remote, undefined);
  assert.strictEqual(recovered, 0);
  assert.strictEqual(local.status, 'previews');
  assert.strictEqual(local.images.thumbnail, null);
});

test('BRO-5011: reconcileShowsJson applies the 3-way pass and counts it', () => {
  const base = { shows: [{ id: 'x', images: IMG() }] };
  const local = { shows: [{ id: 'x', images: IMG({ thumbnail: null }) }] };
  const remote = { shows: [{ id: 'x', images: IMG({ hero: '/h.jpg' }) }] };
  const r = reconcileShowsJson(local, remote, base, undefined, []);
  assert.strictEqual(r.recovered, 1);
  assert.deepStrictEqual(local.shows[0].images, IMG({ thumbnail: null, hero: '/h.jpg' }));
});

// BRO-4856: synopsisSource moves with its synopsis, never alone.
test('reconcile: our rewritten synopsis keeps our stamp when remote also changed both', () => {
  const base = { id: 'x', synopsis: 'A', synopsisSource: 'wikipedia' };
  const local = { id: 'x', synopsis: 'B', synopsisSource: 'wikipedia' };
  const remote = { id: 'x', synopsis: 'C', synopsisSource: 'manual' };
  reconcileShowFields(local, remote, base);
  assert.equal(local.synopsis, 'B');
  assert.equal(local.synopsisSource, 'wikipedia');
});
test('reconcile: remote synopsis taken in the 3-way pass brings its stamp', () => {
  const base = { id: 'x', synopsis: 'A', synopsisSource: 'wikipedia' };
  const local = { id: 'x', synopsis: 'A', synopsisSource: 'wikipedia' };
  const remote = { id: 'x', synopsis: 'C', synopsisSource: 'manual' };
  reconcileShowFields(local, remote, base);
  assert.equal(local.synopsis, 'C');
  assert.equal(local.synopsisSource, 'manual');
});
test('reconcile: refilling an emptied synopsis from remote brings its stamp', () => {
  const local = { id: 'x', synopsis: null };
  const remote = { id: 'x', synopsis: 'C', synopsisSource: 'todaytix' };
  reconcileShowFields(local, remote, undefined);
  assert.equal(local.synopsis, 'C');
  assert.equal(local.synopsisSource, 'todaytix');
});
