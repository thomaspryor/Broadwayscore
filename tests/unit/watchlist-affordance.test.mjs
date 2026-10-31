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
const { JSDOM } = require('jsdom');
const { AddShowCard } = require('../../src/components/show-cards/AddShowCard.tsx');
const browser = new JSDOM('', { pretendToBeVisual: true });
const previousBrowserGlobals = {
  document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  requestAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame'),
};
Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.window.document });
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  configurable: true, writable: true, value: browser.window.requestAnimationFrame.bind(browser.window),
});
after(() => {
  browser.window.close();
  for (const [key, descriptor] of Object.entries(previousBrowserGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

function render(variant, context = 'watchlist') {
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(AddShowCard, {
    context, variant, onOpen() {},
  })));
  const button = dom.window.document.querySelector('button');
  dom.window.close();
  return button;
}

test('grid and list offer the same clearly labeled add action', () => {
  for (const variant of ['grid', 'list']) {
    const button = render(variant);
    assert.equal(button.type, 'button');
    assert.equal(button.getAttribute('aria-label'), 'Add a new show to watchlist');
    assert.equal(button.textContent.trim(), 'Add a show');
    assert.ok(button.classList.contains('card-interactive'), 'use the shared filled card treatment');
    assert.ok(button.classList.contains('focus-ring'), 'keyboard focus must be visible');
    assert.doesNotMatch(button.className, /border-dashed|text-gray-500/);
    assert.equal(button.querySelector('svg').getAttribute('aria-hidden'), 'true');
  }
  assert.equal(render('grid').querySelector('svg').outerHTML, render('list').querySelector('svg').outerHTML);
  assert.equal(render('grid').querySelector('span').outerHTML, render('list').querySelector('span').outerHTML);
});

test('list stays a full-width touch target and grid keeps its poster proportions', () => {
  const list = render('list');
  assert.ok(list.classList.contains('w-full'));
  assert.ok(list.classList.contains('min-h-[72px]'), 'list action must remain taller than the 44px touch minimum');
  const grid = render('grid');
  assert.ok(grid.classList.contains('aspect-[2/3]'));
  assert.ok(grid.classList.contains('self-start'), 'do not stretch to the neighboring poster title');
});

for (const variant of ['grid', 'list']) {
  test(`${variant} opens search then reveals and focuses the mounted input`, (t) => {
    const calls = [];
    let frame;
    let input;
    t.mock.method(globalThis, 'requestAnimationFrame', callback => { frame = callback; });
    t.mock.method(globalThis.document, 'querySelector', selector => {
      assert.equal(selector, 'input[placeholder^="Search to"]');
      return input;
    });
    const button = AddShowCard({ context: 'watchlist', variant, onOpen: () => calls.push('open') });
    button.props.onClick();
    assert.deepEqual(calls, ['open']);
    input = {
      scrollIntoView: options => calls.push(['scroll', options]),
      focus: options => calls.push(['focus', options]),
    };
    frame();
    assert.deepEqual(calls, [
      'open',
      ['scroll', { behavior: 'smooth', block: 'center' }],
      ['focus', { preventScroll: true }],
    ]);
    input = null;
    assert.doesNotThrow(() => frame(), 'closing search before the frame must be harmless');
  });
}

test('the shared diary action retains its rating label', () => {
  for (const variant of ['grid', 'list']) {
    const button = render(variant, 'diary');
    assert.equal(button.getAttribute('aria-label'), 'Rate a new show');
    assert.equal(button.textContent.trim(), 'Rate a show');
  }
});
