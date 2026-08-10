/**
 * Calendar export — pure, dependency-free, vendorable.
 *
 * Nothing in this directory may import from outside it (no `@/lib/engine`, no
 * `@/lib/stats`, no React, no fs, no clock). The iOS app vendors the whole
 * directory, and every impurity becomes a drift-detection failure over there.
 * Callers pre-resolve show data into a PerformanceEvent and pass their own
 * timestamp in.
 */
export type { PerformanceEvent, TimeSlot, BuildIcsOptions } from './types';
export { buildIcs, escapeText, foldLine, sequenceFromTimestamp } from './ics';
export { buildGoogleCalendarUrl } from './google';
export { encodeEventParams, decodeEventParams } from './params';
export {
  resolveTimeZone,
  hasVTimezone,
  wallTimeToUtc,
  utcToWallTime,
  vtimezoneLines,
} from './timezone';
export {
  parseRuntimeMinutes,
  resolveDurationMin,
  DEFAULT_RUNTIME_MIN,
  CURTAIN_BUFFER_MIN,
} from './duration';
export { formatTime, parseYyyymmdd, addDaysToYyyymmdd } from './format';
