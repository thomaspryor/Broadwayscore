// BRO-5188: exercise the real homepage's focus and input lifecycle offline.
// Native pointer hit testing and mobile taps live in tests/e2e/homepage.spec.ts.
import test, { after, afterEach, beforeEach } from 'node:test';
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

const shows = ['Hamilton', 'Wicked', 'The Lion King'].map((title, index) => ({
  id: `show-${index}`, slug: `show-${index}`, title, venue: `Theatre ${index}`,
  openingDate: '2020-01-01', status: 'open', type: 'musical',
  audienceCombinedScore: null, audienceGrade: null,
}));
const props = {
  renderedAt: Date.now(), shows, upcomingShows: [], totalShows: shows.length,
  totalReviews: 0, skipHero: true, skipFirstMusicals: true,
  marketOpenCounts: { broadway: 3, broadwayPlus: 3, offBroadway: 0 },
};
let root;

beforeEach(async () => {
  window.history.replaceState({}, '', '/');
  localStorage.clear();
  sessionStorage.clear();
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    React.createElement(AppRouterContext.Provider, { value: { replace() {} } },
      React.createElement(PathnameContext.Provider, { value: '/' },
        React.createElement(ProGateProvider, null, React.createElement(HomePageClient, props)))),
  ));
});
afterEach(async () => { await act(async () => root.unmount()); });
after(() => {
  Module._resolveFilename = resolveFilename;
  loader.enabled(false);
  dom.window.close();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

async function type(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(input.value, value, 'echo the keystroke before deferred results finish rendering');
  });
}

test('the homepage renders an enabled, labeled search input with no closed-modal backdrop', () => {
  const input = document.getElementById('show-search');
  assert.ok(input);
  assert.equal(input.type, 'search');
  assert.equal(input.disabled, false);
  assert.equal(input.readOnly, false);
  assert.ok(input.tabIndex >= 0);
  assert.equal(input.labels[0].textContent, 'Search Broadway shows');
  assert.equal(document.querySelector('[role="dialog"], [aria-modal="true"]'), null);
  const icon = document.querySelector('#search svg[aria-hidden="true"]');
  assert.ok(icon.parentElement.classList.contains('pointer-events-none'));
  input.focus();
  assert.equal(document.activeElement, input);
});

test('typing searches the real show list and retains the same focused input', async () => {
  const input = document.getElementById('show-search');
  input.focus();
  for (const query of ['Hamilton', 'Wicked', 'The Lion King']) {
    await type(input, query);
    assert.equal(input.value, query);
    assert.equal(document.getElementById('show-search'), input);
    assert.equal(document.activeElement, input);
    assert.equal(new URLSearchParams(window.location.search).get('q'), query);
    const titles = [...document.querySelectorAll('[aria-label="Broadway shows"] h3')]
      .map(el => el.textContent);
    assert.equal(titles[0], query, 'search must update results, not just echo the input');
    assert.equal(document.querySelector('[role="dialog"]'), null, 'search must not open an email gate');
  }
});

test('rapid input and clearing keep focus and restore the unfiltered list', async () => {
  const input = document.getElementById('show-search');
  input.focus();
  for (const value of ['H', 'Ha', 'Ham', 'Hami', 'Hamil', 'Hamilton', '']) {
    await type(input, value);
    assert.equal(input.value, value);
    assert.equal(document.activeElement, input);
  }
  assert.equal(new URLSearchParams(window.location.search).has('q'), false);
  assert.equal(document.querySelectorAll('[aria-label="Broadway shows"] h3').length, shows.length);
});
