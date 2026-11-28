// BRO-7890 item 4: normalizeDate took the UTC day of a timestamp. A New York review posted at 10pm ET is 03:00Z the
// next day, so it was stored a day late. It must give the market's calendar day, on any machine time zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'lib', 'date-utils.js');

const CASES = [
  // [input, opts, expected]
  ['2026-11-20T03:00:00Z', undefined, '2026-11-19'], // 10pm ET on press night
  ['2026-11-20T03:00:00.000Z', { market: 'broadway' }, '2026-11-19'],
  ['2026-11-20T03:00:00Z', { market: 'west-end' }, '2026-11-20'], // 3am London is already the 20th
  ['2026-11-20T03:00:00+00:00', { url: 'https://www.theguardian.com/stage/x' }, '2026-11-20'],
  ['2026-11-19T22:00:00-05:00', undefined, '2026-11-19'], // explicit local offset keeps its day
  ['2026-11-20T00:00:00Z', undefined, '2026-11-20'], // midnight UTC is a date-only value
  ['2026-02-11T05:00:00Z', undefined, '2026-02-11'],
  ['Thu, 20 Nov 2026 03:30:00 GMT', undefined, '2026-11-19'],
  ['Wed, 19 Nov 2026 22:30:00 -0500', undefined, '2026-11-19'],
  ['November 19, 2026 11:25 PM', undefined, '2026-11-19'], // zoneless written time: the written day
  ['Nov 20, 2026 1:00 AM', undefined, '2026-11-20'],
  ['November 19th, 2026', undefined, '2026-11-19'],
  ['2026-11-19', undefined, '2026-11-19'],
  ['Wed, 19 Nov 2026 19:00:00 -0500', undefined, '2026-11-19'], // 00:00Z, but a real 7pm ET time
  ['November 19, 2026 7:00 PM EST', undefined, '2026-11-19'],
  ['Thu, 20 Nov 2026 00:00:00 GMT', undefined, '2026-11-20'], // UTC-written midnight = date-only
];

for (const tz of ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo']) {
  test(`normalizeDate gives the market day on a ${tz} machine`, () => {
    const out = execFileSync(process.execPath, ['-e', `
      const { normalizeDate } = require(${JSON.stringify(LIB)});
      const cases = ${JSON.stringify(CASES)};
      console.log(JSON.stringify(cases.map(([s, o]) => normalizeDate(s, o))));
    `], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    const got = JSON.parse(out);
    CASES.forEach(([s, o, want], i) => assert.equal(got[i], want, `${s} ${JSON.stringify(o || {})}`));
  });
}

// The lane's publish converter and the rebuild must agree, or a lane-published day flips on the next full rebuild.
test('lane calendarDateIn and rebuild normalizeDate agree on zoned stamps', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { normalizeDate } = require(LIB);
  const { calendarDateIn } = require(path.resolve(path.dirname(LIB), 'opening-night-lane', 'trust-model.js'));
  for (const stamp of ['2026-11-20T00:00:00Z', '2026-11-20T03:00:00Z', '2026-11-20T03:00:00.000Z', '2026-11-19T22:00:00-05:00', '2026-11-20T23:30:00+00:00']) {
    for (const timeZone of ['America/New_York', 'Europe/London']) {
      assert.equal(calendarDateIn(stamp, timeZone), normalizeDate(stamp, { timeZone }), `${stamp} in ${timeZone}`);
    }
  }
});

test('classifyPublishDateFormat: only YYYY-MM-DD and YYYY-MM are stored shapes', async () => {
  const { createRequire } = await import('node:module');
  const { classifyPublishDateFormat } = createRequire(import.meta.url)(LIB);
  assert.equal(classifyPublishDateFormat('2026-11-19'), 'day');
  assert.equal(classifyPublishDateFormat('2016-03'), 'month');
  assert.equal(classifyPublishDateFormat('2026-11-20T03:00:00.000Z'), 'other');
  assert.equal(classifyPublishDateFormat('November 19, 2026'), 'other');
});

test('tzForShow: a regional show is dated in its own city zone, not New York (BRO-7890 review P1)', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { tzForShow } = req('../../scripts/lib/local-date.js');
  const { normalizeDate } = req(LIB);
  assert.equal(tzForShow({ category: 'regional', city: 'glasgow-uk' }), 'Europe/London');
  assert.equal(tzForShow({ category: 'regional', city: 'chicago-il' }), 'America/Chicago');
  assert.equal(tzForShow({ category: 'regional', city: 'los-angeles-ca' }), 'America/Los_Angeles');
  assert.equal(tzForShow({ category: 'regional', city: 'boston-ma' }), 'America/New_York');
  assert.equal(tzForShow({ category: 'regional' }), null); // no city: fall back to the publisher host
  assert.equal(tzForShow({ category: 'west-end' }), 'Europe/London');
  assert.equal(tzForShow({ category: 'off-west-end' }), 'Europe/London');
  assert.equal(tzForShow({ category: 'broadway' }), 'America/New_York');
  // 03:00 GMT is still the 20th in Glasgow, the 19th in Chicago.
  const stamp = 'Thu, 20 Nov 2026 03:00:00 GMT';
  assert.equal(normalizeDate(stamp, { timeZone: tzForShow({ category: 'regional', city: 'glasgow-uk' }) }), '2026-11-20');
  assert.equal(normalizeDate(stamp, { timeZone: tzForShow({ category: 'regional', city: 'chicago-il' }) }), '2026-11-19');
});
