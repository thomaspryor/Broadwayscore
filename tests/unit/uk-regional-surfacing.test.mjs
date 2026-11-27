// LIVE-DATA-LANE: reads data/site-image-versions.json (untracked core data); data/grosses.json (untracked core data); data/audience-buzz.json (untracked core data); +7 more. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-6713: UK Regional (Beyond London, /browse/beyond-london) must be reachable from every
// place the site links between markets. Before this, the header dropdown and footer had no entry
// and a visitor could only find the page through a West End shelf. Source-level guard: the link
// is a literal href in each component, so a refactor that drops one fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const SURFACES = [
  ['header market dropdown', 'src/components/MarketNav.tsx'],
  ['footer link columns', 'src/components/FooterMarketContent.tsx'],
  ['footer explore cards', 'src/components/FooterExploreCards.tsx'],
  ['West End page shelf', 'src/components/WestEndPageClient.tsx'],
];

for (const [name, file] of SURFACES) {
  test(`${name} links to /browse/beyond-london`, () => {
    assert.match(read(file), /\/browse\/beyond-london/, `${file} has no Beyond London link`);
  });
}

test('market stats feed the dropdown count from the page gate', () => {
  const core = read('src/lib/data-core.ts');
  assert.match(core, /ukRegional:\s*\{[\s\S]*pickRegionalShelf\(ukRegional,[\s\S]*requireEnoughReviews: true/);
  assert.match(read('src/components/MarketNav.tsx'), /ukRegional\?:\s*\{ shows: number; openShows: number \}/);
});

test('UK Regional is not also marked as the active West End row', () => {
  const nav = read('src/components/MarketNav.tsx');
  assert.match(nav, /isWestEnd && !isUkRegional/);
});

// The Beyond London page renders section headings (On Stage Now / Opened YYYY) only while each
// label is one contiguous run in the displayed order. Real list, real config, real helper.
import { BROWSE_PAGES } from '../../src/config/browse-pages';
import { getBrowseList, getShowById, getMarketStats } from '../../src/lib/data-core';
import { sectionLabelsContiguous } from '../../src/lib/browse-sections';

test('Beyond London section headings are contiguous in list order', () => {
  const config = BROWSE_PAGES['beyond-london'];
  assert.equal(typeof config.sectionGroup, 'function');
  const list = getBrowseList('beyond-london');
  assert.ok(list && list.shows.length > 0);
  const labels = list.shows.map((s) => config.sectionGroup(s, getShowById));
  assert.ok(sectionLabelsContiguous(labels), `labels interleave: ${[...new Set(labels)].join(' | ')}`);
  assert.ok(labels.some((l) => l.startsWith('Opened ')), 'expected at least one Opened YYYY heading');
});

test('dropdown count equals the page count', () => {
  const list = getBrowseList('beyond-london');
  assert.equal(getMarketStats().ukRegional.shows, list.shows.length);
});

// BRO-8411: the Australia menu row shows the same count the Australian Theatre page lists.
// The page is behind the `regional` flag, which this process may not have, so the real
// data-core runs in a tsx child with the flag on (flags are read at module load).
test('Australia dropdown count equals the page count', async () => {
  const { spawnSync } = await import('node:child_process');
  const coreUrl = new URL('../../src/lib/data-core.ts', import.meta.url).href;
  const child = `const m = await import(${JSON.stringify(coreUrl)});
const list = m.getBrowseList('australian-theatre');
console.log('RESULT:' + JSON.stringify({ page: list ? list.shows.length : null, menu: m.getMarketStats().auRegional.shows }));`;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child], {
    cwd: new URL('../..', import.meta.url).pathname,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, NEXT_PUBLIC_FEATURES: 'regional', NODE_TEST_CONTEXT: undefined },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('RESULT:'));
  assert.ok(line, `child failed: ${(run.stderr || '').slice(-800)}`);
  const { page, menu } = JSON.parse(line.slice(7));
  assert.ok(page !== null, 'australian-theatre list missing with regional flag on');
  assert.ok(page > 0, 'expected at least one listed Australian show');
  assert.equal(menu, page);
});
