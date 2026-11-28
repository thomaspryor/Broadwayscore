// BRO-8439: a regional production's <title>, meta description and og:title name its city, taken from
// the venue data (never the URL), so "My Fair Lady" in Melbourne and in Chichester stop sharing one title.
// The sweep runs the REAL generateMetadata (CLAUDE.md rule 15), so reverting the page fix reddens it.
// LIVE-DATA-LANE for the sweep: it reads data/shows.json (private core data); fixtures run everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRegionalTitleCity, getRegionalCityLabel, getMarketCurrency } from '../../src/lib/market-utils';

const run = (code, env = {}) => execFileSync(process.execPath, ['--import', 'tsx', '-e', code], {
  encoding: 'utf8', env: { ...process.env, NEXT_PUBLIC_FEATURES: 'regional', ...env }, cwd: new URL('../..', import.meta.url).pathname, maxBuffer: 256 * 1024 * 1024,
}).trim();

// Shared harness: real data-core except getShowBySlug, which serves the rows the case hands in.
const HARNESS = `
  const Module = require('node:module');
  let rows = {};
  const originalLoad = Module._load;
  Module._load = function(id, ...args) {
    if (id === '@/lib/data-core') {
      const actual = originalLoad.call(this, id, ...args);
      return { ...actual, getShowBySlug: (slug) => rows[slug] };
    }
    if (/data\\/(cast-manifest|actor-slugs|video-reviews)\\.json$/.test(id)) return {};
    return originalLoad.call(this, id, ...args);
  };
  const { generateMetadata } = require('./src/app/show/[slug]/page.tsx');
  const base = { type: 'musical', status: 'closed', synopsis: '', criticScore: { score: 94, reviewCount: 20, tier1Count: 6, tier2Count: 6, reviews: [] } };
  const meta = async (row) => { rows[row.slug] = { ...base, ...row, id: row.slug }; return generateMetadata({ params: Promise.resolve({ slug: row.slug }) }); };
`;

test('city comes from the venue data: AU table, AU state suffix, UK table, US "House, City, ST"', () => {
  assert.equal(getRegionalTitleCity({ category: 'regional', venue: 'Arts Centre Melbourne' }), 'Melbourne');
  assert.equal(getRegionalTitleCity({ category: 'regional', venue: 'Queensland Performing Arts Centre' }), 'Brisbane');
  assert.equal(getRegionalTitleCity({ category: 'regional', venue: 'Some Hall, Geelong, VIC' }), 'Geelong');
  assert.equal(getRegionalTitleCity({ category: 'regional', venue: 'Chichester Festival Theatre, Chichester' }), 'Chichester');
  assert.equal(getRegionalTitleCity({ category: 'regional', venue: 'Gem Theatre, Garden Grove, CA' }), 'Garden Grove');
  assert.equal(getRegionalLabelOf('Arts Centre Melbourne'), 'Melbourne, Australia');
  assert.equal(getRegionalLabelOf('Leeds Playhouse, Leeds'), 'Leeds, UK');
});
const getRegionalLabelOf = venue => getRegionalCityLabel({ category: 'regional', venue });

test('non-regional shows and unparseable venues get no city', () => {
  assert.equal(getRegionalTitleCity({ category: 'broadway', venue: 'Arts Centre Melbourne' }), undefined);
  assert.equal(getRegionalTitleCity({ category: 'tour', venue: 'North American Tour' }), undefined);
  assert.equal(getRegionalTitleCity({ category: 'regional', venue: 'TBA' }), undefined);
  assert.equal(getRegionalTitleCity({ category: 'regional', venue: undefined }), undefined);
});

test('Australian shows use AUD offers', () => {
  assert.equal(getMarketCurrency('regional', 'Arts Centre Melbourne'), 'AUD');
  assert.equal(getMarketCurrency('regional', 'Chichester Festival Theatre, Chichester'), 'GBP');
});

test('real generateMetadata: Melbourne and Chichester "My Fair Lady" get distinct titles naming their city', () => {
  const out = JSON.parse(run(`${HARNESS}
    (async () => {
      const mel = await meta({ slug: 'my-fair-lady-regional-2026', title: 'My Fair Lady', category: 'regional', venue: 'Arts Centre Melbourne', openingDate: '2026-03-01' });
      const chi = await meta({ slug: 'my-fair-lady-chichester-festival-regional-2026', title: 'My Fair Lady', category: 'regional', venue: 'Chichester Festival Theatre, Chichester', openingDate: '2026-07-16' });
      console.log(JSON.stringify({ mel: { t: mel.title.absolute, og: mel.openGraph.title, d: mel.description }, chi: { t: chi.title.absolute, og: chi.openGraph.title, d: chi.description } }));
      process.exit(0);
    })().catch(e => { console.error(e); process.exit(1); });
  `).split('\n').pop());
  assert.notEqual(out.mel.t, out.chi.t);
  assert.match(out.mel.t, /^My Fair Lady Melbourne\b/);
  assert.match(out.chi.t, /^My Fair Lady Chichester\b/);
  assert.match(out.mel.og, /My Fair Lady Melbourne/);
  assert.match(out.mel.d, /Melbourne/);
  assert.match(out.chi.d, /Chichester/);
  assert.doesNotMatch(out.mel.t, /Chichester/);
});

test('a title that already names the city is not doubled; a venue with no city keeps its old title', () => {
  const out = JSON.parse(run(`${HARNESS}
    (async () => {
      const a = await meta({ slug: 'melbourne-cup-regional-2026', title: 'Melbourne Cup The Musical', category: 'regional', venue: 'Arts Centre Melbourne' });
      const b = await meta({ slug: 'x-regional-2026', title: 'X', category: 'regional', venue: 'TBA' });
      console.log(JSON.stringify({ a: a.title.absolute, b: b.title.absolute }));
      process.exit(0);
    })().catch(e => { console.error(e); process.exit(1); });
  `).split('\n').pop());
  assert.doesNotMatch(out.a, /Melbourne.*Melbourne/);
  assert.match(out.b, /^X Reviews: Rave 94\/100 \| Broadway Scorecard$/);
});

test('real data: no two indexable regional show pages share a <title> or og:title', (t) => {
  const outFile = join(mkdtempSync(join(tmpdir(), 'bro8439-')), 'sweep.json');
  run(`${HARNESS}
    const { getAllShows } = require('./src/lib/data-core');
    (async () => {
      const all = getAllShows().filter(s => s.category === 'regional');
      const res = [];
      for (const s of all) {
        // Unscored on purpose: a score can only separate two titles by accident.
        const m = await meta({ ...s, criticScore: { score: null, reviewCount: 0, tier1Count: 0, tier2Count: 0, reviews: [] } });
        res.push({ slug: s.slug, t: m.title.absolute, og: m.openGraph.title, noindex: !!(m.robots && m.robots.index === false) });
      }
      require('fs').writeFileSync(process.env.SWEEP_OUT, JSON.stringify(res)); // a 1,400-row result overflows a pipe
      process.exit(0);
    })().catch(e => { console.error(e); process.exit(1); });
  `, { SWEEP_OUT: outFile });
  const out = JSON.parse(readFileSync(outFile, 'utf8'));
  if (out.length < 20) return t.skip('no regional rows (cloud stub data)');
  for (const key of ['t', 'og']) {
    const seen = new Map();
    for (const r of out.filter(r => !r.noindex)) (seen.get(r[key]) ?? seen.set(r[key], []).get(r[key])).push(r.slug);
    const dupes = [...seen].filter(([, slugs]) => slugs.length > 1);
    assert.deepEqual(dupes, [], `duplicate ${key}: ${JSON.stringify(dupes.slice(0, 5))}`);
  }
});
