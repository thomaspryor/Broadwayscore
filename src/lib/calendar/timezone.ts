/**
 * Timezone resolution and wall-clock math for calendar export.
 *
 * This is the SINGLE source for market → IANA zone in the calendar path.
 * `src/lib/date-utils.ts` has its own broadway/west-end split for "what day is
 * it in the market" — that one answers a different question (a calendar date
 * for data freshness) and is not vendored to iOS, so the two stay separate on
 * purpose. If you add a market here, add it there too.
 */

/** Market/category slug → IANA zone. Unknown markets get floating local time. */
const MARKET_TZ: Record<string, string> = {
  broadway: 'America/New_York',
  'off-broadway': 'America/New_York',
  'west-end': 'Europe/London',
  'off-west-end': 'Europe/London',
};

/**
 * Resolve a show category to an IANA zone, or null for "floating" — a time with
 * no zone, which every calendar client interprets in the viewer's own zone.
 * That is the correct degradation for a show whose market we do not know: a
 * WRONG zone silently shifts the event, whereas floating is at least right for
 * the common case of someone attending a show in their own city.
 */
export function resolveTimeZone(category?: string | null): string | null {
  if (!category) return null;
  return MARKET_TZ[category] ?? null;
}

/** Zones we ship VTIMEZONE definitions for. Anything else must go floating. */
export function hasVTimezone(tz: string | null): boolean {
  return tz === 'America/New_York' || tz === 'Europe/London';
}

/**
 * VTIMEZONE blocks matching the tzdata reference definitions, i.e. the exact
 * blocks Google Calendar and Apple both emit for these zones.
 *
 * Do NOT hand-edit the RRULEs. Google parses VTIMEZONE strictly and honours
 * what it is given; Apple silently substitutes its own tz database, which means
 * an Apple-only test will happily mask a broken rule here. The unit tests pin
 * these strings, and Phase 0's exit criteria include a real Google Calendar
 * import across a DST boundary.
 */
const VTIMEZONE_BLOCKS: Record<string, string[]> = {
  'America/New_York': [
    'BEGIN:VTIMEZONE',
    'TZID:America/New_York',
    'X-LIC-LOCATION:America/New_York',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0400',
    'TZNAME:EDT',
    'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0500',
    'TZNAME:EST',
    'DTSTART:19701101T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ],
  'Europe/London': [
    'BEGIN:VTIMEZONE',
    'TZID:Europe/London',
    'X-LIC-LOCATION:Europe/London',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0000',
    'TZOFFSETTO:+0100',
    'TZNAME:BST',
    'DTSTART:19700329T010000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0000',
    'TZNAME:GMT',
    'DTSTART:19701025T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ],
};

export function vtimezoneLines(tz: string | null): string[] {
  if (!tz) return [];
  return VTIMEZONE_BLOCKS[tz] ?? [];
}

/** Offset (ms) of `instant` in `tz`, i.e. localWallTime - UTC. */
function zoneOffsetMs(instant: number, tz: string): number {
  // hourCycle h23 rather than hour12:false — the latter yields hour "24" for
  // midnight in some ICU builds, which parses to a day-off-by-one.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));

  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? '0');
  const asIfUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour'), get('minute'), get('second'),
  );
  return asIfUtc - instant;
}

/**
 * Convert a local wall-clock time in `tz` to a UTC instant.
 *
 * Two passes, because the offset depends on the instant we are solving for.
 * The first guess uses the offset at the naive-UTC reading; the second uses the
 * offset at that corrected instant, which is what makes DST-boundary dates come
 * out right. Times inside a spring-forward gap (2:30 AM on the second Sunday in
 * March in New York) do not exist; this resolves them forward, matching what
 * Apple and Google both do.
 */
export function wallTimeToUtc(
  date: string,
  time: string,
  tz: string | null,
): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  if (!tz) return naive; // floating: caller must not treat this as a real instant
  let ts = naive - zoneOffsetMs(naive, tz);
  ts = naive - zoneOffsetMs(ts, tz);
  return ts;
}

/** Inverse of wallTimeToUtc: a UTC instant → {date, time} as read in `tz`. */
export function utcToWallTime(
  instant: number,
  tz: string | null,
): { date: string; time: string } {
  const shifted = tz ? instant + zoneOffsetMs(instant, tz) : instant;
  const d = new Date(shifted);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}
