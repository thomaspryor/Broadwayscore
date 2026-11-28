// BRO-2762: fixed server ordering must acknowledge an already-active click.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createSortToggle } = require('../../src/lib/sort-toggle.js');
const toggle = createSortToggle({ score: 'score_asc', alpha: 'alpha_desc' });

test('customSort Default keeps its curated order and explains an active click', () => {
  assert.equal(toggle.getNextSort('custom', 'custom'), 'custom');
  assert.equal(toggle.getFixedSortTitle('custom', 'custom', 'Default'),
    'Sorted by Default. This order is fixed.');
  assert.equal(toggle.getFixedSortTitle('custom', 'score_asc', 'Default'),
    'Click to sort by Default');
});

test('fixed-order siblings explain their active state too', () => {
  for (const [value, label] of Object.entries({ newest: 'Newest', oldest: 'Oldest', closing: 'Closing', performances: 'Longest' })) {
    assert.equal(toggle.getNextSort(value, value), value);
    assert.equal(toggle.getFixedSortTitle(value, value, label), `Sorted by ${label}. This order is fixed.`);
  }
});

test('reversible sorts keep toggling and never claim to be fixed', () => {
  for (const [base, reversed] of Object.entries(toggle.pairs)) {
    assert.equal(toggle.getNextSort(base, base), reversed);
    assert.equal(toggle.getNextSort(base, reversed), base);
    assert.equal(toggle.getFixedSortTitle(base, base, base), undefined);
    assert.equal(toggle.getFixedSortTitle(base, reversed, base), undefined);
  }
});

const Module = require('node:module');
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
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { JSDOM } = require('jsdom');
const { ToggleBar } = require('../../src/components/show-cards/ToggleBar.tsx');
// Only the card presentation is replaced. Exercise the real client, sort
// helper, ToggleBar, React state, and click listeners without auth services.
Module._load = function (id, ...args) {
  if (id === '@/components/show-cards') return {
    ToggleBar,
    ShowListCard: ({ show }) => React.createElement('article', { 'data-show-id': show.id }),
  };
  return load.call(this, id, ...args);
};
const BrowseListClient = require('../../src/components/BrowseListClient.tsx').default;
after(() => { Module._load = load; Module._resolveFilename = resolve; loader.enabled(false); });

test('clicking the real active Default button displays confirmation and preserves server order', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [k, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, k, descriptor); else delete globalThis[k]; }
  });
  await act(async () => root.render(React.createElement(BrowseListClient, {
    shows: ['Zebra', 'Apple', 'Middle'].map(title => ({ id: title, title, type: 'play', status: 'open', audienceCombinedScore: null })),
    defaultSort: 'custom', availableSorts: ['custom', 'score', 'alpha', 'newest'],
    showRanks: false, isMixedType: false, isMixedStatus: false,
    hasPerformanceData: false, showTypeFilter: false, showScoreToggle: false,
  })));
  const button = value => [...document.querySelectorAll('[aria-label="Sort shows"] button')].find(b => b.textContent.trim().startsWith(value));
  const ids = () => [...document.querySelectorAll('[data-show-id]')].map(el => el.dataset.showId);
  assert.equal(button('Default').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('[role="status"]')?.textContent ?? '', '');
  await act(async () => button('Default').click());
  assert.equal(document.querySelector('[role="status"]')?.textContent, 'Sorted by Default. This order is fixed.');
  assert.deepEqual(ids(), ['Zebra', 'Apple', 'Middle']);
  await act(async () => button('Default').click());
  assert.equal(document.querySelector('[role="status"]')?.textContent, 'Sorted by Default. This order is fixed.');
  await act(async () => button('A-Z').click());
  assert.deepEqual(ids(), ['Apple', 'Middle', 'Zebra']);
  assert.equal(document.querySelector('[role="status"]')?.textContent ?? '', '');
  await act(async () => button('A-Z').click());
  assert.deepEqual(ids(), ['Zebra', 'Middle', 'Apple']);
  await act(async () => button('Default').click());
  assert.deepEqual(ids(), ['Zebra', 'Apple', 'Middle']);
  assert.equal(document.querySelector('[role="status"]')?.textContent, 'Sorted by Default. This order is fixed.');
  await act(async () => button('Newest').click());
  assert.equal(document.querySelector('[role="status"]')?.textContent, 'Sorted by Newest. This order is fixed.');
});
