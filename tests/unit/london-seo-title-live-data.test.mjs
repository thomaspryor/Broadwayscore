// BRO-8085: real-data and final page-title checks for the "London" title suffix.
// LIVE-DATA-LANE: imports data-core and the show page, which read data/shows.json (private core data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { londonTitleNeedsSuffix } from '../../src/lib/market-utils';
import { getAllShows } from '../../src/lib/data-core';

const run = code => execFileSync(process.execPath, ['--import', 'tsx', '-e', code], { encoding: 'utf8', cwd: new URL('../..', import.meta.url).pathname }).trim();

test('real data: every London title ends up naming London once; other markets untouched', (t) => {
  const shows = getAllShows();
  const london = shows.filter(s => s.category === 'west-end' || s.category === 'off-west-end');
  if (!london.length) return t.skip('no London rows (cloud stub data)');
  for (const s of shows) {
    const name = londonTitleNeedsSuffix(s.title, s.category) ? `${s.title} London` : s.title;
    if (london.includes(s)) {
      assert.match(name, /london|west[\s-]*end/i, s.id);
      assert.doesNotMatch(name, /london\W+london/i, s.id);
    } else {
      assert.equal(name, s.title, s.id);
    }
  }
});

test('final page titles: London added once, year before London, opera and Broadway unchanged', () => {
  const out = JSON.parse(run(`
    const Module = require('node:module');
    let show, year = null;
    const originalLoad = Module._load;
    Module._load = function(id, ...args) {
      if (id === '@/lib/data-core') return { getShowBySlug: () => show, getSharedTitleYear: () => year };
      if (/data\\/(cast-manifest|actor-slugs|video-reviews)\\.json$/.test(id)) return {};
      return originalLoad.call(this, id, ...args);
    };
    const { generateMetadata } = require('./src/app/show/[slug]/page.tsx');
    const base = { id: 'x-2099', slug: 'x-2099', type: 'musical', status: 'open', venue: 'Some Theatre', synopsis: '',
      criticScore: { score: 90, reviewCount: 20, tier1Count: 6, tier2Count: 6, reviews: [] } };
    const unscored = { status: 'upcoming', criticScore: { score: null, reviewCount: 0, tier1Count: 0, tier2Count: 0, reviews: [] } };
    const cases = {
      weScored: { title: 'Hamilton', category: 'west-end' },
      weUnscored: { title: 'Monument', category: 'west-end', ...unscored },
      oweUnscored: { title: 'ABBA Voyage', category: 'off-west-end', ...unscored },
      weYear: { title: 'Macbeth', category: 'west-end', year: 2023 },
      weHasLondon: { title: 'London Road', category: 'west-end', ...unscored },
      opera: { title: 'Tosca', category: 'west-end', type: 'opera', venue: 'London Coliseum', ...unscored },
      broadway: { title: 'Hamilton', category: 'broadway' },
    };
    (async () => {
      const res = {};
      for (const [k, c] of Object.entries(cases)) {
        year = c.year || null;
        show = { ...base, ...c };
        const m = await generateMetadata({ params: Promise.resolve({ slug: show.slug }) });
        res[k] = { title: m.title.absolute, og: m.openGraph.title };
      }
      console.log(JSON.stringify(res));
      process.exit(0);
    })().catch(e => { console.error(e); process.exit(1); });
  `).split('\n').pop());
  assert.match(out.weScored.title, /^Hamilton London Reviews: /);
  assert.match(out.weScored.og, /^Hamilton London: /);
  assert.equal(out.weUnscored.title, 'Monument London Reviews | West End Scorecard');
  assert.equal(out.oweUnscored.title, 'ABBA Voyage London Reviews | Off-West End Scorecard');
  assert.match(out.weYear.title, /^Macbeth \(2023\) London Reviews: /);
  assert.equal(out.weHasLondon.title, 'London Road Reviews in the West End | West End Scorecard');
  assert.doesNotMatch(out.opera.title, /London Reviews/);
  assert.match(out.broadway.title, /^Hamilton Reviews: /);
  for (const v of Object.values(out)) assert.doesNotMatch(v.title, /London London/);
});
