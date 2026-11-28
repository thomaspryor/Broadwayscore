import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeShowScoreCandidates } = require('./show-score-venue-disambiguation.js');
const { corroborateShowScoreCandidates } = require('./show-score-venue-disambiguation.js');

// Reduced to metadata from TDF's live Show Finder and Peter Panto page.
const panto = { title: 'Peter Panto', category: 'off-broadway', showScoreUrl: 'https://www.show-score.com/off-broadway-shows/peter-panto' };
const searchHtml = '<div data-sf-results><a href="/shows/23550/peter-panto/"><h3 class="show-card__title">Peter Panto</h3></a></div>';
const detailHtml = '<h1>Peter Panto</h1><div class="shows-single__types"><a>Off-Off Broadway</a><a>Holiday</a></div>';

test('BRO-6693: TDF refuses Peter Panto even when Show Score calls it Off-Broadway, fresh or carried over', async () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  for (const fresh of [true, false]) {
    const merged = mergeShowScoreCandidates({
      candidates: fresh ? [panto] : [], venueRejects: [],
      existing: { candidates: fresh ? [] : [{ ...panto, discoveredAt: new Date(now).toISOString() }] },
      matchedUrls: new Set(), ttlDays: 90, now,
    });
    const calls = [];
    const result = await corroborateShowScoreCandidates(merged.data.candidates, {
      fetchPage: async (url, options) => {
        calls.push({ url, options });
        return { content: calls.length === 1 ? searchHtml : detailHtml };
      },
    });
    assert.deepEqual(result.candidates, []);
    assert.equal(result.refused[0].showScoreUrl, panto.showScoreUrl);
    assert.equal(result.refused[0].tdfUrl, 'https://www.tdf.org/shows/23550/peter-panto/');
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0].url).searchParams.get('q'), panto.title);
    assert.deepEqual(calls[0].options.tiers, ['playwright-first']);
    assert.equal(calls[1].options.directOnly, true);
  }
});

test('TDF only refuses an exact show-page title with an explicit tier tag', async () => {
  for (const html of [
    '<h1>Peter Panto</h1><p>Off-Off Broadway</p><div class="shows-single__types"><a>Off Broadway</a></div>',
    '<h1>Peter Panto</h1><nav><a>Off-Off Broadway</a></nav>',
    detailHtml.replace('<h1>Peter Panto</h1>', '<h1>Peter Pan</h1>'),
  ]) {
    const result = await corroborateShowScoreCandidates([panto], {
      fetchPage: async url => ({ content: url.includes('show-finder') ? searchHtml : html }),
    });
    assert.deepEqual(result.candidates, [panto]);
    assert.deepEqual(result.refused, []);
  }
});

test('TDF search titles must match exactly; URL slugs supply no title or tier evidence', async () => {
  let calls = 0;
  const result = await corroborateShowScoreCandidates([panto], {
    fetchPage: async () => {
      calls++;
      return { content: searchHtml.replace('>Peter Panto<', '>Peter Panto and the Incredible Stinkerbell<') };
    },
  });
  assert.deepEqual(result.candidates, [panto]);
  assert.equal(calls, 1);
});

test('unmatched TDF search results and outages preserve candidates, with outage warnings', async () => {
  for (const fetchPage of [
    async () => ({ content: '<div data-sf-results></div>' }),
    async () => { throw new Error('network unavailable'); },
    async () => ({ content: '<h1>Access denied</h1>' }),
  ]) {
    const result = await corroborateShowScoreCandidates([panto], { fetchPage });
    assert.deepEqual(result.candidates, [panto]);
    assert.deepEqual(result.refused, []);
  }
  const unavailable = await corroborateShowScoreCandidates([panto], {
    fetchPage: async () => { throw new Error('network unavailable'); },
  });
  assert.equal(unavailable.warnings[0].reason, 'network unavailable');
});

test('Broadway and London candidates cost no requests; duplicate OB titles share the lookup', async () => {
  const bw = { ...panto, category: 'broadway' };
  const we = { ...panto, category: 'west-end' };
  let calls = 0;
  const result = await corroborateShowScoreCandidates([bw, we, panto, { ...panto, title: 'Peter Panto (NYC)' }], {
    fetchPage: async () => ({ content: ++calls === 1 ? searchHtml : detailHtml }),
  });
  assert.deepEqual(result.candidates, [bw, we]);
  assert.equal(result.refused.length, 2);
  assert.equal(calls, 2);
});

test('TDF result links cannot cause third-party fetches', async () => {
  let calls = 0;
  const result = await corroborateShowScoreCandidates([panto], {
    fetchPage: async () => {
      calls++;
      return { content: searchHtml.replace('/shows/23550/peter-panto/', 'https://example.com/shows/23550/peter-panto/') };
    },
  });
  assert.deepEqual(result.candidates, [panto]);
  assert.equal(calls, 1);
});

test('TDF title entities and tier punctuation are normalized without fuzzy matching', async () => {
  const candidate = { ...panto, title: 'Peter & Panto (Off-Broadway)' };
  const result = await corroborateShowScoreCandidates([candidate], {
    fetchPage: async url => ({ content: (url.includes('show-finder') ? searchHtml : detailHtml)
      .replaceAll('Peter Panto', 'Peter &amp; Panto').replace('Off-Off Broadway', 'Off-Off-Broadway') }),
  });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.refused.length, 1);
});

test('BRO-6531: Off-Off-Broadway listings cannot become new or carried-over candidates', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  // Tier evidence comes from the listing collection, never the URL path.
  const outside = { title: 'Outside Show', showScoreUrl: 'https://www.show-score.com/off-broadway-shows/outside', category: 'off-broadway' };
  const ob = { title: 'Off Broadway Show', showScoreUrl: 'https://www.show-score.com/off-broadway-shows/inside', category: 'off-broadway' };
  const we = { title: 'London Show', showScoreUrl: 'https://www.show-score.com/uk/london/west-end-shows/inside', category: 'west-end' };
  for (const candidates of [[outside, ob, we], [ob, we], []]) {
    const result = mergeShowScoreCandidates({
      candidates, venueRejects: [],
      existing: { candidates: [outside, ob, we].map(c => ({ ...c, discoveredAt: new Date(now).toISOString() })) },
      matchedUrls: new Set(), outOfScopeUrls: new Set([outside.showScoreUrl]), ttlDays: 90, now,
    });
    assert.deepEqual(result.data.candidates.map(c => c.title), [ob.title, we.title]);
    assert.equal(result.data._meta.totalCandidates, 2);
  }
});

test('BRO-6531: removing the only stale out-of-scope candidate still rewrites the file', () => {
  const url = 'https://www.show-score.com/listing';
  const result = mergeShowScoreCandidates({
    candidates: [], venueRejects: [],
    existing: { candidates: [{ showScoreUrl: url, discoveredAt: new Date().toISOString() }] },
    matchedUrls: new Set(), outOfScopeUrls: new Set([url]), ttlDays: 90,
  });
  assert.equal(result.write, true);
  assert.deepEqual(result.data.candidates, []);
});
