// Guards push-via-git-api.sh's apiFallbackMerge path for the two Express
// hand-off files (BRO-5955). On 2026-10-22 The Pianist's Express push
// (81788096e4) erased the Queeney Todd and Imaginary Invalid entries that
// other shows' Express runs had landed minutes earlier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { mergeExpressCompleted } = require('../../scripts/lib/merge-express-completed.js');
const { apiFallbackMergerFor, explicitMergerFor } = require('../../scripts/lib/reconcile-merged-json.js');

const rec = (extra = {}) => ({ firedAt: '2026-10-22T13:42:00Z', ...extra });
const doc = (shows) => ({ shows });

test('a show another Express run added after our fork point survives', () => {
  const base = doc({ old: rec() });
  const remote = doc({ old: rec(), invalid: rec() });
  const ours = doc({ old: rec(), pianist: rec() });
  const { merged, stats } = mergeExpressCompleted(ours, remote, base);
  assert.deepEqual(Object.keys(merged.shows).sort(), ['invalid', 'old', 'pianist']);
  assert.equal(stats.added, 1);
});

test('broadcast fields set on remote after our fork point are kept when we left that show alone', () => {
  const base = doc({ x: rec() });
  const remote = doc({ x: rec({ broadcastDraftedAt: '2026-10-22T14:00:00Z' }) });
  const ours = doc({ x: rec(), y: rec() });
  const { merged, stats } = mergeExpressCompleted(ours, remote, base);
  assert.equal(merged.shows.x.broadcastDraftedAt, '2026-10-22T14:00:00Z');
  assert.ok(merged.shows.y);
  assert.equal(stats.tookRemote, 1);
});

test('a show we changed keeps our record', () => {
  const base = doc({ x: rec() });
  const remote = doc({ x: rec({ note: 'remote' }) });
  const ours = doc({ x: rec({ note: 'ours' }) });
  assert.equal(mergeExpressCompleted(ours, remote, base).merged.shows.x.note, 'ours');
});

test('a show we deleted since the fork point stays deleted', () => {
  const base = doc({ x: rec(), y: rec() });
  const remote = doc({ x: rec(), y: rec() });
  const ours = doc({ x: rec() });
  const { merged, stats } = mergeExpressCompleted(ours, remote, base);
  assert.deepEqual(Object.keys(merged.shows), ['x']);
  assert.equal(stats.deletesHonored, 1);
});

test('no base: union, ours wins on a shared show', () => {
  const ours = doc({ a: rec({ n: 1 }), p: rec() });
  const { merged } = mergeExpressCompleted(ours, doc({ a: rec({ n: 2 }), r: rec() }), undefined);
  assert.deepEqual(Object.keys(merged.shows).sort(), ['a', 'p', 'r']);
  assert.equal(merged.shows.a.n, 1);
  assert.equal(mergeExpressCompleted.requiresTrueBase, true);
});

test('a show both sides changed merges field by field (Express retry vs broadcast draft)', () => {
  const base = doc({ x: rec({ completedAt: 'T1', reviewCount: 9 }) });
  const remote = doc({ x: rec({ completedAt: 'T1', reviewCount: 9, broadcastDraftedAt: 'D', broadcastDraftId: 'id1' }) });
  const ours = doc({ x: rec({ completedAt: 'T2', reviewCount: 14, isRetry: true }) });
  const { merged, stats } = mergeExpressCompleted(ours, remote, base);
  assert.deepEqual(merged.shows.x, rec({ completedAt: 'T2', reviewCount: 14, isRetry: true, broadcastDraftedAt: 'D', broadcastDraftId: 'id1' }));
  assert.equal(stats.fieldMerged, 1);
  // and the reverse direction: we are the broadcast write, remote is the retry
  const r2 = mergeExpressCompleted(remote, ours, base).merged.shows.x;
  assert.equal(r2.completedAt, 'T2');
  assert.equal(r2.reviewCount, 14);
  assert.equal(r2.broadcastDraftId, 'id1');
});

test('both Express files take the API-fallback merge; local path stays additions-only for completed', () => {
  assert.ok(apiFallbackMergerFor('data/audit/express-retry-queue.json'));
  assert.ok(apiFallbackMergerFor('data/audit/opening-night-express-completed.json'));
  const local = explicitMergerFor('data/audit/opening-night-express-completed.json');
  assert.notEqual(local.merge, mergeExpressCompleted);
  const r = local.merge(doc({ a: rec({ n: 1 }) }), doc({ a: rec({ n: 2 }), b: rec() }), doc({ a: rec({ n: 0 }) }));
  assert.deepEqual(r.merged.shows, { a: rec({ n: 1 }), b: rec() });
});

// The CLI push-via-git-api.sh runs for each apiFallbackMerge path, fed the
// same three blobs the 2026-10-22 race produced (fixtures, so a shallow CI
// checkout still runs it).
test('push-via-git-api-merge.js keeps all three shows in both files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'express-api-merge-'));
  try {
    const q = (...ids) => ({ entries: ids.map((id) => ({ showId: id, market: 'broadway', queuedAt: `2026-10-22T0${ids.indexOf(id)}:00:00Z`, dueAt: '2026-10-23T03:15:00Z', attempted: false })) });
    const cases = [
      ['data/audit/express-retry-queue.json', q(), q('queeney', 'invalid'), q('pianist'), (d) => d.entries.map((e) => e.showId)],
      ['data/audit/opening-night-express-completed.json', doc({}), doc({ queeney: rec(), invalid: rec() }), doc({ pianist: rec() }), (d) => Object.keys(d.shows)],
    ];
    for (const [file, base, remote, ours, ids] of cases) {
      const w = (n, v) => { const p = path.join(dir, n); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); return p; };
      const out = execFileSync('node', ['scripts/lib/push-via-git-api-merge.js', file, w('ours', ours), w('remote', remote), w('base', base)], { encoding: 'utf8' });
      assert.deepEqual(ids(JSON.parse(out)).sort(), ['invalid', 'pianist', 'queeney'], file);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
