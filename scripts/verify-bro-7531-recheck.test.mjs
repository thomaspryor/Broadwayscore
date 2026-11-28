/**
 * verify-bro-7531-recheck.test.mjs: the RECHECK-AFTER acceptance probe for
 * BRO-7531 (scraping cost savings in the search chain).
 *
 * BRO-7531 stopped asking the paid backup search vendors after a clean
 * Scrapingdog empty on off-Broadway / off-West-End press nights, and added one
 * same-vendor Scrapingdog re-ask instead. The unit tests prove the code path;
 * only the vendors' own billing proves the money moved. This probe reads the
 * daily billing record (data/audit/provider-spend-daily.jsonl, written by
 * scripts/check-provider-spend.js from the vendors' usage APIs) and checks two
 * things over the first full week after the change:
 *
 *   1. ScrapingBee daily credits fell. Baseline 2026-11-12..14 was 15,573 /
 *      15,560 / 15,759 a day, and the spend ledger put more than half of that
 *      on the dropped path (search after a Scrapingdog empty on off-Broadway /
 *      off-West-End shows). The claim: the median day is at or under 10,000.
 *   2. Scrapingdog stayed inside its plan. The re-ask adds Scrapingdog calls;
 *      the plan allows about 100,000 credits a day (baseline 63,097..77,043).
 *      The claim: the median day is at or under 100,000.
 *
 * Like scripts/verify-provider-spend-streak.test.mjs this asserts against LIVE
 * repo data on purpose. A red run is the claim being disproven, not a code
 * regression. It is skipped until the week has been recorded, and it is listed
 * in EXEMPT_NEVER_CI (scripts/audit-orphan-tests.js) so it never gates CI.
 *
 * BRO-7532 (free fetch routes for Deadline / THR / DTLI / theatre.reviews)
 * lands in the same week and pushes ScrapingBee down further. That only makes
 * check 1 easier to pass; it cannot hide a failure of check 2.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(HERE, '..', 'data', 'audit', 'provider-spend-daily.jsonl');

// First full UTC day with the change on main, and the last day of the window.
const FIRST_DAY = '2026-11-16';
const LAST_DAY = '2026-11-22';
// Day D is recorded on D+1 at about 09:30 UTC, so 11-22 exists by noon 11-23.
const CHECKABLE_FROM = Date.parse('2026-11-23T12:00:00Z');
const MIN_DAYS = 5;
const SCRAPINGBEE_MEDIAN_MAX = 10000;
const SCRAPINGDOG_MEDIAN_MAX = 100000;

/** Pure: the measured day-credit figures for one provider inside the window. */
export function dayCreditsInWindow(records, provider, firstDay = FIRST_DAY, lastDay = LAST_DAY) {
  const out = [];
  for (const r of records) {
    if (!r || typeof r.day !== 'string' || r.day < firstDay || r.day > lastDay) continue;
    const p = r.providers && r.providers[provider];
    if (!p || p.status !== 'ok' || typeof p.dayCredits !== 'number') continue;
    out.push(p.dayCredits);
  }
  return out;
}

export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function readRecords() {
  let lines;
  try {
    lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
  } catch {
    assert.fail(`no provider-spend ledger at ${LEDGER}`);
  }
  return lines.map((l) => JSON.parse(l));
}

const NOT_YET = 'not checkable before 2026-11-23 (the week after BRO-7531 landed is still being recorded)';

test('helpers: window filter ignores unmeasured days and other providers', () => {
  const recs = [
    { day: '2026-11-15', providers: { scrapingbee: { status: 'ok', dayCredits: 15000 } } },
    { day: '2026-11-16', providers: { scrapingbee: { status: 'ok', dayCredits: 7000 }, scrapingdog: { status: 'ok', dayCredits: 80000 } } },
    { day: '2026-11-17', providers: { scrapingbee: { status: 'error' } } },
    { day: '2026-11-18', providers: { scrapingbee: { status: 'ok', dayCredits: 9000 } } },
    { day: '2026-11-23', providers: { scrapingbee: { status: 'ok', dayCredits: 1 } } },
  ];
  assert.deepEqual(dayCreditsInWindow(recs, 'scrapingbee', '2026-11-16', '2026-11-22'), [7000, 9000]);
  assert.deepEqual(dayCreditsInWindow(recs, 'scrapingdog', '2026-11-16', '2026-11-22'), [80000]);
  assert.equal(median([9000, 7000]), 8000);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
});

test('BRO-7531: ScrapingBee daily credits fell to a median of 10,000 or less in the week after landing', {
  skip: Date.now() < CHECKABLE_FROM && NOT_YET,
}, () => {
  const days = dayCreditsInWindow(readRecords(), 'scrapingbee');
  assert.ok(days.length >= MIN_DAYS, `only ${days.length} measured ScrapingBee day(s) in ${FIRST_DAY}..${LAST_DAY}, need ${MIN_DAYS}`);
  const m = median(days);
  assert.ok(m <= SCRAPINGBEE_MEDIAN_MAX, `ScrapingBee median day is ${m} credits (days: ${days.join(', ')}); baseline was about 15,600 and the claim is <= ${SCRAPINGBEE_MEDIAN_MAX}`);
});

test('BRO-7531: Scrapingdog stayed inside its plan (median day 100,000 credits or less) with the re-ask on', {
  skip: Date.now() < CHECKABLE_FROM && NOT_YET,
}, () => {
  const days = dayCreditsInWindow(readRecords(), 'scrapingdog');
  assert.ok(days.length >= MIN_DAYS, `only ${days.length} measured Scrapingdog day(s) in ${FIRST_DAY}..${LAST_DAY}, need ${MIN_DAYS}`);
  const m = median(days);
  assert.ok(m <= SCRAPINGDOG_MEDIAN_MAX, `Scrapingdog median day is ${m} credits (days: ${days.join(', ')}); the plan allows about 100,000 a day`);
});
