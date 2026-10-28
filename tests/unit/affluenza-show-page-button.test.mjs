// BRO-5189: exercise the actual show-page controls, including their listeners.
// Synthetic public-shaped props keep the acceptance command independent of
// private core data. No handler or decision logic is reimplemented here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const loader = require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: {
    module: 'Node16', moduleResolution: 'Node16', target: 'ES2022',
    jsx: 'react-jsx', allowJs: true,
  },
});
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (id, ...args) {
  return resolveFilename.call(this, id.startsWith('@/')
    ? fileURLToPath(new URL(`../../src/${id.slice(2)}`, import.meta.url))
    : id, ...args);
};
// Supabase's GoTrueClient opens a BroadcastChannel that keeps Node alive after
// the tests pass, so the acceptance command never exits. Track and close them.
const channels = [];
const NativeBroadcastChannel = globalThis.BroadcastChannel;
if (NativeBroadcastChannel) {
  globalThis.BroadcastChannel = class extends NativeBroadcastChannel {
    constructor(...args) { super(...args); channels.push(this); }
  };
}
after(() => {
  Module._resolveFilename = resolveFilename;
  loader.enabled(false);
  channels.forEach(c => c.close());
  if (NativeBroadcastChannel) globalThis.BroadcastChannel = NativeBroadcastChannel;
});

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { AppRouterContext } = require('next/dist/shared/lib/app-router-context.shared-runtime');
const { JSDOM } = require('jsdom');
// ts-node's require hook compiles these components under CI's Node 20 too.
const Hero = require('../../src/components/show-page/ShowHeroRedesign').default;
const ReviewsList = require('../../src/components/ReviewsList').default;
const TicketCTA = require('../../src/components/ShowPageTicketCTA.jsx').default;
const { AuthProvider } = require('../../src/contexts/AuthContext');
const { sortTicketLinks } = require('../../src/lib/ticket-utils');
const { LIST_KEY } = require('../../src/lib/local-watchlist');

const show = {
  id: 'affluenza-off-west-end-2026', title: 'Affluenza',
  slug: 'affluenza-off-west-end', category: 'off-west-end',
  status: 'open', type: 'play', venue: 'Riverside Studios',
  openingDate: '2026-10-05', closingDate: '2026-11-28',
  images: {},
  ticketLinks: [{
    platform: 'TodayTix',
    url: 'https://www.todaytix.com/london/shows/47279-affluenza',
    priceFrom: 25,
  }],
};

async function mount(t, component) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: `https://broadwayscorecard.com/show/${show.slug}`,
    pretendToBeVisual: true,
  });
  const globals = {
    window: dom.window, self: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const errors = [];
  dom.window.addEventListener('error', e => errors.push(e.error));
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.scrollTo = () => {}; // jsdom has no viewport scrolling.
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    assert.deepEqual(errors, [], 'click handlers must not throw browser errors');
  });
  const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} };
  await act(async () => root.render(
    React.createElement(AppRouterContext.Provider, { value: router },
      React.createElement(AuthProvider, null, component)),
  ));
  return dom.window.document;
}

async function click(button) {
  assert.ok(button, 'the expected CTA must render');
  assert.equal(button.disabled, false);
  await act(async () => button.click());
}

test('Affluenza Want to See and poster bookmark visibly toggle the same local save', async t => {
  const doc = await mount(t, React.createElement(Hero, {
    show, consensusText: null, audienceGrade: null, audienceCount: 0,
    hasAudience: false, hasEnoughCriticReviews: false,
    sortedTicketLinks: sortTicketLinks(show.ticketLinks), lotteryRush: null,
    isWestEnd: true, isOffBroadway: false, ranks: null,
  }));
  const want = [...doc.querySelectorAll('button')].find(b => b.textContent === 'Want to See');
  await click(want);
  assert.equal(want.textContent, 'On your list');
  assert.equal(JSON.parse(localStorage.getItem(LIST_KEY))[0].showId, show.id);
  assert.ok(doc.querySelector('[role="dialog"][aria-label="Sign in or create a free account"]'));
  await click(doc.querySelector('button[aria-label="Close"]'));
  await click(doc.querySelector('button[aria-label="Remove from watchlist"]'));
  assert.equal(want.textContent, 'Want to See');
  assert.equal(localStorage.getItem(LIST_KEY), null);
});

test('Affluenza Rate it opens the real rating editor and Cancel closes it', async t => {
  const doc = await mount(t, React.createElement(Hero, {
    show, consensusText: null, audienceGrade: null, audienceCount: 0,
    hasAudience: false, hasEnoughCriticReviews: false,
    sortedTicketLinks: sortTicketLinks(show.ticketLinks), lotteryRush: null,
    isWestEnd: true, isOffBroadway: false, ranks: null,
  }));
  await click([...doc.querySelectorAll('button')].find(b => b.textContent === 'Rate it'));
  assert.ok(doc.querySelector('[data-testid="rating-editor"]'));
  await click([...doc.querySelectorAll('button')].find(b => b.textContent === 'Cancel'));
  assert.equal(doc.querySelector('[data-testid="rating-editor"]'), null);
});

test('review expansion, collapse and date sorting have working click listeners', async t => {
  const reviews = Array.from({ length: 6 }, (_, i) => ({
    outletId: `outlet-${i}`, outlet: `Outlet ${i}`, outletBadge: null,
    url: `https://example.org/review-${i}`, publishDate: `2026-10-${10 + i}`,
    tier: 3, reviewScore: 80 - i,
  }));
  // Match page.tsx: five inline cards, with the remaining rows at reviews.json.
  const url = `/show/${show.slug}/reviews.json`;
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async requested => {
    assert.equal(requested, url);
    fetches++;
    return { ok: true, json: async () => reviews };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const doc = await mount(t, React.createElement(ReviewsList, {
    reviews: reviews.slice(0, 5), category: show.category,
    more: { url, totalCount: reviews.length, hasTierChips: true, hasStops: false },
  }));
  const cards = () => doc.querySelectorAll('[data-testid="review-card"]');
  const button = text => [...doc.querySelectorAll('button')].find(b => b.textContent === text);
  assert.equal(cards().length, 5);
  await click(button('Show 1 more review'));
  assert.equal(cards().length, 6);
  assert.equal(fetches, 1);
  await click(button('Show less'));
  assert.equal(cards().length, 5);
  await click(button('By Date'));
  assert.equal(cards()[0].getAttribute('aria-label'), 'Review from Outlet 5');
  await click(button('By Score'));
  assert.equal(cards()[0].getAttribute('aria-label'), 'Review from Outlet 0');
});

test('Off-West End tickets keep the London destination, GBP price and affiliate attribution', async t => {
  const doc = await mount(t, React.createElement(TicketCTA, {
    showName: show.title, showId: show.id, showSlug: show.slug,
    showStatus: show.status, showCategory: show.category, showScore: null,
    ticketLinks: sortTicketLinks(show.ticketLinks), rawTicketLinks: show.ticketLinks,
    pageType: 'show',
  }));
  const link = doc.querySelector('a');
  assert.match(link.textContent, /Get Tickets from £25/);
  assert.equal(link.target, '_blank');
  assert.match(link.rel, /sponsored/);
  const url = new URL(link.href);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.searchParams.get('u'), show.ticketLinks[0].url);
});
