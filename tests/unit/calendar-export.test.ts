/**
 * Unit tests for src/lib/calendar — the .ics / Google Calendar export module.
 *
 * The DST cases are named fixtures rather than incidental dates: Apple Calendar
 * silently substitutes its own tz database when it reads a VTIMEZONE, so an
 * Apple-only manual test will happily pass over a broken rule that Google (a
 * strict parser) would reject. These assertions on resolved UTC instants are
 * what actually pin the behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIcs,
  buildGoogleCalendarUrl,
  sequenceFromTimestamp,
  wallTimeToUtc,
  parseRuntimeMinutes,
  resolveDurationMin,
  resolveTimeZone,
  encodeEventParams,
  decodeEventParams,
} from '../../src/lib/calendar';
import type { PerformanceEvent } from '../../src/lib/calendar';

const BASE: PerformanceEvent = {
  showId: 'wicked-2003',
  title: 'Wicked',
  date: '2026-09-11',
  time: '20:00',
  tz: 'America/New_York',
  durationMin: 165,
  location: '222 W 51st St, New York, NY 10019',
  showUrl: 'https://broadwayscorecard.com/show/wicked',
};

/** Fixed clock — the module is pure and never reads one itself. */
const GEN_AT = 1754870400000;

const ics = (over: Partial<PerformanceEvent> = {}, gen = GEN_AT) =>
  buildIcs({ ...BASE, ...over }, { generatedAt: gen });

test('DTSTART/DTEND carry the TZID and the end time is start + duration', () => {
  const out = ics();
  assert.match(out, /DTSTART;TZID=America\/New_York:20260911T200000/);
  assert.match(out, /DTEND;TZID=America\/New_York:20260911T224500/); // 8:00pm + 2h45
  assert.match(out, /BEGIN:VTIMEZONE/);
  assert.match(out, /TZID:America\/New_York/);
});

test('US spring-forward resolves to the correct UTC instants either side', () => {
  // 2026-03-08 is the second Sunday in March. 8pm the night before is EST
  // (UTC-5); the same wall time the next evening is EDT (UTC-4).
  assert.equal(
    new Date(wallTimeToUtc('2026-03-07', '20:00', 'America/New_York')).toISOString(),
    '2026-03-08T01:00:00.000Z',
  );
  assert.equal(
    new Date(wallTimeToUtc('2026-03-08', '20:00', 'America/New_York')).toISOString(),
    '2026-03-09T00:00:00.000Z',
  );
});

test('US fall-back resolves to the correct UTC instants either side', () => {
  assert.equal(
    new Date(wallTimeToUtc('2026-10-31', '20:00', 'America/New_York')).toISOString(),
    '2026-11-01T00:00:00.000Z',
  );
  assert.equal(
    new Date(wallTimeToUtc('2026-11-02', '20:00', 'America/New_York')).toISOString(),
    '2026-11-03T01:00:00.000Z',
  );
});

test('UK BST and GMT both resolve correctly', () => {
  // Last Sunday in March 2026 = 29th; last Sunday in October = 25th.
  assert.equal(
    new Date(wallTimeToUtc('2026-03-30', '19:30', 'Europe/London')).toISOString(),
    '2026-03-30T18:30:00.000Z',
  );
  assert.equal(
    new Date(wallTimeToUtc('2026-10-26', '19:30', 'Europe/London')).toISOString(),
    '2026-10-26T19:30:00.000Z',
  );
});

test('a time inside the spring-forward GAP resolves forward, not backward', () => {
  // 2:30 AM does not exist on 2026-03-08 in New York. A fixed two-pass loop
  // silently returned 1:30 AM EST here — an event landing an hour BEFORE the
  // requested time, before doors open. Forward resolution = 3:30 AM EDT.
  const ts = wallTimeToUtc('2026-03-08', '02:30', 'America/New_York');
  assert.equal(new Date(ts).toISOString(), '2026-03-08T07:30:00.000Z');
  const readBack = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts));
  assert.equal(readBack, '03:30');
});

test('an ambiguous fall-back time resolves to the first occurrence', () => {
  // 1:30 AM happens twice on 2026-11-01 in New York. Take the earlier one.
  const ts = wallTimeToUtc('2026-11-01', '01:30', 'America/New_York');
  assert.equal(new Date(ts).toISOString(), '2026-11-01T05:30:00.000Z'); // EDT, the first 1:30
});

test('a CRLF in showId cannot inject calendar properties through UID', () => {
  // UID is not a TEXT property, so it is written raw and escapeText never sees
  // it. `s=x%0D%0ASUMMARY:INJECTED` really did emit an attacker-controlled
  // SUMMARY line before this was fixed.
  const evil = 'x\r\nSUMMARY:INJECTED\r\nX-EVIL:1';
  assert.equal(
    decodeEventParams(new URLSearchParams([['s', evil], ['n', 'T'], ['d', '2026-09-11'], ['u', 'https://a.com']])),
    null,
    'the codec must reject a showId containing control characters',
  );
  // Defence in depth: callers that build an event straight from a DB row skip
  // the codec entirely, so the builder must scrub it too.
  const out = ics({ showId: evil });
  assert.ok(!/^SUMMARY:INJECTED/m.test(out), 'injected SUMMARY must not appear');
  assert.ok(!/^X-EVIL:1/m.test(out), 'injected property must not appear');
  // CR and LF are each replaced, hence the doubled dashes.
  assert.equal(out.match(/^UID:(.+)$/m)![1], 'bsc-x--SUMMARY-INJECTED--X-EVIL-1@broadwayscorecard.com');
  // Exactly one SUMMARY line in the whole calendar.
  assert.equal((out.match(/^SUMMARY:/gm) ?? []).length, 1);
});

test('the runtime sanity cap applies to the colon form too', () => {
  // "12:00" used to return 720 while the equivalent "12h" returned null — the
  // same duration passing or failing purely on how it was written.
  assert.equal(parseRuntimeMinutes('12:00'), null);
  assert.equal(parseRuntimeMinutes('12h'), null);
  assert.equal(parseRuntimeMinutes('8:00'), 480, '8h exactly is still allowed');
  assert.equal(parseRuntimeMinutes('0:00'), null);
});

test('a late curtain rolls the end past midnight onto the next date', () => {
  const out = ics({ time: '23:00', durationMin: 150 });
  assert.match(out, /DTSTART;TZID=America\/New_York:20260911T230000/);
  assert.match(out, /DTEND;TZID=America\/New_York:20260912T013000/);
});

test('never emits ATTENDEE or ORGANIZER, even with companions set', () => {
  // These two properties are exactly what turns a personal calendar download
  // into a real invitation email to whoever is named in them. Companions ride
  // in DESCRIPTION as plain text instead.
  const out = ics({ companions: ['Eamonn', 'Joanna'] });
  assert.ok(!/^ATTENDEE/mi.test(out), 'ATTENDEE must never be emitted');
  assert.ok(!/^ORGANIZER/mi.test(out), 'ORGANIZER must never be emitted');
  assert.match(out, /With Eamonn\\, Joanna/);
});

test('escapes RFC 5545 specials but leaves & and + alone', () => {
  const amp = ics({ title: '& Juliet', location: 'Sondheim Theatre, 124 W 43rd St' });
  assert.ok(amp.includes('& Juliet'), 'ampersand must not be HTML-escaped');
  assert.match(amp, /Sondheim Theatre\\, 124 W 43rd St/);
  assert.ok(ics({ title: 'Romeo + Juliet' }).includes('Romeo + Juliet'));
});

test('folds at 75 octets without splitting the multi-byte emoji', () => {
  const out = ics({
    title: 'The Curious Incident of the Dog in the Night-Time and Other Very Long Titles',
  });
  const enc = new TextEncoder();
  for (const line of out.split('\r\n')) {
    assert.ok(enc.encode(line).length <= 75, `line exceeds 75 octets: ${line}`);
  }
  const unfolded = out.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('🎭 The Curious Incident'));
  assert.ok(!unfolded.includes('�'), 'a multi-byte char was split mid-sequence');
});

test('an unknown market goes floating rather than naming an undefined TZID', () => {
  const out = ics({ tz: 'Australia/Sydney' });
  assert.ok(!out.includes('TZID=Australia/Sydney'), 'must not claim a zone we do not define');
  assert.match(out, /DTSTART:20260911T200000/);
  assert.ok(!out.includes('BEGIN:VTIMEZONE'));
});

test('UID excludes the date so a reschedule updates instead of duplicating', () => {
  const uid = (s: string) => s.match(/^UID:(.+)$/m)![1];
  assert.equal(uid(ics()), uid(ics({ date: '2026-10-03' })));
  assert.equal(uid(ics()).trim(), 'bsc-wicked-2003@broadwayscorecard.com');
});

test('SEQUENCE differs for two exports inside the same second', () => {
  // Plain unix seconds collide on a double-click, and RFC 5545 clients may
  // treat an equal SEQUENCE as a no-op rather than an update.
  assert.ok(sequenceFromTimestamp(1754870400890) > sequenceFromTimestamp(1754870400120));
});

test('no time set produces an all-day event with an exclusive end date', () => {
  const out = ics({ time: null });
  assert.match(out, /DTSTART;VALUE=DATE:20260911/);
  assert.match(out, /DTEND;VALUE=DATE:20260912/);
});

test('every line ends CRLF and the calendar terminates with one', () => {
  const out = ics();
  assert.ok(out.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(out), 'bare LF found — Outlook rejects LF-only calendars');
});

test('runtime parsing covers the real data shapes and rejects junk', () => {
  assert.equal(parseRuntimeMinutes('2h 30m'), 150);
  assert.equal(parseRuntimeMinutes('2h'), 120);
  assert.equal(parseRuntimeMinutes('95m'), 95);
  assert.equal(parseRuntimeMinutes('1 hr 50 min'), 110);
  assert.equal(parseRuntimeMinutes('2:30'), 150);
  assert.equal(parseRuntimeMinutes(''), null);
  assert.equal(parseRuntimeMinutes(null), null);
  assert.equal(parseRuntimeMinutes('varies'), null);
  assert.equal(parseRuntimeMinutes('30h'), null, 'absurd runtimes are data corruption');
  // 78% of shows have no runtime at all, so the defaulted path is the common one.
  assert.equal(resolveDurationMin('2h 30m'), 165);
  assert.equal(resolveDurationMin(null), 165);
});

test('market resolution maps the four categories and nothing else', () => {
  assert.equal(resolveTimeZone('broadway'), 'America/New_York');
  assert.equal(resolveTimeZone('off-broadway'), 'America/New_York');
  assert.equal(resolveTimeZone('west-end'), 'Europe/London');
  assert.equal(resolveTimeZone('off-west-end'), 'Europe/London');
  assert.equal(resolveTimeZone('opera'), null);
  assert.equal(resolveTimeZone(null), null);
});

test('the param codec round-trips and fails closed on bad input', () => {
  assert.deepEqual(decodeEventParams(encodeEventParams(BASE)), BASE);
  const bad = [
    'd=2026-02-31&s=x&n=T&u=https://a.com',        // date that does not exist
    'd=2026-09-11&s=x&n=T&u=javascript:alert(1)',  // non-http scheme
    'd=not-a-date&s=x&n=T&u=https://a.com',
    'd=2026-09-11&s=x&n=T&u=https://a.com&t=25:00',
    'd=2026-09-11&s=x&n=T&u=https://a.com&m=0',
    's=x&n=T&u=https://a.com',                     // missing date
  ];
  for (const q of bad) {
    assert.equal(decodeEventParams(new URLSearchParams(q)), null, `should reject: ${q}`);
  }
});

test('the Google template URL carries ctz and a matching window', () => {
  const url = new URL(buildGoogleCalendarUrl(BASE));
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('ctz'), 'America/New_York');
  assert.equal(url.searchParams.get('dates'), '20260911T200000/20260911T224500');
  assert.match(url.searchParams.get('text')!, /Wicked/);
});
