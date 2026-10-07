/**
 * GET /api/calendar.ics gating (BRO-4481): all-day events are always served,
 * timed events only with CALENDAR_EXPORT_ENABLED=1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET } from '../../src/app/api/calendar.ics/route';
import { isCalendarEventOffered, isCalendarExportAllowed } from '../../src/lib/calendar-route-gate';
import { encodeEventParams, type PerformanceEvent } from '../../src/lib/calendar';

const BASE: PerformanceEvent = {
  showId: 'wicked-2003', title: 'Wicked', date: '2026-10-18', time: null, tz: 'America/New_York',
  durationMin: 180, location: '222 W 51st St', showUrl: 'https://broadwayscorecard.com/show/wicked',
};

function req(ev: PerformanceEvent) {
  return new NextRequest(`https://broadwayscorecard.com/api/calendar.ics?${encodeEventParams(ev).toString()}`);
}

async function withEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CALENDAR_EXPORT_ENABLED;
  if (value === undefined) delete process.env.CALENDAR_EXPORT_ENABLED;
  else process.env.CALENDAR_EXPORT_ENABLED = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.CALENDAR_EXPORT_ENABLED;
    else process.env.CALENDAR_EXPORT_ENABLED = prev;
  }
}

test('gate: all-day always allowed; timed only with the env flag', () => {
  assert.equal(isCalendarExportAllowed({ time: null }, {}), true);
  assert.equal(isCalendarExportAllowed({ time: '20:00' }, {}), false);
  assert.equal(isCalendarExportAllowed({ time: '20:00' }, { CALENDAR_EXPORT_ENABLED: '0' }), false);
  assert.equal(isCalendarExportAllowed({ time: '20:00' }, { CALENDAR_EXPORT_ENABLED: '1' }), true);
});

test('route, env unset: all-day → 200 text/calendar with VALUE=DATE', async () => {
  const res = await withEnv(undefined, () => GET(req(BASE)));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/calendar/);
  const body = await res.text();
  assert.match(body, /DTSTART;VALUE=DATE:20261018/);
});

test('route, env unset: timed → 404 (feature still unlaunched)', async () => {
  const res = await withEnv(undefined, () => GET(req({ ...BASE, time: '20:00' })));
  assert.equal(res.status, 404);
});

test('route, env on: timed → 200', async () => {
  const res = await withEnv('1', () => GET(req({ ...BASE, time: '20:00' })));
  assert.equal(res.status, 200);
});

test('route: malformed params → 400 regardless of env', async () => {
  const bad = new NextRequest('https://broadwayscorecard.com/api/calendar.ics?s=wicked-2003&d=2026-13-45');
  assert.equal((await withEnv(undefined, () => GET(bad))).status, 400);
});

test('button rule matches the route: all-day always offered, timed only with the flag', () => {
  assert.equal(isCalendarEventOffered({ time: null }, false), true);
  assert.equal(isCalendarEventOffered({ time: '20:00' }, false), false);
  assert.equal(isCalendarEventOffered({ time: '20:00' }, true), true);
  // AddToCalendarButtons must use this rule rather than each caller gating it.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../src/components/user/AddToCalendarButtons.tsx'), 'utf8');
  assert.match(src, /isCalendarEventOffered\(event, featureFlags\.calendarExport\)/);
});
