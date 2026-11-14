import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { announcedShowIds, loadSentShows, isNotableRevival } = createRequire(import.meta.url)('./newsletter-announced.js');

test('only a SENT opening-night broadcast counts as announced', () => {
  const sent = {
    'a-few-good-men-2026': { draftId: 'd1', draftStatus: 'sent', completed: true, sentAt: '2026-10-30T13:00:00Z' },
    'broadway:a-few-good-men-2026': { draftId: 'd1', draftStatus: 'sent', completed: true },
    'waiting-show': { draftId: 'd2', draftStatus: 'draft', completed: false },
    'cancelled-show': { draftId: 'd3', draftStatus: 'cancelled' },
    'push:push-only-show': { sentAt: '2026-10-30T13:00:00Z' },
  };
  const ids = ['a-few-good-men-2026', 'waiting-show', 'cancelled-show', 'push-only-show', 'never-drafted'];
  assert.deepEqual([...announcedShowIds(sent, ids)], ['a-few-good-men-2026']);
});

test('fails open: no ledger means nothing announced', () => {
  assert.equal(announcedShowIds(null, ['x']).size, 0);
  assert.deepEqual(loadSentShows('/nonexistent-dir'), {});
});

test('notable revival = OB revival whose title has played Broadway', () => {
  const all = [
    { id: 'in-the-heights-2008', title: 'In the Heights', category: 'broadway' },
    { id: 'in-the-heights-off-broadway-2026', title: 'In the Heights', category: 'off-broadway', isRevival: true },
    { id: 'aftermath', title: 'Aftermath', category: 'off-broadway', isRevival: true },
    { id: 'the-heart', title: 'The Heart', category: 'off-broadway' },
  ];
  assert.equal(isNotableRevival(all[1], all), true);
  assert.equal(isNotableRevival(all[2], all), false, 'revival with no Broadway history');
  assert.equal(isNotableRevival(all[3], all), false, 'not a revival');
});
