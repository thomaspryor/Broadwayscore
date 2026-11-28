// BRO-7724 / Sentry 7834294498: history writes must not run in React updaters.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Event: dom.window.Event,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  // Keep below-fold shelves out of this search-focused unit test.
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
  fetch: async (url) => ({
    ok: true,
    json: async () => String(url).includes('homepage-extra')
      ? { offBroadwayShows: [], westEndShows: [], featuredRows: [] } : [],
  }),
};
const previousGlobals = new Map(Object.keys(globals).map(key => [
  key, Object.getOwnPropertyDescriptor(globalThis, key),
]));
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// CommonJS compilation also loads the homepage's lazy imports through the
// same alias resolver. No component, state updater, or search logic is mocked.
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
const { PathnameContext } = require('next/dist/shared/lib/hooks-client-context.shared-runtime');
const HomePageClient = require('../../src/components/HomePageClient.tsx').default;
const { ProGateProvider } = require('../../src/contexts/ProGateContext.tsx');

// RULE21: exercise the real page handlers under React updater replay. No
// filter implementation is duplicated here. StrictMode repeats updaters just
// as an interrupted concurrent render can, but must not repeat history writes.
const pages = [
  ['/', HomePageClient],
  ['/west-end', require('../../src/components/WestEndPageClient.tsx').default],
  ['/off-broadway', require('../../src/components/OffBroadwayPageClient.tsx').default],
  ['/off-west-end', require('../../src/components/OffWestEndPageClient.tsx').default],
  ['/opera', require('../../src/components/OperaPageClient.tsx').default],
  ['/nvp', require('../../src/app/nvp/NVPClient.tsx').default],
];
const { SearchParamsContext } = require('next/dist/shared/lib/hooks-client-context.shared-runtime');
const nativeReplace = window.history.replaceState.bind(window.history);
const shows = [
  { id: 'hamilton-2015', slug: 'hamilton', title: 'Hamilton', venue: 'Richard Rodgers Theatre', openingDate: '2015-08-06', status: 'open', type: 'musical' },
  { id: 'wicked-2003', slug: 'wicked', title: 'Wicked', venue: 'Gershwin Theatre', openingDate: '2003-10-30', status: 'open', type: 'musical' },
  { id: 'the-lion-king-1997', slug: 'the-lion-king', title: 'The Lion King', venue: 'Minskoff Theatre', openingDate: '1997-11-13', status: 'open', type: 'musical' },
].map(show => ({ ...show, audienceCombinedScore: null, audienceGrade: null }));
const props = {
  renderedAt: Date.now(), shows, upcomingShows: [], totalShows: shows.length,
  totalReviews: 0, scoredShows: 0, skipHero: true, skipFirstMusicals: true,
  skipAboveFold: true, offBroadway: [],
  marketOpenCounts: { broadway: 3, broadwayPlus: 3, offBroadway: 0, westEnd: 3, offWestEnd: 0 },
};

after(() => {
  Module._resolveFilename = resolveFilename;
  loader.enabled(false);
  dom.window.close();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

function button(group, prefix) {
  const el = [...document.querySelectorAll(`[role="group"][aria-label="${group}"] button`)]
    .find(el => el.textContent.startsWith(prefix));
  assert.ok(el, `${group}: ${prefix}`);
  return el;
}

async function mount(path, Page) {
  nativeReplace({}, '', `${path}?genre=comedy`);
  localStorage.clear();
  sessionStorage.clear();
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    React.createElement(React.StrictMode, null,
      React.createElement(AppRouterContext.Provider, { value: { replace() {} } },
        React.createElement(PathnameContext.Provider, { value: path },
          React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams(window.location.search) },
            React.createElement(ProGateProvider, null, React.createElement(Page, props)))))),
  ));
  return root;
}

for (const [path, Page] of pages) {
  test(`${path}: two filter actions write twice even when React replays state`, async () => {
    const root = await mount(path, Page);
    const writes = [];
    window.history.replaceState = (state, title, url) => {
      writes.push(String(url));
      nativeReplace(state, title, url);
    };
    try {
      // Batch two updates so the second updater is evaluated during render.
      await act(async () => {
        button('Filter by status', 'CLOSED').click();
        button(path === '/opera' ? 'Sort productions' : 'Sort shows', 'A-Z').click();
      });
      assert.equal(new URLSearchParams(window.location.search).get('status'), 'closed');
      assert.equal(new URLSearchParams(window.location.search).get('sort'), 'alpha');
      if (path !== '/nvp') assert.equal(new URLSearchParams(window.location.search).get('genre'), 'comedy');
      assert.equal(button('Filter by status', 'CLOSED').getAttribute('aria-pressed'), 'true');
      assert.equal(writes.length, 2, `React replay repeated history writes: ${JSON.stringify(writes)}`);
    } finally {
      window.history.replaceState = nativeReplace;
      await act(async () => root.unmount());
    }
  });
}

test('a batched filter burst stays below the reported 100-write history limit', async () => {
  const root = await mount('/', HomePageClient);
  let writes = 0;
  window.history.replaceState = (state, title, url) => {
    if (++writes > 100) {
      throw new window.DOMException(
        'Attempt to use history.replaceState() more than 100 times per 10 seconds', 'SecurityError',
      );
    }
    nativeReplace(state, title, url);
  };
  try {
    await act(async () => {
      for (let i = 0; i < 60; i++) {
        button('Filter by status', i % 2 ? 'ALL' : 'CLOSED').click();
      }
    });
    assert.equal(writes, 60, 'one history write per action, regardless of React replay');
    assert.equal(new URLSearchParams(window.location.search).get('status'), 'all');
    assert.equal(button('Filter by status', 'ALL').getAttribute('aria-pressed'), 'true');
  } finally {
    window.history.replaceState = nativeReplace;
    await act(async () => root.unmount());
  }
});

test('search, an inline filter, and a panel change compose before React commits', async () => {
  const root = await mount('/', HomePageClient);
  const { replaceLocationSearch } = require('../../src/lib/hooks/useLocationSearch');
  try {
    await act(async () => {
      const input = document.getElementById('show-search');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Hamilton');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      // A panel change between inline actions must survive both transitions.
      const live = new URL(window.location.href);
      live.searchParams.delete('genre');
      live.searchParams.set('production', 'original');
      replaceLocationSearch(live.pathname + live.search);
      button('Filter by status', 'ALL').click();
    });
    const params = new URLSearchParams(window.location.search);
    assert.equal(params.get('q'), 'Hamilton');
    assert.equal(params.get('status'), 'all');
    assert.equal(params.get('production'), 'original');
    assert.equal(params.has('genre'), false);
    assert.equal(document.getElementById('show-search').value, 'Hamilton');
    assert.equal(button('Filter by status', 'ALL').getAttribute('aria-pressed'), 'true');
    assert.ok([...document.querySelectorAll('[aria-label="Broadway shows"] h3')]
      .some(el => el.textContent === 'Hamilton'));
  } finally {
    await act(async () => root.unmount());
  }
});

// Class guard: no URL write may sit inside a React state updater anywhere in src/.
const { findHistoryWritesInUpdaters, scanTree } = require('../../scripts/lib/history-writes-in-updaters.js');

test('scanner flags a URL write inside a state updater and ignores event-handler writes', () => {
  const bad = `function A(){ const u = () => setFilters(prev => { replaceLocationSearch('/?a=1'); return prev; }); }`;
  const badRouter = `function A(){ setTab(function (p) { router.replace('/x'); return p; }); }`;
  const good = `function A(){ const u = () => { const next = {}; window.history.replaceState({}, '', '/'); setFilters(next); }; }`;
  assert.equal(findHistoryWritesInUpdaters(bad, 'a.tsx').length, 1);
  assert.equal(findHistoryWritesInUpdaters(badRouter, 'b.tsx').length, 1);
  assert.deepEqual(findHistoryWritesInUpdaters(good, 'c.tsx'), []);
});

test('src/ has no history writes inside React state updaters', () => {
  assert.deepEqual(scanTree(), []);
});

test('replaceLocationSearch skips a write that would not change the URL', () => {
  const { isSameLocation, replaceLocationSearch } = require('../../src/lib/hooks/useLocationSearch');
  assert.equal(isSameLocation('/?a=1', 'http://localhost/?a=1'), true);
  assert.equal(isSameLocation('/?a=2', 'http://localhost/?a=1'), false);
  assert.equal(isSameLocation('/', 'http://localhost/#top'), false);
  nativeReplace({}, '', '/west-end?status=closed');
  let writes = 0;
  window.history.replaceState = (s, t, u) => { writes++; nativeReplace(s, t, u); };
  try {
    for (let i = 0; i < 150; i++) replaceLocationSearch('/west-end?status=closed');
    assert.equal(writes, 0);
    replaceLocationSearch('/west-end?status=all');
    assert.equal(writes, 1);
  } finally {
    window.history.replaceState = nativeReplace;
  }
});
