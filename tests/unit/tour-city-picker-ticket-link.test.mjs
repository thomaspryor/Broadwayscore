import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('node:module');
// Install the compiler explicitly so the card's plain-node command works on Node 20.
const loader = require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', moduleResolution: 'node', jsx: 'react-jsx' },
});
const resolve = Module._resolveFilename;
const load = Module._load;
Module._resolveFilename = function (id, ...args) {
  return resolve.call(this, id.startsWith('@/')
    ? fileURLToPath(new URL(`../../src/${id.slice(2)}`, import.meta.url)) : id, ...args);
};
const show = { id: 'test-tour', slug: 'test-tour', title: 'Test Tour', status: 'open', category: 'tour', type: 'musical', images: {} };
const closedShow = { ...show, id: 'closed-tour', status: 'closed' };
const shows = [show, closedShow];
const stops = [
  { showId: show.id, city: 'Chicago, IL', venue: 'Current venue', start: '2000-01-01', end: '2099-01-01', show },
  { showId: show.id, city: 'Chicago, IL', venue: 'Future venue', start: '2099-02-01', end: '2099-03-01', show },
  { showId: show.id, city: 'Chicago, IL', venue: 'Not on sale', start: '2099-04-01', end: '2099-05-01', show },
  { showId: show.id, city: 'Chicago, IL', venue: 'Different city only', start: '2099-06-01', end: '2099-07-01', show },
  { showId: closedShow.id, city: 'Chicago, IL', venue: 'Closed tour', start: '2099-08-01', end: '2099-09-01', show: closedShow },
];
const ticketFile = { tours: {
  [show.id]: [
    { ...stops[0], onSale: true, url: 'https://www.todaytix.com/chicago/shows/111-current' },
    { ...stops[1], onSale: true, url: 'https://www.todaytix.com/chicago/shows/222-future' },
    { ...stops[2], onSale: false, url: 'https://www.todaytix.com/chicago/shows/333-unavailable' },
    { ...stops[3], city: 'Boston, MA', onSale: true, url: 'https://www.todaytix.com/boston/shows/444-other-city' },
  ],
  [closedShow.id]: [{ ...stops[4], onSale: true, url: 'https://www.todaytix.com/chicago/shows/555-closed' }],
} };
const config = { slug: 'broadway-national-tours', title: 'National Tours', source: 'tour', relatedPages: [] };
function BrowseListClient() { return null; }
// Replace data boundaries only: run the actual page serializer, ticket lookup,
// city agenda, picker, and TicketLink. No private files are needed in CI.
Module._load = function (id, ...args) {
  if (id === '@/lib/data-core') return { getBrowseList: () => ({ config, shows }), getShowById: () => undefined };
  if (id === '@/lib/data-grosses') return { getShowGrosses: () => null };
  if (id === '@/lib/serialize-show') return { serializeShowForClient: s => s };
  if (id === '@/lib/data-tour-cities') return { getTourCities: () => new Map([['chicago-il', { slug: 'chicago-il', city: 'Chicago, IL', stops, upcomingListed: 2 }]]) };
  if (id.endsWith('/tour-tickets.json')) return ticketFile;
  if (id.endsWith('/tour-schedules.json')) return { tours: {} };
  if (id === '@/components/BrowseListClient') return { __esModule: true, default: BrowseListClient };
  if (id === '@/components/FeaturedRowServer') return { __esModule: true, default: () => null };
  if (id === '@/lib/markets') return { isCategoryEnabled: () => true };
  return load.call(this, id, ...args);
};
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { JSDOM } = require('jsdom');
const BrowsePage = require('../../src/app/browse/[slug]/page.tsx').default;
const Picker = require('../../src/components/TourCityPicker.tsx').default;
const { buildAffiliateUrl } = require('../../src/lib/affiliate-utils');
after(() => { Module._load = load; Module._resolveFilename = resolve; loader.enabled(false); });

function findBrowseProps(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === BrowseListClient) return node.props;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = findBrowseProps(child);
    if (found) return found;
  }
}
async function pageProps() {
  return findBrowseProps(await BrowsePage({ params: Promise.resolve({ slug: config.slug }) }));
}

test('browse page passes stop-specific on-sale URLs and excludes unavailable, other-city and closed-tour tickets', async () => {
  const props = await pageProps();
  assert.deepEqual(props.tourCities[0].stops.map(s => s.ticketUrl), [
    ticketFile.tours[show.id][0].url, ticketFile.tours[show.id][1].url, undefined, undefined, undefined,
  ]);
});

test('selecting Chicago renders real TicketLink anchors in Playing now and Coming rows', async t => {
  const props = await pageProps();
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, self: dom.window, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [k, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, k, descriptor); else delete globalThis[k]; }
  });
  await act(async () => root.render(React.createElement(Picker, { cities: props.tourCities, shows: props.shows })));
  await act(async () => document.querySelector('a[href="/tours/chicago-il"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
  const links = [...document.querySelectorAll('a')].filter(a => a.textContent === 'Tickets ↗');
  assert.equal(links.length, 2);
  assert.match(document.body.textContent, /Playing now/);
  assert.match(document.body.textContent, /Coming to Chicago/);
  for (const [i, link] of links.entries()) {
    assert.equal(link.href, buildAffiliateUrl(ticketFile.tours[show.id][i].url, 'TodayTix', 'browse').url);
    assert.equal(link.target, '_blank');
    assert.ok(link.rel.includes('noopener'));
    assert.ok(link.closest('li').textContent.includes(stops[i].venue));
    assert.ok(link.classList.contains('flex-shrink-0'));
    assert.ok(link.classList.contains('whitespace-nowrap'));
    assert.ok(link.closest('li').querySelector(`a[href="/show/${show.slug}"]`));
  }
});
