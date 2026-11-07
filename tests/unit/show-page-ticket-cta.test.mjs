import { test } from 'node:test';
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
let ShowPageTicketCTA, sortTicketLinks;
try {
  Module._resolveFilename = function (id, ...args) {
    return resolveFilename.call(this, id.startsWith('@/')
      ? fileURLToPath(new URL(`../../src/${id.slice(2)}`, import.meta.url))
      : id, ...args);
  };
  ShowPageTicketCTA = require('../../src/components/ShowPageTicketCTA.jsx').default;
  ({ sortTicketLinks } = require('../../src/lib/ticket-utils'));
} finally {
  Module._resolveFilename = resolveFilename;
  loader.enabled(false);
}
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { JSDOM } = require('jsdom');

const todayTix = { platform: 'TodayTix', url: 'https://www.todaytix.com/nyc/shows/1-example', priceFrom: 89 };
const baseProps = {
  showName: 'Example', showId: 'example', showSlug: 'example',
  showStatus: 'open', showCategory: 'broadway', showScore: null,
  ticketLinks: [todayTix], rawTicketLinks: [todayTix], pageType: 'show',
};
function render(overrides = {}) {
  const html = renderToStaticMarkup(React.createElement(ShowPageTicketCTA, { ...baseProps, ...overrides }));
  return new JSDOM(html).window.document;
}

for (const splitVariant of [false, true]) {
  test(`first paint has one attributed TodayTix CTA without an analytics SDK (split=${splitVariant})`, () => {
    const doc = render({ splitVariant });
    const links = doc.querySelectorAll('a');
    assert.equal(links.length, 1);
    assert.match(links[0].textContent, /Get Tickets from \$89/);
    assert.equal(links[0].target, '_blank');
    assert.match(links[0].rel, /sponsored/);
    const url = new URL(links[0].href);
    assert.equal(url.searchParams.get('u'), todayTix.url);
    assert.equal(url.searchParams.get('subId2'), 'flag:ticket-single-button,platform:fallback,buttons:single');
  });
}

test('closed shows have an explanation and no purchase link, with or without stored sellers', () => {
  for (const links of [[], [todayTix]]) {
    const doc = render({ showStatus: 'closed', ticketLinks: links, rawTicketLinks: links });
    assert.equal(doc.querySelectorAll('a').length, 0);
    assert.equal(doc.querySelector('p').textContent, 'This show has closed. Tickets are no longer available.');
  }
});

test('announced shows explain unpriced listings and show a CTA once priced', () => {
  const unpriced = [{ ...todayTix, priceFrom: null }];
  const pending = render({ showStatus: 'announced', ticketLinks: unpriced, rawTicketLinks: unpriced });
  assert.equal(pending.querySelectorAll('a').length, 0);
  assert.match(pending.querySelector('p').textContent, /Tickets aren't on sale yet/);
  assert.equal(render({ showStatus: 'announced' }).querySelectorAll('a').length, 1);
});

test('official-only shows retain the official-site fallback without a purchase promise', () => {
  for (const showStatus of ['open', 'announced']) {
    const doc = render({ showStatus, ticketLinks: [], rawTicketLinks: [], officialUrl: 'https://example.org/' });
    assert.equal(doc.querySelector('a').textContent, 'Visit Official Site');
    assert.equal(doc.querySelector('a').href, 'https://example.org/');
    assert.equal(doc.querySelector('p'), null);
  }
});

test('real seller filtering preserves the only primary seller and excludes resale-only links', () => {
  const soleSeller = [{ platform: 'Ticketmaster', url: 'https://www.ticketmaster.com/example' }];
  const doc = render({ ticketLinks: sortTicketLinks(soleSeller), rawTicketLinks: soleSeller });
  assert.match(doc.querySelector('a').textContent, /Get Tickets on Ticketmaster/);
  const resale = [{ platform: 'StubHub', url: 'https://www.stubhub.com/example' }];
  assert.equal(render({ ticketLinks: sortTicketLinks(resale), rawTicketLinks: resale }).querySelector('a'), null);
});

test('standalone lottery content and layout-specific status styling survive consolidation', () => {
  const doc = render({
    showStatus: 'announced', ticketLinks: [],
    rawTicketLinks: [{ platform: 'StubHub', url: 'https://www.stubhub.com/example' }],
    noteClassName: 'text-xs text-gray-500',
    children: React.createElement('a', { href: '#discount-tickets' }, 'Lottery'),
  });
  assert.equal(doc.body.children.length, 2);
  assert.equal(doc.body.children[0].textContent, 'Lottery');
  assert.equal(doc.body.children[1].className, 'text-xs text-gray-500');
  assert.match(doc.body.children[1].textContent, /Tickets aren't on sale yet/);
});
