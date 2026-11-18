// RULE21: history writes must not be replayed by React state updaters.
// Exercise the real filter pages in StrictMode, with published show data.
import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Event: dom.window.Event,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
  // Archive and shelf loading are unrelated to history writes. Keep this offline.
  fetch: async url => ({ ok: true, json: async () => String(url).includes('homepage-extra')
    ? { offBroadwayShows: [], westEndShows: [], featuredRows: [] } : [] }),
};
const previousGlobals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// Register before loading app modules so the automatically collected plain-node
// batch can execute this file as well as the card's tsx acceptance command.
const loader = require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', moduleResolution: 'node', jsx: 'react-jsx' },
});
const Module = require('node:module');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (id, ...args) {
  return resolveFilename.call(this, id.startsWith('@/')
    ? fileURLToPath(new URL(`../../src/${id.slice(2)}`, import.meta.url)) : id, ...args);
};
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { AppRouterContext } = require('next/dist/shared/lib/app-router-context.shared-runtime');
const { PathnameContext, SearchParamsContext } = require('next/dist/shared/lib/hooks-client-context.shared-runtime');
const { ProGateProvider } = require('../../src/contexts/ProGateContext.tsx');
const { replaceLocationSearch } = require('../../src/lib/hooks/useLocationSearch');
const pages = [
  ['/', 'broadway', require('../../src/components/HomePageClient.tsx').default],
  ['/west-end', 'west-end', require('../../src/components/WestEndPageClient.tsx').default],
  ['/off-broadway', 'off-broadway', require('../../src/components/OffBroadwayPageClient.tsx').default],
  ['/off-west-end', 'off-west-end', require('../../src/components/OffWestEndPageClient.tsx').default],
  ['/opera', 'opera', require('../../src/components/OperaPageClient.tsx').default],
  ['/nvp', 'broadway', require('../../src/app/nvp/NVPClient.tsx').default],
];
const published = JSON.parse(readFileSync(new URL('../../public/data/mobile-shows.json', import.meta.url))).shows;
function realShows(category) {
  const pool = published.filter(s => category === 'opera' ? s.ty === 'opera' : (s.cat || 'broadway') === category);
  // Normal, boundary and missing-score cases from the actual public export.
  const selected = [...new Set([
    pool.find(s => s.st === 'open' && s.cr),
    pool.find(s => s.st === 'closed' && s.cr),
    pool.find(s => !s.cr),
  ].filter(Boolean))];
  assert.equal(selected.length, 3, `need three real cases for ${category}`);
  return selected.map(s => ({
    id: s.id, slug: s.s, title: s.t, venue: s.v, status: s.st, type: s.ty,
    openingDate: s.od, category: s.cat, isRevival: false,
    criticScore: s.cr ? { score: s.cr.s, reviewCount: s.cr.rc, tier1Count: s.cr.t1, tier2Count: s.cr.t2 } : null,
    audienceCombinedScore: null, audienceGrade: null, audienceHasEnoughReviews: false,
  }));
}

const nativeReplace = window.history.replaceState;
let root;
let writes = [];
let errors = [];
const consoleError = console.error;
async function mount(path, category, Page, query = '') {
  nativeReplace.call(window.history, {}, '', path + query);
  localStorage.clear();
  sessionStorage.clear();
  const shows = realShows(category);
  writes = [];
  errors = [];
  console.error = (...args) => errors.push(args.map(String).join(' '));
  window.history.replaceState = function (...args) {
    writes.push(String(args[2]));
    if (writes.length > 100) throw new dom.window.DOMException(
      'Attempt to use history.replaceState() more than 100 times per 10 seconds', 'SecurityError');
    return nativeReplace.apply(this, args);
  };
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    React.createElement(React.StrictMode, null,
      React.createElement(AppRouterContext.Provider, { value: { replace() {}, prefetch() {} } },
        React.createElement(PathnameContext.Provider, { value: path },
          React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams(query) },
            React.createElement(ProGateProvider, null, React.createElement(Page, {
              shows, renderedAt: Date.now(), totalShows: shows.length, totalReviews: 0, scoredShows: 2,
              upcomingShows: [], offBroadway: [], skipHero: true, skipFirstMusicals: true, skipAboveFold: true,
              marketOpenCounts: { broadway: 1, broadwayPlus: 1, offBroadway: 1, westEnd: 1, offWestEnd: 1 },
            }))))))));
  return shows;
}
function button(label, prefix = false) {
  const found = [...document.querySelectorAll('button')].find(el => prefix
    ? el.textContent.trim().startsWith(label) : el.textContent.trim() === label);
  assert.ok(found, `missing button ${label}`);
  return found;
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = undefined;
  console.error = consoleError;
  window.history.replaceState = nativeReplace;
});
after(() => {
  Module._resolveFilename = resolveFilename;
  loader.enabled(false);
  dom.window.close();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

for (const [path, category, Page] of pages) {
  test(`${path}: one history write per filter action, even when React replays renders`, async t => {
    const shows = await mount(path, category, Page);
    const visible = [];
    for (const label of ['CLOSED', 'ALL', 'PLAYING']) {
      await act(async () => button(label).click());
      visible.push([...document.querySelectorAll('h3')].map(el => el.textContent)
        .filter(title => shows.some(s => s.title === title)));
    }
    t.diagnostic(`${path}: ${shows.map(s => s.title).join(', ')}; 3 actions -> ${writes.length} writes`);
    t.diagnostic(`RESULTS ${path}: ${JSON.stringify(visible)}`);
    assert.equal(writes.length, 3, 'React must not replay history mutations from a state updater');
    assert.deepEqual(errors, [], 'URL notifications must happen outside rendering');
  });

  test(`${path}: same-tick filters compose with the live URL and keep deep links`, async () => {
    await mount(path, category, Page, '?status=closed&sort=alpha&ref=shared');
    await act(async () => {
      button('PLAYING').click();
      button('NEWEST', true).click();
    });
    const params = new URLSearchParams(window.location.search);
    assert.equal(params.get('status'), path === '/nvp' ? 'playing' : path === '/opera' ? 'now_playing' : null);
    assert.equal(params.get('sort'), ['/nvp', '/off-west-end'].includes(path) ? 'recent' : null);
    // NVP has always rebuilt its query from its own filter keys.
    if (path !== '/nvp') assert.equal(params.get('ref'), 'shared');
    assert.equal(writes.length, 2, 'batched actions must each write only once');
    assert.deepEqual(errors, []);
  });
}

test('a burst of filter actions stays below the reported Safari history limit', async () => {
  const [path, category, Page] = pages[0];
  await mount(path, category, Page);
  for (let i = 0; i < 60; i++) {
    await act(async () => button(i % 2 ? 'PLAYING' : 'CLOSED').click());
  }
  assert.equal(writes.length, 60);
  assert.deepEqual(errors, []);
});

test('unchanged URLs do not consume Safari history quota or notify subscribers', () => {
  nativeReplace.call(window.history, {}, '', '/?q=Hadestown');
  let count = 0;
  let notifications = 0;
  window.history.replaceState = function (...args) { count++; return nativeReplace.apply(this, args); };
  const onChange = () => notifications++;
  window.addEventListener('bsc:location-search', onChange);
  try {
    for (let i = 0; i < 150; i++) replaceLocationSearch('/?q=Hadestown');
    assert.equal(count, 0);
    assert.equal(notifications, 0);
    replaceLocationSearch('/west-end?q=Hadestown#search');
    assert.equal(window.location.pathname, '/west-end');
    assert.equal(window.location.hash, '#search');
    assert.equal(count, 1);
    assert.equal(notifications, 1);
  } finally {
    window.removeEventListener('bsc:location-search', onChange);
  }
});
