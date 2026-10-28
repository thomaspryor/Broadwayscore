import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');
const React = require('react');
// The app leaves JSX for Next to compile; tsx's Node loader uses classic JSX.
const previousReact = globalThis.React;
globalThis.React = React;
test.after(() => { globalThis.React = previousReact; });
const { renderToStaticMarkup } = require('react-dom/server');
const { JSDOM } = require('jsdom');
const { Poster, PosterGridCard, UpcomingListRow } = require('../../src/components/user/upcoming-cards.tsx');
const VideoReviewsShelf = require('../../src/components/VideoReviewsShelf.tsx').default;
const { getShowImageSrcSet } = require('../../src/lib/images');
const posterUrl = '/images/shows/the-lost-boys-2026/poster.webp';

function renderedImage(component, props) {
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(component, props)));
  const img = dom.window.document.querySelector('img');
  const attrs = img && Object.fromEntries([...img.attributes].map(a => [a.name, a.value]));
  dom.window.close();
  return attrs;
}

test('upcoming list and grid supply their actual slot widths to the shared image', () => {
  const props = { href: null, posterUrl, title: 'The Lost Boys', date: null };
  const list = renderedImage(UpcomingListRow, props);
  assert.equal(list.srcset, getShowImageSrcSet(posterUrl));
  assert.equal(list.sizes, '40px');
  const grid = renderedImage(PosterGridCard, props);
  assert.equal(grid.srcset, getShowImageSrcSet(posterUrl));
  assert.equal(grid.sizes, '(min-width: 768px) 174px, (min-width: 640px) calc((100vw - 72px) / 4), calc((100vw - 48px) / 3)');
});

test('Poster preserves cache versions, external images, missing-image titles and callers without sizes', () => {
  const versioned = `${posterUrl}?v=123abc`;
  assert.equal(renderedImage(Poster, { url: versioned, sizes: '48px' }).srcset, getShowImageSrcSet(versioned));
  const external = 'https://example.com/poster.jpg';
  const img = renderedImage(Poster, { url: external, sizes: '48px' });
  assert.equal(img.src, external);
  assert.equal(img.srcset, undefined);
  assert.equal(renderedImage(Poster, { url: posterUrl }).srcset, undefined);
  assert.equal(renderedImage(Poster, { url: null }), null);
  assert.match(renderToStaticMarkup(React.createElement(Poster, { url: null, title: 'Company' })), /Company/);
});

test('video shelf uses responsive show images while leaving video thumbnails unchanged', () => {
  const review = { creatorName: 'Reviewer', handle: 'reviewer', platform: 'youtube', videoUrl: 'https://www.youtube.com/watch?v=video', score: 80, views: null };
  const local = renderedImage(VideoReviewsShelf, { reviews: [{ ...review, thumbnail: posterUrl }] });
  assert.equal(local.srcset, getShowImageSrcSet(posterUrl));
  assert.equal(local.sizes, '(min-width: 640px) 128px, 112px');
  const url = '/images/video-reviews/tyvid5-11-to-midnight-off-broadway-2026.jpg';
  const video = renderedImage(VideoReviewsShelf, { reviews: [{ ...review, thumbnail: url }] });
  assert.equal(video.src, url);
  assert.equal(video.srcset, undefined);
});

test('Poster retries the original after a variant error, then shows its placeholder and resets for a new URL', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(() => root.render(React.createElement(Poster, { url: posterUrl, sizes: '48px', title: 'The Lost Boys' })));
    assert.equal(document.querySelector('img').getAttribute('srcset'), getShowImageSrcSet(posterUrl));
    await React.act(() => document.querySelector('img').dispatchEvent(new window.Event('error')));
    assert.equal(document.querySelector('img').getAttribute('srcset'), null);
    assert.equal(document.querySelector('img').getAttribute('src'), posterUrl);
    await React.act(() => document.querySelector('img').dispatchEvent(new window.Event('error')));
    assert.equal(document.querySelector('img'), null);
    assert.match(document.body.textContent, /The Lost Boys/);
    const next = '/images/shows/hadestown-west-end-2024/poster.webp';
    await React.act(() => root.render(React.createElement(Poster, { url: next, sizes: '48px' })));
    assert.equal(document.querySelector('img').getAttribute('srcset'), getShowImageSrcSet(next));
  } finally {
    await React.act(() => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test('compare search and stats drilldown pass their 36px and 48px slot sizes', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const show = { id: 'the-lost-boys-2026', slug: 'the-lost-boys', title: 'The Lost Boys', status: 'open', images: { thumbnail: '/images/shows/the-lost-boys-2026/thumbnail.webp' }, posterUrl };
  const globals = {
    window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => ({ ok: true, json: async () => [show] }),
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  window.scrollTo = () => {};
  const { createRoot } = require('react-dom/client');
  const { AppRouterContext } = require('next/dist/shared/lib/app-router-context.shared-runtime');
  const CompareShowPicker = require('../../src/components/CompareShowPicker.tsx').default;
  const StatsDrilldown = require('../../src/components/my-shows/stats/StatsDrilldown.tsx').default;
  const root = createRoot(document.getElementById('root'));
  const wrap = child => React.createElement(AppRouterContext.Provider, { value: { push() {}, prefetch() {} } }, child);
  try {
    await React.act(() => root.render(wrap(React.createElement(CompareShowPicker))));
    const input = document.querySelector('input');
    await React.act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Lost Boys');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    // The real search hook lazily imports Fuse on focus.
    for (let i = 0; !document.querySelector('img') && i < 30; i++) {
      await React.act(() => new Promise(resolve => setTimeout(resolve, 20)));
    }
    assert.equal(document.querySelector('img')?.getAttribute('sizes'), '36px');
    assert.equal(document.querySelector('img').getAttribute('srcset'), getShowImageSrcSet(show.images.thumbnail));
    await React.act(() => root.render(wrap(React.createElement(StatsDrilldown, { payload: { title: 'Shows', shows: [show] }, shows: { [show.id]: show }, onClose() {} }))));
    assert.equal(document.querySelector('[data-testid="stats-drilldown"] img')?.getAttribute('sizes'), '48px');
    assert.equal(document.querySelector('[data-testid="stats-drilldown"] img').getAttribute('srcset'), getShowImageSrcSet(posterUrl));
  } finally {
    await React.act(() => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
