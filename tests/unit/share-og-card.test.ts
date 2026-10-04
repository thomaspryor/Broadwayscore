/**
 * Private share link preview cards (src/lib/share-links/og-card.tsx,
 * BRO-4566). Satori can answer 200 with an EMPTY body on a layout mistake
 * (see api-og-renders.test.ts), so check the body size, for the shared card,
 * the plans wrapper and the generic card.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

// tsconfig's "jsx": "preserve" leaves tsx on the classic transform.
(globalThis as { React?: typeof React }).React = React;
const shareP = import('../../src/lib/share-links/og-card');
const plansP = import('../../src/lib/shared-plans/og-card');

async function pngSize(r: Response): Promise<number> {
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  return buf.length;
}

test('renderShareCard renders a non-empty PNG (no posters, long title)', async () => {
  const { renderShareCard } = await shareP;
  const size = await pngSize(await renderShareCard({ title: `${'W'.repeat(30)}’s theater diary`, summary: '312 shows seen', posterUrls: [null, null] }));
  assert.ok(size > 5000, `PNG only ${size} bytes`);
});

test('plans card goes through the shared card', async () => {
  const { renderPlansCard, PLANS_OG_SIZE } = await plansP;
  const { SHARE_OG_SIZE } = await shareP;
  assert.equal(PLANS_OG_SIZE, SHARE_OG_SIZE);
  const view = { name: 'Tom', counts: { booked: 2, unbooked: 1 }, booked: [], unbooked: [] } as never;
  assert.ok(await pngSize(await renderPlansCard(view)) > 5000);
});

test('generic card renders', async () => {
  const { renderGenericShareCard } = await shareP;
  assert.ok(await pngSize(await renderGenericShareCard()) > 3000);
});

test('diary card input never carries note text, even with notes shared', async () => {
  const { diaryCardInput } = await import('../../src/lib/shared-diary/og-card');
  const view = {
    name: 'Chris', showText: true, capped: false, showsSeen: 1, recentPosters: ['/p.jpg'],
    groups: [{ year: '2025', entries: [{ showId: 'x', title: 'X', href: '/show/x', posterUrl: '/p.jpg', venue: 'V', date: '2025-01-02', dateLabel: 'Jan 2', rating: 4, text: 'SECRET NOTE' }] }],
  };
  const input = diaryCardInput(view);
  assert.deepEqual(input, { title: 'Chris’ theater diary', summary: '1 show seen', posterUrls: ['/p.jpg'] });
  assert.ok(!JSON.stringify(input).includes('SECRET'));
});
