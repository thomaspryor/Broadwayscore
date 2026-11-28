// BRO-4408: replay-pending-bylines must reach a fresh opening-night strand
// before re-fetching old no-byline strands that ate the 4-minute budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pendingFileTimestamp, orderPendingWork } = require('./pending-drain-order.js');

test('timestamp is the later of firstSeenAt and publishDate; none sorts last', () => {
  assert.equal(pendingFileTimestamp({ publishDate: '2026-09-29', firstSeenAt: '2026-09-30T02:00:00Z' }), Date.parse('2026-09-30T02:00:00Z'));
  assert.equal(pendingFileTimestamp({ publishDate: '2026-09-29T22:00:00Z' }), Date.parse('2026-09-29T22:00:00Z'));
  assert.equal(pendingFileTimestamp({ publishDate: null }), 0);
  assert.equal(pendingFileTimestamp({ publishDate: 'not a date' }), 0);
  assert.equal(pendingFileTimestamp(null), 0);
});

test('the show with the newest strand goes first, newest file first', () => {
  const t = s => Date.parse(s);
  const plan = orderPendingWork([
    { showId: 'kramerfauci-2026', files: [{ file: 'venue--a.json', ts: t('2026-09-10') }, { file: 'venue--b.json', ts: 0 }] },
    { showId: 'fish-2026', files: [{ file: 'thr--old.json', ts: t('2025-01-01') }] },
    { showId: 'degenerates-2026', files: [
      { file: 'old--x.json', ts: t('2026-09-01') },
      { file: 'thewrap--4ae4c586.json', ts: t('2026-09-29T22:00:00Z') },
    ] },
  ]);
  assert.deepEqual(plan.map(s => s.showId), ['degenerates-2026', 'kramerfauci-2026', 'fish-2026']);
  assert.deepEqual(plan[0].files, ['thewrap--4ae4c586.json', 'old--x.json']);
  assert.deepEqual(plan[1].files, ['venue--a.json', 'venue--b.json']);
});

test('ties keep the caller order (shows) and name order (files)', () => {
  const plan = orderPendingWork([
    { showId: 'b', files: [{ file: 'z.json', ts: 0 }, { file: 'a.json', ts: 0 }] },
    { showId: 'a', files: [] },
  ]);
  assert.deepEqual(plan, [{ showId: 'b', files: ['a.json', 'z.json'] }, { showId: 'a', files: [] }]);
});
