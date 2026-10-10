/**
 * BRO-712: the five browse pages that group their list under H2 headings
 * (closing soon, ticket prices, longest running, new 2026, best all time).
 *
 * The page renders one H2 per distinct label returned by config.sectionGroup and
 * only for shows that exist, so "H2 headers match the configured groupings" and
 * "no empty sections" reduce to: every target page defines a grouping, every show
 * gets a non-empty label, equal inputs share a label, different bands get different
 * labels, and (for ticket prices, which sorts by a value the label is derived from)
 * a label never reappears after another one starts.
 *
 * browse-pages.ts imports through the `@/` alias, which plain `node --test`
 * cannot resolve, so the real config is loaded in a tsx child process. That keeps
 * `node --test tests/unit/browse-pages-section-groups.test.mjs` (the card's
 * VERIFY form) working without copying any grouping logic into this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { sectionLabelsContiguous } = require('../../src/lib/browse-sections.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG_URL = pathToFileURL(path.join(ROOT, 'src/config/browse-pages.ts')).href;

const CHILD = `
process.env.NEXT_PUBLIC_FEATURES = '';
const mod = await import(${JSON.stringify(CONFIG_URL)});
const BROWSE_PAGES = mod.BROWSE_PAGES ?? mod.default?.BROWSE_PAGES;
const out = {};
const mk = (o) => ({ slug: 's', status: 'open', ...o });

const atp = { a: 210, b: 160, c: 120, d: 99, e: 40, z: 0 };
const ctx = { getShowGrosses: (slug) => ({ thisWeek: { atp: atp[slug] } }) };
const tp = BROWSE_PAGES['broadway-ticket-prices'];
const priced = ['e', 'a', 'd', 'b', 'z', 'c'].map((slug) => mk({ slug }));
const kept = priced.filter((s) => tp.dataFilter(s, ctx));
const sorted = tp.customSort([...kept], ctx);
out.tickets = {
  keptSlugs: kept.map((s) => s.slug),
  sortedLabels: sorted.map((s) => tp.sectionGroup(s, undefined, ctx)),
  noCtxLabel: tp.sectionGroup(mk({ slug: 'a' })),
};

const label = (slug, show) => BROWSE_PAGES[slug].sectionGroup(show, undefined, ctx);
out.closing = [
  label('broadway-shows-closing-soon', mk({ closingDate: '2026-04-05' })),
  label('broadway-shows-closing-soon', mk({ closingDate: '2026-04-25' })),
  label('broadway-shows-closing-soon', mk({ closingDate: '2026-05-10' })),
  label('broadway-shows-closing-soon', mk({})),
];
out.longest = [1996, 2004, 2012, 2024].map((y) => label('longest-running-broadway-shows', mk({ openingDate: y + '-06-15' })));
out.new2026 = ['2026-01-10', '2026-01-28', '2026-03-02'].map((d) => label('new-broadway-shows-2026', mk({ openingDate: d })));
const rated = (score, reviewCount = 30) => mk({ id: 'x-' + score, category: 'broadway', criticScore: { score, reviewCount, tier1Count: 8, tier2Count: 8 } });
out.best = [95, 85, 75, 60].map((score) => label('best-broadway-shows-all-time', rated(score)));
out.bestTooFew = label('best-broadway-shows-all-time', rated(92, 1));
out.hasGrouping = Object.fromEntries(
  ['broadway-shows-closing-soon', 'broadway-ticket-prices', 'longest-running-broadway-shows', 'new-broadway-shows-2026', 'best-broadway-shows-all-time']
    .map((s) => [s, typeof BROWSE_PAGES[s]?.sectionGroup === 'function']));
out.groupedPages = Object.values(BROWSE_PAGES).filter((c) => typeof c.sectionGroup === 'function').length;
console.log('RESULT:' + JSON.stringify(out));
`;

const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', CHILD], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 120000,
  env: { ...process.env, NODE_TEST_CONTEXT: undefined },
});
const line = (run.stdout || '').split('\n').find((l) => l.startsWith('RESULT:'));
const result = line ? JSON.parse(line.slice('RESULT:'.length)) : null;

test('the real browse config loads in the tsx child', () => {
  assert.ok(result, `child produced no result (status ${run.status}):\n${(run.stderr || '').slice(-1500)}`);
});

test('all five target pages define a sectionGroup', () => {
  for (const [slug, ok] of Object.entries(result.hasGrouping)) assert.equal(ok, true, `${slug} has no sectionGroup`);
});

test('other grouped browse pages are still present (runtimes, age guide and the rest keep their grouping)', () => {
  // 8 grouped pages existed before this change; the ticket-price page makes 9.
  assert.ok(result.groupedPages >= 9, `expected at least 9 pages with a sectionGroup, got ${result.groupedPages}`);
});

test('ticket prices: bands follow the sort, none is empty, zero-ATP shows are filtered out', () => {
  const t = result.tickets;
  assert.deepEqual(t.keptSlugs, ['e', 'a', 'd', 'b', 'c'], 'dataFilter must drop the zero-ATP show');
  assert.deepEqual(t.sortedLabels, ['$150 and Up', '$150 and Up', '$100 to $150', 'Under $100', 'Under $100']);
  const seen = [];
  for (const l of t.sortedLabels) {
    if (seen[seen.length - 1] !== l) {
      assert.ok(!seen.includes(l), `label "${l}" reappears after another label started (non-contiguous)`);
      seen.push(l);
    }
  }
  assert.ok(t.sortedLabels.every((l) => typeof l === 'string' && l.length > 0));
});

test('ticket prices: a caller that passes no context gets a label, not a crash', () => {
  assert.equal(result.tickets.noCtxLabel, 'Under $100');
});

test('closing soon: same month shares a label, a new month and a missing date get their own', () => {
  const [a, b, c, d] = result.closing;
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(d, 'Closing Date TBD');
  assert.ok([a, c, d].every((l) => typeof l === 'string' && l.length > 0));
});

test('longest running: one label per decade bucket', () => {
  assert.equal(new Set(result.longest).size, 4);
  assert.deepEqual(result.longest, ['Opened Before 2000', 'Opened in the 2000s', 'Opened in the 2010s', 'Opened in the 2020s']);
});

test('new 2026: grouped by opening month', () => {
  const [a, b, c] = result.new2026;
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^Opened in /);
});

test('best all time: one label per score band', () => {
  assert.equal(new Set(result.best).size, 4);
  assert.deepEqual(result.best, ['Legendary (90+)', 'Must-See (80-89)', 'Highly Rated (70-79)', 'Worth Seeing (Under 70)']);
});

test('best all time: a high raw score with too few reviews goes to the last section, not a score band', () => {
  // The client shows these as TBD and sorts them to the bottom, so labelling them
  // by raw score put a second "Legendary" heading under the unrated tail.
  assert.equal(result.bestTooFew, 'Not Enough Reviews Yet');
});

// The five pages above only show their H2s because the component renders a heading
// whenever the labels are contiguous in the order on screen (it used to guess from
// the sort state, which hid the headings on closing soon, longest running and new 2026).
test('sectionLabelsContiguous: one run per label renders headings', () => {
  assert.equal(sectionLabelsContiguous(['A', 'A', 'B', 'C', 'C']), true);
  assert.equal(sectionLabelsContiguous(['only']), true);
});

test('sectionLabelsContiguous: a label that returns later means no headings (no duplicated H2s)', () => {
  assert.equal(sectionLabelsContiguous(['In Previews Now', 'Coming Soon', 'In Previews Now', 'Coming Soon']), false);
  assert.equal(sectionLabelsContiguous(['A', 'B', 'A']), false);
});

test('sectionLabelsContiguous: no labels, an empty list or a missing label means no headings', () => {
  assert.equal(sectionLabelsContiguous(undefined), false);
  assert.equal(sectionLabelsContiguous([]), false);
  assert.equal(sectionLabelsContiguous(['A', undefined, 'B']), false);
  assert.equal(sectionLabelsContiguous(['A', '', 'B']), false);
});

test('BrowseListClient decides headings with the shared helper, not the old sort-state guess', () => {
  const src = readFileSync(path.join(ROOT, 'src/components/BrowseListClient.tsx'), 'utf8');
  assert.match(src, /sectionLabelsContiguous\(/);
  assert.doesNotMatch(src, /sort === 'custom' \|\| sort === 'score'/, 'the sort-state heuristic hides headings on pages whose default is closing/performances/opening-date');
});
