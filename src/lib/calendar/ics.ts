import type { BuildIcsOptions, PerformanceEvent } from './types';
import { hasVTimezone, utcToWallTime, vtimezoneLines, wallTimeToUtc } from './timezone';

const DEFAULT_UID_DOMAIN = 'broadwayscorecard.com';

/**
 * RFC 5545 §3.3.11 TEXT escaping: backslash, semicolon, comma, and newlines.
 *
 * Ampersands and plus signs are NOT escaped — "& Juliet" and "Romeo + Juliet"
 * are legal TEXT as-is. They are in the test fixtures because they are the
 * titles most likely to tempt someone into HTML-escaping a calendar file.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a content line to 75 OCTETS per RFC 5545 §3.1.
 *
 * Octets, not characters: the 🎭 in every SUMMARY is four UTF-8 bytes, and a
 * naive character-count fold produces lines that are legal by length but split
 * a multi-byte sequence, which renders as a replacement glyph in the event
 * title. Continuation lines start with a single space.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const out: string[] = [];
  let current = '';
  let currentBytes = 0;
  // Continuation lines carry a leading space, so they hold one fewer octet.
  let limit = 75;

  // Iterate by code point so surrogate pairs are never split.
  for (const char of line) {
    const charBytes = encoder.encode(char).length;
    if (currentBytes + charBytes > limit) {
      out.push(current);
      current = char;
      currentBytes = charBytes;
      limit = 74;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  out.push(current);
  return out.join('\r\n ');
}

/**
 * UID is NOT a TEXT property, so it does not get escapeText's treatment — it is
 * written raw. Anything that reaches it must therefore be scrubbed of the
 * characters that would end the line and start a new calendar property.
 *
 * decodeEventParams already restricts showId to a safe charset, but this module
 * is also called directly with events built from database rows, so the
 * guarantee belongs here too rather than only at one entry point.
 */
function sanitizeUidPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'unknown';
}

/** YYYYMMDDTHHMMSS for a local wall time (no trailing Z — TZID supplies the zone). */
function icsLocal(date: string, time: string): string {
  return `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;
}

/** YYYYMMDDTHHMMSSZ for a real UTC instant. */
function icsUtc(instant: number): string {
  return `${new Date(instant).toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/** YYYYMMDD, for all-day events. */
function icsDate(date: string): string {
  return date.replace(/-/g, '');
}

/**
 * Derive a SEQUENCE that does not collide for two exports in the same second.
 * Unix seconds alone repeat on a double-click, and RFC 5545 clients may treat
 * an equal SEQUENCE as a no-op rather than an update — so the sub-second part
 * of the timestamp becomes a tie-breaker.
 */
export function sequenceFromTimestamp(nowMs: number): number {
  return Math.floor(nowMs / 1000) * 10 + Math.floor((nowMs % 1000) / 100);
}

/**
 * Build a complete VCALENDAR for one performance.
 *
 * Deliberately emits NO ATTENDEE and NO ORGANIZER property, ever. Those two
 * turn a personal calendar download into a real invitation: Apple Calendar and
 * Outlook will both offer to email whoever appears there, which for a diary
 * entry means mailing a friend an invite they never asked for. Companions ride
 * in the DESCRIPTION as plain names instead. `ics.test.ts` asserts their
 * absence; do not "improve" this by adding them.
 */
export function buildIcs(ev: PerformanceEvent, opts: BuildIcsOptions): string {
  const { generatedAt } = opts;
  const uidDomain = opts.uidDomain ?? DEFAULT_UID_DOMAIN;
  const sequence = opts.sequence ?? sequenceFromTimestamp(generatedAt);

  // Only claim a TZID we actually ship a VTIMEZONE for. Naming a zone we have
  // not defined makes strict parsers (Google) drop the event outright.
  const tz = hasVTimezone(ev.tz) ? ev.tz : null;

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Broadway Scorecard//Diary//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...vtimezoneLines(tz),
    'BEGIN:VEVENT',
    // Date excluded from the UID on purpose: re-exporting after a reschedule
    // must UPDATE the existing event, not create a second one.
    `UID:bsc-${sanitizeUidPart(ev.showId)}@${uidDomain}`,
    `DTSTAMP:${icsUtc(generatedAt)}`,
    `SEQUENCE:${sequence}`,
  ];

  if (ev.time) {
    const startUtc = wallTimeToUtc(ev.date, ev.time, tz);
    const endUtc = startUtc + ev.durationMin * 60_000;
    // Convert the end back to wall time in the same zone so an 11:00 PM curtain
    // with a 2h30 runtime lands at 1:30 AM the NEXT day, and so a performance
    // straddling a DST change ends at the correct local clock time.
    const end = utcToWallTime(endUtc, tz);
    if (tz) {
      lines.push(`DTSTART;TZID=${tz}:${icsLocal(ev.date, ev.time)}`);
      lines.push(`DTEND;TZID=${tz}:${icsLocal(end.date, end.time)}`);
    } else {
      // Floating: no TZID, no Z. Reads as local time wherever it is opened.
      lines.push(`DTSTART:${icsLocal(ev.date, ev.time)}`);
      lines.push(`DTEND:${icsLocal(end.date, end.time)}`);
    }
  } else {
    // No curtain time set → all-day. DTEND is exclusive per RFC 5545.
    const next = utcToWallTime(wallTimeToUtc(ev.date, '00:00', null) + 86_400_000, null);
    lines.push(`DTSTART;VALUE=DATE:${icsDate(ev.date)}`);
    lines.push(`DTEND;VALUE=DATE:${icsDate(next.date)}`);
  }

  lines.push(`SUMMARY:${escapeText(`🎭 ${ev.title}`)}`);
  if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);

  const description: string[] = [];
  if (ev.companions?.length) description.push(`With ${ev.companions.join(', ')}`);
  description.push(ev.showUrl);
  if (ev.joinUrl) description.push(ev.joinUrl);
  lines.push(`DESCRIPTION:${escapeText(description.join('\n'))}`);

  lines.push('END:VEVENT', 'END:VCALENDAR');

  // CRLF throughout, and a trailing CRLF: Outlook rejects LF-only calendars.
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
