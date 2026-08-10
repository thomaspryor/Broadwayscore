import type { PerformanceEvent } from './types';

/**
 * The shared codec. `/api/calendar.ics`, the Add-to-Calendar buttons, and
 * (Phase 1) `/join` all encode and decode through these two functions, so when
 * Phase 2 swaps params for an outing token only this file changes.
 *
 * Short keys because these end up in URLs people paste into iMessage.
 */

const MAX_TITLE = 200;
const MAX_LOCATION = 200;
const MAX_COMPANIONS = 10;

export function encodeEventParams(ev: PerformanceEvent): URLSearchParams {
  const p = new URLSearchParams();
  p.set('s', ev.showId);
  p.set('n', ev.title);
  p.set('d', ev.date);
  if (ev.time) p.set('t', ev.time);
  if (ev.tz) p.set('z', ev.tz);
  p.set('m', String(ev.durationMin));
  if (ev.location) p.set('l', ev.location);
  p.set('u', ev.showUrl);
  if (ev.joinUrl) p.set('j', ev.joinUrl);
  if (ev.companions?.length) p.set('c', ev.companions.join('|'));
  return p;
}

/**
 * Decode and VALIDATE. Returns null on anything malformed rather than coercing,
 * because the caller is an HTTP route that must fail closed: serving a .ics
 * built from a half-parsed date writes a wrong-day event straight into somebody's
 * real calendar, which is far worse than a 400.
 */
export function decodeEventParams(qs: URLSearchParams): PerformanceEvent | null {
  const showId = qs.get('s')?.trim();
  const title = qs.get('n')?.trim();
  const date = qs.get('d')?.trim();
  const showUrl = qs.get('u')?.trim();

  if (!showId || !title || !date || !showUrl) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealDate(date)) return null;
  if (title.length > MAX_TITLE) return null;
  if (!isHttpUrl(showUrl)) return null;

  // showId is interpolated RAW into `UID:bsc-<id>@domain` — UID is not a TEXT
  // property, so it is not escaped like SUMMARY/LOCATION are. A CRLF in it
  // therefore terminates the UID line and everything after becomes new
  // calendar properties: `s=x%0D%0ASUMMARY:INJECTED` really did emit an
  // attacker-controlled SUMMARY. Restrict to the shape real show ids actually
  // have (slug-with-year, e.g. wicked-2003) rather than merely stripping CRLF,
  // so any other control character is refused too.
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(showId)) return null;

  const time = qs.get('t')?.trim() || null;
  if (time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;

  const tz = qs.get('z')?.trim() || null;
  if (tz !== null && !/^[A-Za-z]+\/[A-Za-z_+-]+$/.test(tz)) return null;

  const durationRaw = qs.get('m');
  const durationMin = durationRaw === null ? 165 : Number(durationRaw);
  if (!Number.isInteger(durationMin) || durationMin <= 0 || durationMin > 12 * 60) return null;

  const location = qs.get('l')?.trim() ?? '';
  if (location.length > MAX_LOCATION) return null;

  const joinUrl = qs.get('j')?.trim() || undefined;
  if (joinUrl !== undefined && !isHttpUrl(joinUrl)) return null;

  const companionsRaw = qs.get('c')?.trim();
  const companions = companionsRaw
    ? companionsRaw.split('|').map(c => c.trim()).filter(Boolean).slice(0, MAX_COMPANIONS)
    : undefined;

  // Optional keys are omitted rather than set to undefined, so a decoded event
  // deep-equals the one that produced it and callers can spread it safely.
  const ev: PerformanceEvent = { showId, title, date, time, tz, durationMin, location, showUrl };
  if (joinUrl) ev.joinUrl = joinUrl;
  if (companions?.length) ev.companions = companions;
  return ev;
}

/** Rejects 2026-02-31 and friends, which the regex alone happily accepts. */
function isRealDate(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** http/https only — a javascript: or data: URL here would land in a calendar event. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
