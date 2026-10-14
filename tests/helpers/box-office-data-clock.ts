/**
 * BRO-5202: pin the box-office v2 stale-input guard's "today" to the data's own
 * newest grosses week, so real-data tests check status SHAPE, not wall-clock
 * freshness.
 *
 * getBoxOfficeV2StaleReasons() defaults to new Date() and is memoized; once the
 * real clock is > MAX_GROSSES_AGE_DAYS past the checked-in grosses week, every
 * v2 getter returns nothing and real-data tests fail (or pass vacuously on an
 * empty list) with no code change. Freshness itself is covered by the
 * fixed-date staleInputReasons tests; the mismatch and commercial-lag checks
 * still run here because they compare the data files with each other.
 *
 * Call once at module load, before any v2 getter runs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getBoxOfficeV2StaleReasons } from '../../src/lib/data-commercial';

export function pinBoxOfficeClockToData(): string {
  const file = path.join(__dirname, '..', '..', 'data', 'grosses-history.json');
  const weeks = Object.keys(JSON.parse(readFileSync(file, 'utf8')).weeks ?? {}).sort();
  const asOf = weeks.at(-1) ?? new Date().toISOString().slice(0, 10);
  getBoxOfficeV2StaleReasons(asOf);
  return asOf;
}
