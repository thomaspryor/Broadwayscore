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

  const { readded } = reconcileShowsJson(local, remote, base);

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

  const { recovered } = reconcileShowsJson(local, remote, base);

  assert.strictEqual(recovered, 0);
  const revival = local.shows.find((s) => s.id === 'the-sound-of-music-2027');
  assert.strictEqual(revival.ibdbUrl, null, 'the self-heal fix must survive reconciliation');
});
