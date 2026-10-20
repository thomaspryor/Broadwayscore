import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
// The acceptance command uses plain node, so register TypeScript dependencies here.
require('tsx/cjs');
const ts = require('typescript');
const root = fileURLToPath(new URL('../../', import.meta.url));
const h = React.createElement;
const noop = () => {};

// Require the production components, replacing only auth, network and unrelated UI.
function component(file, mocks = {}) {
  const filename = root + file;
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(root);
  loaded.require = (id) => Object.hasOwn(mocks, id) ? mocks[id] : require(id);
  loaded._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
  return loaded.exports.default;
}

async function mount(t, Component, props) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const originals = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = () => ({ matches: true, addEventListener: noop, removeEventListener: noop });
  const container = dom.window.document.getElementById('root');
  const renderer = createRoot(container);
  t.after(async () => {
    await act(() => renderer.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const render = async (nextProps) => act(() => renderer.render(h(Component, nextProps)));
  await render(props);
  return { container, render, event: async (element, type) => act(() => element.dispatchEvent(new dom.window.Event(type, { bubbles: true }))) };
}

const Link = ({ children, ...props }) => h('a', props, children);
const avatarMocks = {
  'next/link': { default: Link, __esModule: true },
  '@/config/feature-flags': { featureFlags: { userAccounts: true } },
  '@/lib/ugc-analytics': { trackUgc: noop },
  '@/hooks/useLocalWatchlist': { useLocalWatchlist: () => ({ localList: [] }) },
};

for (const file of ['HamburgerMenu', 'HeaderUserIcon']) {
  test(`${file}: failed avatars fall back and a new URL can load`, async (t) => {
    let profile = { avatar_url: '/missing-avatar.png', display_name: 'Theatregoer' };
    const Component = component(`src/components/${file}.tsx`, {
      ...avatarMocks,
      '@/contexts/AuthContext': { useAuth: () => ({ isAuthenticated: true, profile }) },
    });
    const props = () => ({ isAuthenticated: true, profile });
    const view = await mount(t, Component, props());
    const img = view.container.querySelector('img');
    assert.ok(img);
    await view.event(img, 'error');
    assert.equal(view.container.querySelectorAll('img').length, 0, 'broken image must be removed');
    assert.ok(file === 'HamburgerMenu'
      ? view.container.querySelector('button span')?.textContent === 'T'
      : view.container.querySelector('a svg'), 'the menu affordance must remain visible');
    if (file === 'HamburgerMenu') {
      await view.event(view.container.querySelector('[aria-label="Open menu"]'), 'click');
      assert.equal(view.container.querySelectorAll('img').length, 0, 'panel avatar shares the fallback');
      assert.ok(view.container.textContent.includes('Theatregoer'));
    }
    profile = { ...profile, avatar_url: '/replacement-avatar.png' };
    await view.render(props());
    assert.equal(view.container.querySelector('img')?.getAttribute('src'), profile.avatar_url);
    if (file === 'HamburgerMenu') {
      const images = view.container.querySelectorAll('img');
      assert.equal(images.length, 2);
      await view.event(images[1], 'error');
      assert.equal(view.container.querySelectorAll('img').length, 0, 'panel errors also update the trigger');
    }
  });
}

const dateUtils = require('../../src/lib/date-utils');
const RatingEditor = component('src/components/user/RatingEditor.tsx', {
  '@/components/show-cards/Modal': { default: ({ children }) => children, __esModule: true },
  './StarRating': { default: () => null, __esModule: true },
  './DatePickerButton': { default: component('src/components/user/DatePickerButton.tsx'), __esModule: true },
  '@/lib/rating': require('../../src/lib/rating'),
  '@/lib/date-utils': dateUtils,
  '@/lib/ugc-analytics': { trackUgc: noop },
});
const ratingProps = { showTitle: 'A show', initialRating: 4, presentation: 'inline', onSave: async () => {}, onSaved: noop, onCancel: noop };

for (const suggestion of ['10/01/2020', '2020-1-01', '2020-01-01T19:00:00Z', '2020-00-01', '2020-02-31', '2020-13-01']) {
  test(`RatingEditor rejects ${suggestion} on mount and after loading`, async (t) => {
    const view = await mount(t, RatingEditor, { ...ratingProps, suggestedDateSeen: suggestion });
    const input = () => view.container.querySelector('input[type="date"]');
    assert.equal(input().value, dateUtils.localToday());
    assert.ok(!view.container.textContent.includes('Invalid Date'));
    await view.render({ ...ratingProps, suggestedDateSeen: '2020-01-02' });
    assert.equal(input().value, '2020-01-02');
    await view.render({ ...ratingProps, suggestedDateSeen: suggestion });
    assert.equal(input().value, '2020-01-02', 'invalid late data must preserve the current date');
  });
}

test('RatingEditor preserves valid suggestions, future clamping, edits and cleared dates', async (t) => {
  const view = await mount(t, RatingEditor, { ...ratingProps, suggestedDateSeen: '2020-02-29' });
  const input = () => view.container.querySelector('input[type="date"]');
  assert.equal(input().value, '2020-02-29');
  await view.render({ ...ratingProps, suggestedDateSeen: '2999-01-01' });
  assert.equal(input().value, dateUtils.localToday());
  await view.event(view.container.querySelector('[aria-label="Clear date"]'), 'click');
  await view.render({ ...ratingProps, suggestedDateSeen: '2020-01-03' });
  assert.equal(input().value, '', 'a late suggestion must not overwrite a cleared date');
});

test('RatingEditor keeps existing review dates when suggestions arrive', async (t) => {
  const props = { ...ratingProps, reviewId: 'existing', initialDateSeen: '2020-01-04' };
  const view = await mount(t, RatingEditor, props);
  await view.render({ ...props, suggestedDateSeen: '2020-01-03' });
  assert.equal(view.container.querySelector('input[type="date"]').value, '2020-01-04');
});

for (const align of ['left', 'right']) {
  test(`ShowSearchDropdown bounds ${align}-aligned mobile results to its anchor`, async (t) => {
    const results = [{ id: 'long-title', title: 'A very long show title that must truncate inside the inset list card', slug: 'long-title', status: 'open' }];
    const Dropdown = component('src/components/show-cards/ShowSearchDropdown.tsx', {
      '@/hooks/useShowSearch': { useShowSearch: () => ({ query: 'long', results, setQuery: noop, ensureData: noop }) },
      '@/lib/mezzanine-search': {},
    });
    const view = await mount(t, Dropdown, { align, autoFocus: false, onSelect: noop, onClose: noop, renderAction: () => '+ Add' });
    const panel = view.container.querySelector('.absolute.top-full');
    const classes = panel.className.split(/\s+/);
    assert.ok(classes.includes('w-full'));
    assert.ok(classes.includes('max-w-full'), 'mobile panel must be bounded by the anchor width');
    assert.ok(!classes.some((c) => c.startsWith('min-w-')), 'viewport minimums override container bounds');
    assert.ok(classes.includes(align === 'left' ? 'left-0' : 'right-0'));
    assert.ok(view.container.textContent.includes(results[0].title));
    for (const caller of ['src/app/my-shows/MyShowsClient.tsx', 'src/app/my-shows/ListsTab.tsx']) {
      assert.match(readFileSync(root + caller, 'utf8'), /<ShowSearchDropdown\b/);
    }
  });
}
