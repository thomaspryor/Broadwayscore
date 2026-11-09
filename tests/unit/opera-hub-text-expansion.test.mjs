// LIVE-DATA-LANE: reads data/site-image-versions.json (untracked core data); data/grosses.json (untracked core data); data/audience-buzz.json (untracked core data); +7 more. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const unregister = require('tsx/cjs/api').register();
const previousReact = globalThis.React;
globalThis.React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { AppRouterContext } = require('next/dist/shared/lib/app-router-context.shared-runtime');
const { default: OperaPage, metadata } = require('../../src/app/opera/page');
const { default: OperaPageClient } = require('../../src/components/OperaPageClient');
const { getOperaShows } = require('../../src/lib/data-core');
const { buildHomepageExtra } = require('../../src/lib/homepage-extra');

after(() => {
  unregister();
  if (previousReact === undefined) delete globalThis.React;
  else globalThis.React = previousReact;
});

function assertCompanies(text) {
  for (const name of ['Met', 'Royal Opera House', 'San Francisco Opera', 'English National Opera']) {
    assert.ok(text.includes(name), `Missing ${name}: ${text}`);
  }
}

test('opera metadata names all four companies', () => {
  assertCompanies(metadata.title);
  assertCompanies(metadata.description);
  assertCompanies(metadata.openGraph.description);
  assertCompanies(metadata.twitter.description);
});

test('organization schema and real-data hero describe the expanded coverage', () => {
  const children = OperaPage().props.children;
  const schema = children.find(node => node?.props?.type === 'application/ld+json');
  const org = JSON.parse(schema.props.dangerouslySetInnerHTML.__html)
    .find(item => item['@type'] === 'Organization');
  assertCompanies(org.description);
  const client = children.find(node => node?.type === OperaPageClient);
  const inventory = getOperaShows();
  assert.ok(inventory.length > 0, 'real opera inventory is available');
  assert.deepEqual(client.props.shows.map(show => show.id).sort(), inventory.map(show => show.id).sort());
  // Render the inner component so Suspense cannot hide a missing app context.
  const html = renderToStaticMarkup(globalThis.React.createElement(
    AppRouterContext.Provider, { value: {} }, OperaPageClient(client.props).props.children,
  ));
  const hero = html.match(/<p[^>]*>(Every Met.*?)<\/p>/)?.[1];
  assert.ok(hero, 'hero is server-rendered');
  assertCompanies(hero);
  if (inventory.some(show => show.status === 'open')) {
    assert.match(html, /currently running in New York, London and San Francisco\./);
  }
});

test('loading fallback names the same four companies', () => {
  const suspense = OperaPageClient({ shows: [], totalShows: 0, totalReviews: 0 });
  assertCompanies(renderToStaticMarkup(suspense.props.fallback));
});

test('homepage opera row retains its existing title', () => {
  const row = buildHomepageExtra().featuredRows.find(row => row.viewAllHref === '/opera');
  assert.ok(row);
  assert.equal(row.title, 'Opera: New York and London');
});
