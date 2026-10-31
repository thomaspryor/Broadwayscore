// BRO-4481 web acceptance checks. Native iOS implementation and verification
// belong in BroadwayScorecard-app and are not covered by this web test.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const unregister = require('tsx/cjs/api').register();
const React = require('react');
const previousReact = globalThis.React;
globalThis.React = React;
after(() => {
  unregister();
  if (previousReact === undefined) delete globalThis.React;
  else globalThis.React = previousReact;
});

const { renderToStaticMarkup } = require('react-dom/server');
const PrivacyPage = require('../../src/app/privacy/page.tsx').default;
const { resolvePlanShows } = require('../../src/lib/shared-plans/resolve.ts');
const { buildSharedPlansView } = require('../../src/lib/shared-plans/view-model.ts');
const { loadSharedPlansWith } = require('../../src/lib/shared-plans/load.ts');
const { buildIcs } = require('../../src/lib/calendar');

test('privacy policy explains opting into a revocable public plans link', () => {
  const html = renderToStaticMarkup(React.createElement(PrivacyPage));
  const plans = html.match(/Watchlist and plans<\/h3><p>(.*?)<\/p>/s)?.[1].replace(/\s+/g, ' ');
  assert.ok(plans, 'Watchlist and plans paragraph is rendered');
  assert.match(plans, /private unless you turn on a shared link/i);
  assert.match(plans, /anyone with the link/i);
  assert.match(plans, /upcoming shows/i);
  assert.match(plans, /dates only, no curtain times/i);
  assert.match(plans, /not-yet-booked watchlist/i);
  assert.match(plans, /without an account/i);
  assert.match(plans, /turning the link off stops access/i);
  assert.match(plans, /previews already sent.*stay visible/i);
});

test('anonymous payload resolves both sections with show links and all-day calendar events', async () => {
  const catalog = [
    { id: 'booked', title: 'Booked show', slug: 'booked-show', venue: 'Theater', status: 'open', category: 'broadway' },
    { id: 'unbooked', title: 'Unbooked show', slug: 'unbooked-show', venue: 'Theatre', status: 'open', category: 'west-end' },
  ];
  const payload = {
    name: 'Friend', showBooked: true, showUnbooked: true,
    entries: [
      { show_id: 'booked', planned_date: '2026-11-01', logged: false },
      { show_id: 'unbooked', planned_date: null, logged: false },
    ],
  };
  const loaded = await loadSharedPlansWith('a'.repeat(32), {
    rpc: async (fn, args) => {
      assert.equal(fn, 'get_shared_plans');
      assert.deepEqual(args, { p_token: 'a'.repeat(32) });
      return { data: payload, error: null };
    },
  });
  assert.equal(loaded.status, 'ok');
  const shows = await resolvePlanShows(payload.entries.map(e => e.show_id), {
    getShow: id => catalog.find(s => s.id === id),
    getDiaryShow: () => null,
    getStubs: async () => new Map(),
  });
  const view = buildSharedPlansView(loaded.payload, shows, Date.parse('2026-10-25T12:00:00Z'));
  assert.deepEqual(view.counts, { booked: 1, unbooked: 1 });
  assert.equal(view.booked[0].href, '/show/booked-show');
  assert.equal(view.unbooked[0].href, '/show/unbooked-show');
  assert.equal(view.booked[0].event.time, null);
  assert.match(buildIcs(view.booked[0].event, { generatedAt: new Date('2026-10-25T12:00:00Z') }),
    /DTSTART;VALUE=DATE:20261101/);
});

test('a token withheld by the public RPC renders as not shared', async () => {
  assert.deepEqual(await loadSharedPlansWith('a'.repeat(32), {
    rpc: async () => ({ data: null, error: null }),
  }), { status: 'not-shared' });
});
