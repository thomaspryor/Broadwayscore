// Tests for scripts/lib/todaytix-runtime.js — TodayTix page runtime extraction.
// Background: the TT REST API's runningTime can be stale (Birthright 2026-07:
// API said 90 min, page said "3hr 30min. Incl. 2 Intermissions.") so the page
// display string is the authoritative source. These formats are real strings
// captured from todaytix.com show pages on 2026-07-20.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractRunTimeDisplay,
  parseRunTimeDisplay,
  parseCompactRuntime,
  formatCompactRuntime,
  todaytixPageUrl,
} = require('../../scripts/lib/todaytix-runtime.js');

test('parseRunTimeDisplay: standard hr+min with intermission count', () => {
  assert.deepStrictEqual(parseRunTimeDisplay('3hr 30min. Incl. 2 Intermissions.'), {
    minutes: 210, runtime: '3h 30m', intermissions: 2,
  });
});

test('parseRunTimeDisplay: no intermission', () => {
  assert.deepStrictEqual(parseRunTimeDisplay('1hr 40min. No intermission.'), {
    minutes: 100, runtime: '1h 40m', intermissions: 0,
  });
});

test('parseRunTimeDisplay: interval-length minutes must not pollute runtime or count', () => {
  // "15min" here is the interval LENGTH, not part of the runtime and not a count
  assert.deepStrictEqual(parseRunTimeDisplay('1hr 50min. Incl. 15min intermission.'), {
    minutes: 110, runtime: '1h 50m', intermissions: 1,
  });
});

test('parseRunTimeDisplay: spelled-out interval counts (UK pages)', () => {
  assert.strictEqual(parseRunTimeDisplay('2hr 30min. Incl. Two intervals.').intermissions, 2);
  assert.strictEqual(parseRunTimeDisplay('3hr. Incl. two intermissions.').intermissions, 2);
});

test('parseRunTimeDisplay: bare "Incl. intermission" means one', () => {
  assert.deepStrictEqual(parseRunTimeDisplay('2hr 15min. Incl. intermission.'), {
    minutes: 135, runtime: '2h 15m', intermissions: 1,
  });
});

test('parseRunTimeDisplay: range takes the lower bound', () => {
  const r = parseRunTimeDisplay('2hr 50min. (Approx.) to 3hr 10min. Incl. 1 intermission.');
  assert.strictEqual(r.minutes, 170);
  assert.strictEqual(r.intermissions, 1);
});

test('parseRunTimeDisplay: minutes-only and hour-only forms', () => {
  assert.strictEqual(parseRunTimeDisplay('90min.').minutes, 90);
  assert.strictEqual(parseRunTimeDisplay('2hr. Incl. 15min intermission.').minutes, 120);
});

test('parseRunTimeDisplay: bare "h" and prose-hours forms (caught live 2026-07-20)', () => {
  // "2h 05min" parsed as 5 minutes before the h(?:ours?|rs?)? fix
  assert.deepStrictEqual(parseRunTimeDisplay('2h 05min. Incl. 1 Interval'), {
    minutes: 125, runtime: '2h 5m', intermissions: 1,
  });
  assert.deepStrictEqual(parseRunTimeDisplay('2 Hours and 20 Minutes, including 20 minute interval.'), {
    minutes: 140, runtime: '2h 20m', intermissions: 1,
  });
  assert.strictEqual(parseRunTimeDisplay('2hr 40 min. Including a 20 minutes interval.').minutes, 160);
});

test('parseRunTimeDisplay: multi-part listings return null (no single honest number)', () => {
  // Cursed Child — first-segment parse would stamp Part One's time as the whole runtime
  assert.strictEqual(parseRunTimeDisplay('Part One: 2hr 45min. &amp; Part Two: 2hr 35min.'), null);
});

test('parseRunTimeDisplay: garbage and out-of-range rejected', () => {
  assert.strictEqual(parseRunTimeDisplay('TBD'), null);
  assert.strictEqual(parseRunTimeDisplay(''), null);
  assert.strictEqual(parseRunTimeDisplay(null), null);
  assert.strictEqual(parseRunTimeDisplay('9hr 30min.'), null); // >300 min = parse noise
});

test('extractRunTimeDisplay: visible Run time section', () => {
  const html = '<div class="x" data-test-id="section-Run time"><h2 class="y" data-test-id="title-Run time">Run time</h2><div class="z" id=""><p>3hr 30min. Incl. 2 Intermissions.</p></div></div>';
  assert.strictEqual(extractRunTimeDisplay(html), '3hr 30min. Incl. 2 Intermissions.');
});

test('extractRunTimeDisplay: JSON-LD FAQ fallback scoped to the show question', () => {
  const html = '{"@type":"Question","name":"What is the running time of Birthright?","acceptedAnswer":{"@type":"Answer","text":"Birthright runs for 3hr 30min. Incl. 2 Intermissions."}}';
  assert.strictEqual(extractRunTimeDisplay(html), '3hr 30min. Incl. 2 Intermissions.');
});

test('extractRunTimeDisplay: raw CMS field alone is NOT trusted (carousel contamination)', () => {
  // Pages embed runTimeAndIntermission for related/carousel shows too — an
  // unscoped first-match can return a different show's runtime. Fail closed.
  const html = '{"runTimeAndIntermission":"1hr 30min. No intermission."}';
  assert.strictEqual(extractRunTimeDisplay(html), null);
});

test('extractRunTimeDisplay: missing → null', () => {
  assert.strictEqual(extractRunTimeDisplay('<html><body>nothing here</body></html>'), null);
  assert.strictEqual(extractRunTimeDisplay(null), null);
});

test('todaytixPageUrl: stored URL wins; fallback is market-aware', () => {
  assert.strictEqual(
    todaytixPageUrl({ todaytixUrl: 'https://www.todaytix.com/nyc/shows/45341-birthright' }),
    'https://www.todaytix.com/nyc/shows/45341-birthright');
  assert.strictEqual(todaytixPageUrl({ todaytixId: 123, category: 'off-broadway' }),
    'https://www.todaytix.com/nyc/shows/123');
  assert.strictEqual(todaytixPageUrl({ todaytixId: 456, category: 'west-end' }),
    'https://www.todaytix.com/london/shows/456');
  assert.strictEqual(todaytixPageUrl({ todaytixId: 789, category: 'off-west-end' }),
    'https://www.todaytix.com/london/shows/789');
  assert.strictEqual(todaytixPageUrl({ category: 'broadway' }), null);
});

test('parseCompactRuntime round-trips with formatCompactRuntime', () => {
  assert.strictEqual(parseCompactRuntime('1h 30m'), 90);
  assert.strictEqual(parseCompactRuntime('2h'), 120);
  assert.strictEqual(parseCompactRuntime('45m'), 45);
  assert.strictEqual(parseCompactRuntime(null), null);
  assert.strictEqual(parseCompactRuntime('garbage'), null);
  assert.strictEqual(formatCompactRuntime(210), '3h 30m');
  assert.strictEqual(formatCompactRuntime(120), '2h');
  assert.strictEqual(formatCompactRuntime(45), '45m');
});
