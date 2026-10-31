import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { routeVenueValidation, londonSources, parseLondonEvidence, validateLondonShow } = require('./lib/london-venue-validation');
const { classifyNamedShowRun } = require('./lib/named-show-verdict');
const { provisionalPriorityTier, blocksOnDeferral, resolveLastDefinitive, buildAuditResults } = require('./lib/venue-date-compare');
const ROOT = path.resolve(import.meta.dirname, '..');

// Minimal public facts from the venue pages, not copyrighted page bodies.
// https://www.barbican.org.uk/whats-on/2026/event/end-of-the-world-and-hard-boiled-wonderland
// https://www.thecoronettheatre.com/whats-on/berliner-ensemble-de-profundis-by-oscar-wilde/
const wonderland = {
  id: 'end-of-the-world-and-hard-boiled-wonderland-off-west-end-2026',
  title: 'End of the World and Hard-Boiled Wonderland', venue: 'Barbican Theatre',
  category: 'off-west-end', market: 'west-end', openingDate: '2026-10-08', closingDate: '2026-10-11',
};
const deProfundis = {
  id: 'de-profundis-off-west-end-2026', title: 'De Profundis', venue: 'Coronet Theatre',
  category: 'off-west-end', market: 'west-end', openingDate: '2026-10-02', closingDate: '2026-10-07',
};
const westEnd = {
  id: 'hamilton-west-end-2017', title: 'Hamilton', venue: 'Victoria Palace Theatre',
  category: 'west-end', market: 'west-end', openingDate: '2017-12-21', closingDate: null,
};
const broadway = [
  { id: 'hamilton-2015', title: 'Hamilton', venue: 'Richard Rodgers Theatre', openingDate: '2015-08-06' },
  { id: 'wicked-2003', title: 'Wicked', venue: 'Gershwin Theatre', openingDate: '2003-10-30' },
  { id: 'hadestown-2019', title: 'Hadestown', venue: 'Walter Kerr Theatre', openingDate: '2019-04-17' },
].map(s => ({ ...s, category: 'broadway', market: 'broadway' }));
const barbicanUrl = 'https://www.barbican.org.uk/whats-on/2026/event/end-of-the-world-and-hard-boiled-wonderland';
const coronetUrl = 'https://www.thecoronettheatre.com/whats-on/berliner-ensemble-de-profundis-by-oscar-wilde/';
const hamiltonUrl = 'https://www.londontheatre.co.uk/show/hamilton';
const barbicanHtml = '<main><header><h1>End of the World and Hard-Boiled Wonderland</h1><h2>Haruki Murakami / Philippe Decouflé</h2><p>Thu 8 –Sun 11 Oct 2026</p><p>Theatre</p></header></main>';
const coronetHtml = '<main><h1>Berliner Ensemble: De Profundis By Oscar Wilde</h1><p>02–07 Oct 2026</p><p class="event-venue">The Coronet Theatre</p></main>';
function eventHtml(show, overrides = {}) {
  return `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'TheaterEvent', name: show.title, location: { '@type': 'Place', name: show.venue }, startDate: show.openingDate, endDate: show.closingDate || '2027-03-28', ...overrides })}</script>`;
}
function exitCode(show, row) {
  return classifyNamedShowRun({ showFilter: show.id, results: [row], targetCount: 1 }).exitCode;
}

test('a no-london-url result sorts at tier 4, including migrated Playbill misses', () => {
  for (const row of [
    'no-london-url',
    { result: 'no-london-url' },
    { result: 'no-london-url', lastDefinitiveResult: 'no-london-url' },
    { result: 'no-london-url', lastDefinitiveResult: 'no-playbill-url' },
  ]) assert.equal(provisionalPriorityTier(wonderland.id, { [wonderland.id]: row }), 4);
});

test('a settled no-london-url result does not block deferral but a named check stays unresolved', () => {
  const fresh = { id: wonderland.id, result: 'no-london-url' };
  for (const previousResultsById of [{}, { [wonderland.id]: { result: 'no-playbill-url' } }]) {
    const [row] = buildAuditResults({
      freshResults: [fresh], previousResultsById,
      currentProvisionalIds: new Set([wonderland.id]), showsById: { [wonderland.id]: wonderland },
    });
    assert.equal(row.lastDefinitiveResult, 'no-london-url');
    assert.equal(blocksOnDeferral(wonderland.id, { [wonderland.id]: row }), false);
    assert.equal(resolveLastDefinitive('fetch-error', row), 'no-london-url');
    assert.equal(exitCode(wonderland, row), 3);
  }
  assert.equal(blocksOnDeferral(wonderland.id, { [wonderland.id]: fresh }), false);
});

test('no-london-url preserves a prior mismatch and keeps it ahead of settled shows', () => {
  assert.equal(resolveLastDefinitive('no-london-url', { lastDefinitiveResult: 'mismatch' }), 'mismatch');
  const [row] = buildAuditResults({
    freshResults: [{ id: wonderland.id, result: 'no-london-url' }],
    previousResultsById: { [wonderland.id]: { result: 'mismatch' } },
    currentProvisionalIds: new Set([wonderland.id]), showsById: { [wonderland.id]: wonderland },
  });
  assert.equal(row.lastDefinitiveResult, 'mismatch');
  assert.equal(blocksOnDeferral(wonderland.id, { [wonderland.id]: row }), true);
  assert.equal(provisionalPriorityTier(wonderland.id, { [wonderland.id]: row }), 1);
});

test('routes both London categories and market-only rows; NYC, regional and tours retain Playbill', () => {
  const calls = [];
  const handlers = { london: s => calls.push(['london', s.id]), playbill: s => calls.push(['playbill', s.id]) };
  for (const show of [wonderland, deProfundis, westEnd, ...broadway]) routeVenueValidation(show, handlers);
  routeVenueValidation({ ...westEnd, category: undefined }, handlers);
  for (const category of ['off-broadway', 'regional', 'tour']) routeVenueValidation({ id: category, category }, handlers);
  assert.deepEqual(calls.map(c => c[0]), ['london', 'london', 'london', 'playbill', 'playbill', 'playbill', 'london', 'playbill', 'playbill', 'playbill']);
  assert.ok(londonSources(wonderland).includes('barbican.org.uk'));
  assert.ok(londonSources(deProfundis).includes('thecoronettheatre.com'));
  assert.ok(londonSources({ venue: 'Almeida Theatre' }).includes('almeida.co.uk'));
  assert.ok(londonSources(westEnd).includes('londontheatre.co.uk'));
  assert.ok(!londonSources({ venue: 'Lyric Theatre' }).includes('lyric.co.uk'), 'do not confuse the West End Lyric with Lyric Hammersmith');
});

test('London search fetches venue pages and preserves existing named-show exit codes', async () => {
  for (const [show, url, html, expected] of [
    [wonderland, barbicanUrl, barbicanHtml, 'venue-unverified'],
    [deProfundis, coronetUrl, coronetHtml, 'match'],
    [westEnd, hamiltonUrl, eventHtml(westEnd), 'match'],
  ]) {
    const queries = [], fetched = [];
    const row = await validateLondonShow(show, {
      serpQuery: async q => { queries.push(q); return [{ url }]; },
      fetchPage: async u => { fetched.push(u); return { content: html }; },
    });
    assert.equal(row.result, expected);
    assert.equal(exitCode(show, row), 0, show.id);
    assert.ok(queries.length > 0);
    assert.ok(queries.every(q => !q.includes('playbill.com')));
    assert.ok(fetched.includes(url));
    assert.equal(row.playbillUrl, null, 'London URLs must never enter the Playbill cache');
    assert.equal(row.sourceUrl, url);
  }
});

test('requires production title and dated evidence, never a slug, snippet, footer or related show', () => {
  for (const html of [
    '<h1>Another production</h1>' + barbicanHtml.replace(/<h1>.*?<\/h1>/, ''),
    '<h1>End of the World and Hard-Boiled Wonderland</h1><footer>8-11 Oct 2026</footer>',
    '<h1>End of the World and Hard-Boiled Wonderland</h1><p>8-11 Oct</p>',
    '<h1>End of the World and Hard-Boiled Wonderland</h1><p>Published 8 Oct 2026</p>',
    '<main><h1>End of the World and Hard-Boiled Wonderland</h1><h2>Other production</h2><p>8-11 Oct 2026</p></main>',
    eventHtml(wonderland, { name: 'Another production' }),
    eventHtml(wonderland, { startDate: '2026-02-30' }),
    eventHtml(wonderland, { endDate: undefined }),
  ]) assert.equal(parseLondonEvidence(html, wonderland), null);
  assert.equal(parseLondonEvidence(eventHtml({ ...wonderland, title: wonderland.title + ' Extra' }), wonderland), null);
  const colonTitle = { ...wonderland, title: 'Paddington: The Musical' };
  assert.ok(parseLondonEvidence(eventHtml(colonTitle), colonTitle), 'retain a colon that belongs to the actual title');
});

test('separates same-title JSON-LD productions by venue and date, including @graph', () => {
  const wrong = JSON.parse(eventHtml(wonderland, { location: { name: 'Other Theatre' } }).match(/>(.*?)</)[1]);
  const right = JSON.parse(eventHtml(wonderland).match(/>(.*?)</)[1]);
  const old = { ...right, startDate: '2024-10-08', endDate: '2024-10-11' };
  const parsed = parseLondonEvidence(`<script type="application/ld+json">${JSON.stringify({ '@graph': [wrong, old, right] })}</script>`, wonderland);
  assert.equal(parsed.titleParse.venue, wonderland.venue);
  assert.equal(parsed.dates.openingDate, wonderland.openingDate);
});

test('rejects wrong venues, wrong years and date windows while accepting preview-to-press differences', async () => {
  for (const [overrides, result] of [
    [{ location: { name: 'Other Theatre' } }, 'mismatch'],
    [{ startDate: '2024-10-08', endDate: '2024-10-11' }, 'mismatch'],
    [{ startDate: '2026-06-08', endDate: '2026-06-11' }, 'mismatch'],
    [{ startDate: '2026-10-01' }, 'match'],
  ]) {
    const row = await validateLondonShow(wonderland, { serpQuery: async () => [{ url: barbicanUrl }], fetchPage: async () => ({ content: eventHtml(wonderland, overrides) }) });
    assert.equal(row.result, result);
    assert.equal(exitCode(wonderland, row), result === 'match' ? 0 : 1);
  }
});

test('London outages and undated pages remain unresolved, with bounded fetch cost', async () => {
  for (const mode of ['search-outage', 'empty', 'fetch-outage', 'undated']) {
    let fetches = 0;
    const row = await validateLondonShow(wonderland, {
      serpQuery: async () => mode === 'search-outage' ? null : mode === 'empty' ? [] : [1, 2, 3, 4].map(n => ({ url: `${barbicanUrl}?candidate=${n}` })),
      fetchPage: async () => { fetches++; if (mode === 'fetch-outage') throw new Error('offline'); return { content: '<h1>End of the World and Hard-Boiled Wonderland</h1>' }; },
    });
    assert.equal(exitCode(wonderland, row), 3, mode);
    assert.ok(fetches <= 3);
  }
});

test('an undated provisional record still checks its production year, including numeric titles', async () => {
  const show = { ...wonderland, id: '1984-off-west-end-2026', title: '1984', openingDate: null, closingDate: null };
  for (const year of ['2024', '2026']) {
    const row = await validateLondonShow(show, {
      serpQuery: async () => [{ url: barbicanUrl }],
      fetchPage: async () => ({ content: eventHtml(show, { startDate: `${year}-10-08`, endDate: `${year}-10-11` }) }),
    });
    assert.equal(row.result, year === '2026' ? 'match' : 'mismatch');
  }
});

test('stops London requests when the existing run budget expires and leaves the show unanswered', async () => {
  for (const initiallyExpired of [false, true]) {
    let fetched = 0, queried = 0;
    const row = await validateLondonShow(wonderland, {
      serpQuery: async () => { queried++; return [{ url: barbicanUrl }, { url: barbicanUrl + '?second' }]; },
      fetchPage: async () => { fetched++; return { content: '' }; },
    }, { exceeded: () => initiallyExpired || fetched > 0 });
    assert.equal(row.result, 'budget-exhausted');
    assert.equal(exitCode(wonderland, row), 3);
    assert.equal(fetched, initiallyExpired ? 0 : 1);
    assert.equal(queried, initiallyExpired ? 0 : 1);
  }
});

test('uses trusted existing evidence without SERP and refuses unrelated or spoofed domains', async () => {
  let queries = 0;
  const fetched = [];
  const row = await validateLondonShow({ ...deProfundis, evidenceUrls: ['https://playbill.com/production/de-profundis', 'https://thecoronettheatre.com.attacker.test/event', coronetUrl] }, {
    serpQuery: async () => { queries++; return []; },
    fetchPage: async u => { fetched.push(u); return { content: coronetHtml }; },
  });
  assert.equal(row.result, 'match');
  assert.equal(queries, 0);
  assert.deepEqual(fetched, [coronetUrl]);
});

test('CLI resolves the named Off-West End show and keeps three Broadway exit codes unchanged', () => {
  const dir = mkdtempSync(path.join(ROOT, '.bro-5178-test-'));
  try {
    const shows = [wonderland, deProfundis, westEnd, ...broadway];
    writeFileSync(path.join(dir, 'shows.json'), JSON.stringify({ shows }));
    const preload = path.join(dir, 'preload.cjs');
    // Only network boundaries are replaced. The child runs the actual CLI,
    // source router, parsers, comparison and named-show verdict functions.
    writeFileSync(preload, `
      const Module = require('node:module');
      const original = Module._load;
      const pages = ${JSON.stringify({ [barbicanUrl]: barbicanHtml, [coronetUrl]: coronetHtml, [hamiltonUrl]: eventHtml(westEnd) })};
      const shows = ${JSON.stringify(shows)};
      Module._load = function(id, parent, ...rest) {
        if (/(?:^|\\/)scraper$/.test(id)) return {
          fetchPage: async url => {
            if (pages[url]) return { content: pages[url] };
            if (new URL(url).hostname !== 'playbill.com') throw Error('Unexpected URL: ' + url);
            const show = shows.find(s => s.category === 'broadway' && url.toLowerCase().includes(s.title.toLowerCase()));
            if (!show) throw Error('Unexpected Playbill URL: ' + url);
            return { content: '<title>' + show.title + ' (Broadway, ' + show.venue + ', ' + show.openingDate.slice(0,4) + ') | Playbill</title>' + ' '.repeat(5100) };
          }, getScraperStats: () => ({ pwBrowserMissingCount: 0 }), cleanup: async () => {},
        };
        if (/(?:^|\\/)url-discovery$/.test(id)) return { serpQuery: async query => {
          if (query.includes('playbill.com')) return [];
          if (process.env.BRO_5178_SEARCH_MODE === 'empty') return [];
          if (process.env.BRO_5178_SEARCH_MODE === 'outage') return null;
          if (query.includes('De Profundis')) return [{ url: ${JSON.stringify(coronetUrl)} }];
          if (query.includes('Hamilton')) return [{ url: ${JSON.stringify(hamiltonUrl)} }];
          return [{ url: ${JSON.stringify(barbicanUrl)} }];
        } };
        return original.call(this, id, parent, ...rest);
      };
    `);
    for (const show of shows) {
      const run = spawnSync(process.execPath, ['--require', preload, 'scripts/validate-show-venue.js', `--show=${show.id}`, `--data-dir=${dir}`, '--dry-run'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
      assert.equal(run.status, 0, `${show.id}\n${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout, /Summary: [01] match \/ [01] venue-unverified \/ 0 mismatch \/ 0 unresolved/);
      if (show.market === 'west-end') assert.doesNotMatch(run.stdout, /url \(cache\): https:\/\/playbill/);
    }
    for (const mode of ['empty', 'outage']) {
      const run = spawnSync(process.execPath, ['--require', preload, 'scripts/validate-show-venue.js', `--show=${wonderland.id}`, `--data-dir=${dir}`, '--dry-run'], {
        cwd: ROOT, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, BRO_5178_SEARCH_MODE: mode },
      });
      assert.equal(run.status, 3, `${mode}\n${run.stdout}\n${run.stderr}`);
      if (mode === 'empty') {
        assert.match(run.stdout, /no-london-url/);
        assert.doesNotMatch(run.stdout, /ZERO real validation coverage|DEGRADED coverage/);
      } else assert.match(run.stdout, /ZERO real validation coverage/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BRO-5975: a same-day OLT Event is one performance, not the run end; previews year beats id year', async () => {
  const stick = { id: 'stick-man-off-west-end-2026', title: 'Stick Man', venue: 'Bloomsbury Theatre', category: 'off-west-end', market: 'west-end', openingDate: null, previewsStartDate: '2026-12-03', closingDate: '2027-01-03' };
  const one = parseLondonEvidence(eventHtml(stick, { startDate: '2026-12-03', endDate: '2026-12-03' }), stick);
  assert.equal(one.dates.closingDate, null);
  const bluebirds = { id: 'bluebirds-off-west-end-2026', title: 'Bluebirds', venue: 'Finborough Theatre', category: 'off-west-end', market: 'west-end', openingDate: null, previewsStartDate: '2027-03-30', closingDate: '2027-04-24' };
  const row = await validateLondonShow(bluebirds, {
    serpQuery: async () => [{ url: 'https://www.finboroughtheatre.co.uk/productions/bluebirds' }],
    fetchPage: async () => ({ content: eventHtml(bluebirds, { startDate: '2027-03-30', endDate: '2027-04-24' }) }),
  });
  assert.equal(row.mismatches.length, 0, JSON.stringify(row.mismatches));
});
