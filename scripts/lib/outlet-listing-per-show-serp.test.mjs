// BRO-8034: financialtimes was missed by the first pass on The Lives of Others, Cloud 9,
// Desire Under the Elms and Eurotrash. FT URLs are opaque (ft.com/content/<uuid>) and the
// poller ran ONE generic `site:ft.com theater review` query (10 results for the whole outlet),
// so a given show's review was rarely returned. Per-show queries, by title, fix that.
// require()s the real poller + helpers (CLAUDE.md §15). Show records copied from shows.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const helpers = require('./outlet-listing-helpers.js');
const poller = require('../outlet-listing-poller.js');
const shows = [
  { id: 'cloud-9-national-west-end-2026', title: 'Cloud 9', openingDate: '2026-11-11', status: 'open' },
  { id: 'desire-under-the-elms-off-west-end-2026', title: 'Desire Under the Elms', openingDate: '2026-11-14', status: 'open' },
  { id: 'eurotrash-off-west-end-2026', title: 'Eurotrash', openingDate: '2026-11-17', status: 'open' },
];
const FT = (id) => `https://www.ft.com/content/${id}`; // opaque: nothing in the path names a show

test('financialtimes is a per-show SERP outlet', () => {
  assert.ok(helpers.PER_SHOW_SERP_OUTLETS.has('financialtimes'));
});

test('per-show query carries the quoted title; targets are newest-opening first and capped', () => {
  assert.equal(helpers.buildPerShowSerpQuery('ft.com', shows[2]), 'site:ft.com "Eurotrash" review');
  assert.equal(helpers.perShowSerpTargets(shows)[0].id, 'eurotrash-off-west-end-2026');
  assert.equal(helpers.perShowSerpTargets(shows, 2).length, 2);
});

test('opaque ft.com reviews for each missed show are found and matched to the right show', async () => {
  const hits = {
    '"Cloud 9"': [{ url: FT('a6bec1d4-a9c1-4542-8c9d-95a8a61c48fb'), title: 'Cloud 9 review — Caryl Churchill’s farce at the National' }],
    '"Desire Under the Elms"': [{ url: FT('11111111-aaaa-4bbb-8ccc-222222222222'), title: 'Desire Under the Elms review — O’Neill’s farm tragedy' }],
    '"Eurotrash"': [{ url: FT('688949b0-f395-4d56-82ea-b55789849c33'), title: 'Eurotrash review — Christian Lollike’s comedy' }],
  };
  const queries = [];
  const serp = async (q) => { queries.push(q); return hits[Object.keys(hits).find(k => q.includes(k))] || []; };
  const items = await poller.fetchViaSerpPerShow('financialtimes', 'ft.com', new Date('2026-10-01'), {}, shows, serp, Date.parse('2026-11-22'));
  assert.equal(queries.length, 3, 'one SERP query per show');
  assert.equal(items.length, 3);
  for (const show of shows) {
    const item = items.find(i => i.headline.toLowerCase().includes(show.title.toLowerCase()));
    assert.ok(item, `${show.id}: result returned`);
    const urlSlug = new URL(item.url).pathname;
    const m = helpers.findMatchingShows(item.headline, urlSlug, shows, '', { publishDate: null });
    assert.deepEqual(m.map(x => x.id), [show.id]);
  }
});

test('shows opened more than 14 days ago are not queried', () => {
  const old = { id: 'old', title: 'Old Show', openingDate: '2026-10-01' };
  const t = helpers.perShowSerpTargets([old, ...shows], 25, Date.parse('2026-11-22'));
  assert.ok(!t.some(x => x.id === 'old'));
  assert.equal(t.length, 3);
});

test('priority categories sort ahead of regional shows that opened later', () => {
  const reg = { id: 'reg', title: 'Regional Thing', openingDate: '2026-11-21', category: 'regional' };
  const t = helpers.perShowSerpTargets([reg, { ...shows[2], category: 'off-west-end' }], 25, Date.parse('2026-11-22'));
  assert.deepEqual(t.map(x => x.id), ['eurotrash-off-west-end-2026', 'reg']);
});

test('real shows.json: the missed openings are queried and future openings are not', async () => {
  const fs = await import('node:fs');
  const all = JSON.parse(fs.readFileSync(new URL('../../data/shows.json', import.meta.url), 'utf8'));
  const list = Array.isArray(all) ? all : all.shows;
  const now = Date.parse('2026-11-22T12:00:00Z');
  const t = helpers.perShowSerpTargets(list.filter(s => s.status === 'open' || s.status === 'previews'), 30, now);
  assert.ok(t.length > 0 && t.length <= 30);
  assert.ok(t.every(s => s.openingDate <= '2026-11-23'), 'no show that has not opened yet');
  for (const id of ['eurotrash-off-west-end-2026', 'desire-under-the-elms-off-west-end-2026']) assert.ok(t.some(s => s.id === id), id);
});

test('a failing query for one show does not drop the others', async () => {
  let n = 0;
  const serp = async () => { n++; if (n === 1) throw new Error('boom'); return [{ url: FT(`id-${n}`), title: 'x' }]; };
  const items = await poller.fetchViaSerpPerShow('financialtimes', 'ft.com', new Date(), {}, shows, serp, Date.parse('2026-11-22'));
  assert.equal(items.length, 2);
});
