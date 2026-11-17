import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { commercialHealth, buildCommercialWeekly } = createRequire(import.meta.url)('../../scripts/lib/commercial-weekly');

const outcome = { label: 'Miracle', description: 'Long-running hit', textClass: 'text-status-open' };
const show = (slug, extra = {}) => ({ slug, title: slug, category: 'broadway', status: 'open', startDate: '2020-01-01', breakEven: 100, outcome, ...extra });
const row = (gross, performances = 8) => ({ gross, performances });
function input(shows = [show('a')]) {
  return {
    shows, weekEnding: '2026-10-25', today: '2026-10-30', maxAgeDays: 10, healthAvailable: true,
    weeks: Object.fromEntries(['2026-10-25', '2026-10-18', '2026-10-11', '2026-10-04'].map(week => [week, Object.fromEntries(shows.map(s => [s.slug, row(120)]))])),
  };
}

test('all five tiers use one break-even ratio, including exact boundaries', () => {
  for (const [gross, tier] of [[150, 'Blockbuster'], [149, 'Healthy'], [110, 'Healthy'], [109, 'Holding'], [90, 'Holding'], [89, 'Struggling'], [70, 'Struggling'], [69, 'Critical']]) {
    assert.equal(commercialHealth(gross, 100), tier);
  }
  for (const bad of [null, undefined, 0, -1, NaN, Infinity, '100']) {
    assert.equal(commercialHealth(100, bad), null);
    assert.equal(commercialHealth(bad, 100), null);
  }
});

test('ranks by dollar change, separates direction, caps each list at three', () => {
  const fixture = input(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'flat'].map(s => show(s)));
  for (const [slug, gross] of Object.entries({ a: 160, b: 150, c: 140, d: 130, e: 110, f: 100, g: 90, h: 80 })) fixture.weeks['2026-10-25'][slug] = row(gross);
  const result = buildCommercialWeekly(fixture);
  assert.deepEqual(result.movers.map(s => s.slug), ['a', 'b', 'c']);
  assert.deepEqual(result.fallers.map(s => s.slug), ['h', 'g', 'f']);
  assert.equal(result.movers[0].change, 40);
  assert.equal(result.movers[0].changePct, 40 / 120 * 100);
  // A large absolute increase outranks a larger percentage increase.
  fixture.weeks['2026-10-18'].a = row(1_000);
  fixture.weeks['2026-10-25'].a = row(1_100);
  assert.equal(buildCommercialWeekly(fixture).movers[0].slug, 'a');
});

test('index counts rated shows equally and preserves an independent run outcome', () => {
  const fixture = input([show('hit'), show('struggling'), show('no-cost', { breakEven: null })]);
  for (const week of Object.values(fixture.weeks)) week.struggling = row(80);
  const result = buildCommercialWeekly(fixture);
  assert.equal(result.index, 50);
  assert.equal(result.reportingCount, 3);
  assert.equal(result.ratedCount, 2);
  assert.equal(result.healthyCount, 1);
  assert.equal(result.shows[1].health, 'Struggling');
  assert.deepEqual(result.shows[1].outcome, outcome);
  assert.equal(result.shows[2].healthReason, 'Cost unavailable');
});

test('missing or zero prior gross cannot become a faller or a mover', () => {
  for (const previous of [undefined, row(0), row(null), row(NaN), row(Infinity), row(-1)]) {
    const fixture = input();
    fixture.weeks['2026-10-18'].a = previous;
    const result = buildCommercialWeekly(fixture);
    assert.equal(result.shows[0].change, null);
    assert.equal(result.shows[0].health, null);
    assert.deepEqual(result.movers, []);
    assert.deepEqual(result.fallers, []);
  }
});

test('a missing calendar week never substitutes an older week', () => {
  const fixture = input();
  delete fixture.weeks['2026-10-18'];
  const result = buildCommercialWeekly(fixture);
  assert.equal(result.shows[0].change, null);
  assert.equal(result.index, null);
});

test('missing performance counts preserve reported gross movement but withhold health', () => {
  for (const performances of [0, null, undefined, NaN, Infinity]) {
    const fixture = input();
    fixture.weeks['2026-10-18'].a = { gross: 100, performances };
    const result = buildCommercialWeekly(fixture);
    assert.equal(result.movers[0].change, 20);
    assert.equal(result.movers[0].health, null);
    assert.equal(result.index, null);
  }
});

// RULE21: the old file-exists acceptance passed on an unlanded branch and
// proved neither rendering nor wiring. Pin the caller as well as the maths.
test('the Commercial dashboard mounts the snapshot component inside its existing money gate', () => {
  const page = readFileSync(new URL('../../src/app/biz/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /import CommercialScorecard from '@\/components\/CommercialScorecard'/);
  assert.match(page, /<MoneyGate page="biz-dashboard">\s*<CommercialScorecard snapshot=\{getCommercialWeeklySnapshot\(today\)\} \/>/);
  const data = readFileSync(new URL('../../src/lib/data-commercial.ts', import.meta.url), 'utf8');
  assert.match(data, /export function getCommercialWeeklySnapshot\(/);
  assert.match(data, /return buildCommercialWeekly\(/);
  assert.match(data, /healthAvailable: staleInputReasons\(/);
});

test('stale costs withhold health and the index while keeping reported gross movement', () => {
  const fixture = input();
  fixture.healthAvailable = false;
  fixture.weeks['2026-10-25'].a = row(200);
  const result = buildCommercialWeekly(fixture);
  assert.equal(result.index, null);
  assert.equal(result.ratedCount, 0);
  assert.equal(result.movers[0].change, 80);
  assert.equal(result.movers[0].healthReason, 'Cost data is out of date');
});

test('short performance weeks keep actual movement but cannot receive a health tier', () => {
  const fixture = input();
  fixture.weeks['2026-10-25'].a = row(60, 4);
  const result = buildCommercialWeekly(fixture);
  assert.equal(result.fallers[0].change, -60);
  assert.equal(result.fallers[0].healthReason, 'Needs four full weeks');
  assert.equal(result.index, null);
});

test('new runs cannot inherit old weeks, while previews can appear as movers', () => {
  const fixture = input([show('a', { startDate: '2026-10-20', status: 'previews' })]);
  let result = buildCommercialWeekly(fixture);
  assert.equal(result.reportingCount, 1);
  assert.equal(result.shows[0].health, null);
  assert.equal(result.shows[0].change, null);
  fixture.shows[0].startDate = '2026-10-13';
  fixture.weeks['2026-10-25'].a = row(160);
  result = buildCommercialWeekly(fixture);
  assert.equal(result.movers.length, 1);
  assert.equal(result.movers[0].health, null);
});

test('only reporting, running Broadway productions count, once per slug', () => {
  const fixture = input([show('a'), show('closed', { status: 'closed' }), show('london', { category: 'west-end' }), show('future', { startDate: '2026-11-01' }), show('missing'), show('zero')]);
  delete fixture.weeks['2026-10-25'].missing;
  fixture.weeks['2026-10-25'].zero = row(0);
  fixture.shows.push(show('a'));
  const result = buildCommercialWeekly(fixture);
  assert.deepEqual(result.shows.map(s => s.slug), ['a']);
});

test('stale, future, missing and mismatched feeds withhold the whole snapshot', () => {
  for (const overrides of [{ today: '2026-11-05' }, { today: '2026-10-24' }, { weekEnding: null }, { weekEnding: '2026-10-18' }, { weeks: {} }]) {
    const result = buildCommercialWeekly({ ...input(), ...overrides });
    assert.ok(result.unavailableReason);
    assert.equal(result.index, null);
    assert.deepEqual(result.shows, []);
    assert.deepEqual(result.movers, []);
    assert.deepEqual(result.fallers, []);
  }
});

test('empty coverage is unavailable, while a genuinely weak market can score zero', () => {
  assert.equal(buildCommercialWeekly(input([])).index, null);
  const fixture = input();
  for (const week of Object.values(fixture.weeks)) week.a = row(60);
  assert.equal(buildCommercialWeekly(fixture).index, 0);
});

test('ties sort by title and neither show inputs nor history are mutated', () => {
  const fixture = input([show('z'), show('a')]);
  fixture.weeks['2026-10-25'] = { z: row(150), a: row(150) };
  const before = JSON.stringify(fixture);
  assert.deepEqual(buildCommercialWeekly(fixture).movers.map(s => s.slug), ['a', 'z']);
  assert.equal(JSON.stringify(fixture), before);
});

test('the real component renders health beside run outcome and handles unavailable data', async () => {
  const { require: tsRequire } = await import('tsx/cjs/api');
  const require = createRequire(import.meta.url);
  const { createElement } = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { AppRouterContext } = tsRequire('next/dist/shared/lib/app-router-context.shared-runtime', import.meta.url);
  const CommercialScorecard = tsRequire('../../src/components/CommercialScorecard.tsx', import.meta.url).default;
  const render = (snapshot) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { push() {} } }, createElement(CommercialScorecard, { snapshot })));
  const fixture = input();
  fixture.weeks['2026-10-25'].a = row(80);
  const html = render(buildCommercialWeekly(fixture));
  assert.match(html, /Broadway Market Health Index/);
  assert.match(html, /Weekly Movers &amp; Fallers/);
  assert.match(html, /Current health/);
  assert.match(html, /Healthy/);
  assert.match(html, /Run outcome/);
  assert.match(html, /Miracle/);
  assert.match(html, /href="\/show\/a"/);
  const unavailable = render(buildCommercialWeekly({ ...fixture, weekEnding: null }));
  assert.match(unavailable, /Weekly grosses are not available yet/);
  assert.doesNotMatch(unavailable, /data-testid="market-health"/);
  assert.match(render(buildCommercialWeekly(input([]))), /Not enough data to rate market health yet/);
  fixture.shows[0].outcome = { ...outcome, caveat: 'Our estimate, not a reported result.' };
  assert.match(render(buildCommercialWeekly(fixture)), /<p[^>]*>Our estimate, not a reported result\.<\/p>/);
});
