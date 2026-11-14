import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewsSyncingBadge } from '../../src/components/show-cards/ShowPills';
import { computeShowData, type RawShow } from '../../src/lib/engine';
import { shouldShowReviewsSyncing } from '../../scripts/lib/show-page-provisional-state';

const render = (show: Parameters<typeof shouldShowReviewsSyncing>[0]) =>
  renderToStaticMarkup(createElement(ReviewsSyncingBadge, { show }));

test('a provisional row without a score renders the syncing StatusBadge', () => {
  const html = render({ provisional: true, criticScore: null });
  assert.match(html, /Reviews syncing/);
  assert.match(html, /bg-status-previews-bg text-status-previews/);
  assert.match(html, /text-xs/);
});

test('a numeric score removes the badge even while the provisional flag remains', () => {
  for (const score of [0, 65, 90]) {
    assert.equal(render({ provisional: true, discoverySource: 'audit-owe', criticScore: { score, reviewCount: 5 } }), '');
  }
});

test('historical unscored non-provisional rows retain their existing state', () => {
  assert.equal(render({ discoverySource: 'historical-backfill', criticScore: null }), '');
  assert.equal(render({ provisional: false }), '');
  assert.equal(render({}), '');
});

test('zero-review audit rows sync, but other sources and audits with collected reviews do not', () => {
  assert.match(render({ discoverySource: 'audit-owe', criticScore: null }), /Reviews syncing/);
  assert.match(render({ discoverySource: 'audit-ob', criticScore: { score: null, reviewCount: 0 } }), /Reviews syncing/);
  assert.equal(render({ discoverySource: 'audit-owe', criticScore: { score: null, reviewCount: 1 } }), '');
  assert.equal(render({ discoverySource: 'aggregator-roundup', criticScore: null }), '');
  assert.equal(render({ discoverySource: 'audit', criticScore: null }), '');
});

test('provisional rows still sync when reviews exist but no score is available', () => {
  assert.match(render({ provisional: true, criticScore: { score: null, reviewCount: 1 } }), /Reviews syncing/);
});

test('the real show projection preserves the metadata needed by both hero layouts', () => {
  const raw: RawShow = {
    id: 'provisional-show', title: 'Provisional show', slug: 'provisional-show',
    venue: 'Theatre', openingDate: '2026-01-01', closingDate: null,
    runtime: '90 minutes', intermissions: 0,
    status: 'open', type: 'play', provisional: true, discoverySource: 'venue-page:theatre',
  };
  const computed = computeShowData(raw, [], [], []);
  assert.equal(computed.provisional, true);
  assert.equal(computed.discoverySource, raw.discoverySource);
  assert.match(render(computed), /Reviews syncing/);
  assert.equal(render(computeShowData({ ...raw, provisional: false }, [], [], [])), '');
});

test('both active and rollback show-page layouts render the shared syncing badge', () => {
  for (const file of ['src/app/show/[slug]/page.tsx', 'src/components/show-page/ShowHeroRedesign.tsx']) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.match(source, /<ReviewsSyncingBadge show=\{show\} \/>/, file);
  }
});
