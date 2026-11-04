import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { compareReviewPriority, isShowUncovered } = require('./collection-priority.js');

const base = { isOpenShow: true, fetchAttempts: 0, priority: 3 };

test('a show with no scored review outranks a newer show that already has some (BRO-6972)', () => {
  const wellSee = { ...base, showId: 'well-see', recencyDate: '2026-11-03', showUncovered: true };
  const rope = { ...base, showId: 'rope', recencyDate: '2026-11-04', showUncovered: false };
  const q = [rope, wellSee].sort((a, b) => compareReviewPriority(a, b));
  assert.equal(q[0].showId, 'well-see');
});

test('without the flag the order is unchanged (newest first)', () => {
  const a = { ...base, showId: 'a', recencyDate: '2026-11-03' };
  const b = { ...base, showId: 'b', recencyDate: '2026-11-04' };
  assert.equal([a, b].sort((x, y) => compareReviewPriority(x, y))[0].showId, 'b');
});

test('closed-show mode ignores the flag', () => {
  const a = { ...base, isOpenShow: false, recencyDate: '2001-01-01', showUncovered: true };
  const b = { ...base, isOpenShow: false, recencyDate: '2002-01-01', showUncovered: false };
  assert.equal([a, b].sort((x, y) => compareReviewPriority(x, y, { closedShowMode: true }))[0], b);
});

test('isShowUncovered: scored review files cover a show', () => {
  assert.equal(isShowUncovered([]), true);
  assert.equal(isShowUncovered([{ fullText: 'x' }, null]), true);
  assert.equal(isShowUncovered([{ assignedScore: 78 }]), false);
  assert.equal(isShowUncovered([{ llmScore: { score: 70 } }]), false);
  assert.equal(isShowUncovered([{ assignedScore: null, llmScore: null }]), true);
});

test('markUncoveredShows reads real review dirs (one scored, one empty, one missing)', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { markUncoveredShows } = require('./collection-priority.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  fs.mkdirSync(path.join(root, 'covered')); fs.writeFileSync(path.join(root, 'covered', 'a--b.json'), JSON.stringify({ assignedScore: 80 }));
  fs.mkdirSync(path.join(root, 'fresh')); fs.writeFileSync(path.join(root, 'fresh', 'c--d.json'), JSON.stringify({ fullText: '' }));
  const q = markUncoveredShows([{ showId: 'covered' }, { showId: 'fresh' }, { showId: 'missing' }, { showId: 'fresh' }], root);
  assert.deepEqual(q.map((r) => r.showUncovered), [false, true, true, true]);
});
