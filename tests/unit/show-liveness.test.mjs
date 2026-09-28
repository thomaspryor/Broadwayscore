// scripts/lib/show-liveness.js — the one "is this show live / recently
// closed?" predicate (2026 data audit, S7-T7).
//
// Three things are pinned here:
//   1. the predicate itself over the status × closingDate matrix;
//   2. that each of the four adopting callers' frozen option objects
//      reproduces that caller's OLD inline filter exactly (CLAUDE.md §15 —
//      the real exported constants are required, nothing is restated);
//   3. a source assertion that each caller actually imports the module and
//      calls isRecentlyLive(), so a refactor back to an ad-hoc status check
//      fails here rather than silently re-stranding closed shows.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  LIVE_STATUSES,
  isRecentlyLive,
  daysSinceClosing,
  toUtcDayNumber,
} = require('../../scripts/lib/show-liveness.js');
const { CATCHUP_LIVENESS, selectCatchupCandidates } = require('../../scripts/lib/zero-review-catchup.js');
const { STALE_UPCOMING_LIVENESS, hasStaleUpcomingTag } = require('../../scripts/lib/opening-night-completeness.js');
const {
  ELIGIBLE_STATUSES,
  OB_DATE_FIX_LIVENESS,
  isStatusEligibleForDateFix,
  isEligibleForDateFix,
} = require('../../scripts/lib/ob-date-fix-eligibility.js');
const {
  PENDING_DRAIN_LIVE_STATUSES,
  pendingDrainLivenessOptions,
  isPendingDrainEligible,
  parseClosedWithinDays,
} = require('../../scripts/replay-pending-bylines.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

const TODAY = '2026-09-28';
const daysAgo = (n) => {
  const d = new Date(Date.UTC(2026, 8, 28) - n * 86_400_000);
  return d.toISOString().slice(0, 10);
};

const ALL_STATUSES = ['open', 'previews', 'upcoming', 'announced', 'closed', 'cancelled', 'postponed', 'transferred', undefined];
const CLOSING_VARIANTS = [undefined, null, daysAgo(0), daysAgo(10), daysAgo(90), daysAgo(91), daysAgo(400), daysAgo(-5), 'garbage'];

// Every (status, closingDate) combination — the matrix each per-caller
// equivalence test walks so no shape is left unexercised.
function matrix() {
  const rows = [];
  for (const status of ALL_STATUSES) {
    for (const closingDate of CLOSING_VARIANTS) {
      rows.push({ id: `${status}-${closingDate}`, status, closingDate });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

test('default: open / previews / upcoming are live, nothing else is', () => {
  assert.deepEqual([...LIVE_STATUSES], ['open', 'previews', 'upcoming']);
  for (const status of ['open', 'previews', 'upcoming']) {
    assert.equal(isRecentlyLive({ status }, { today: TODAY }), true, status);
  }
  for (const status of ['announced', 'cancelled', 'postponed', 'transferred', undefined, 'closed']) {
    assert.equal(isRecentlyLive({ status, closingDate: daysAgo(1) }, { today: TODAY }), false, String(status));
  }
});

test('closed rows never count without allowClosed, whatever the closingDate', () => {
  for (const closingDate of CLOSING_VARIANTS) {
    assert.equal(isRecentlyLive({ status: 'closed', closingDate }, { today: TODAY, withinDays: 10_000 }), false, String(closingDate));
  }
});

test('closed rows count with allowClosed only when closingDate is within withinDays of today', () => {
  const opts = { today: TODAY, allowClosed: true, withinDays: 90 };
  assert.equal(isRecentlyLive({ status: 'closed', closingDate: daysAgo(10) }, opts), true, '10d ago');
  assert.equal(isRecentlyLive({ status: 'closed', closingDate: daysAgo(90) }, opts), true, 'boundary: exactly withinDays');
  assert.equal(isRecentlyLive({ status: 'closed', closingDate: daysAgo(91) }, opts), false, '91d ago');
  assert.equal(isRecentlyLive({ status: 'closed', closingDate: daysAgo(400) }, opts), false, '400d ago');
  // Closed with a closingDate still ahead: inconsistent data, but at most
  // 0 days closed — recently live by any reading.
  assert.equal(isRecentlyLive({ status: 'closed', closingDate: daysAgo(-5) }, opts), true, 'future closingDate');
});

test('closed rows with no (or unparseable) closingDate are not recently live — recency cannot be established', () => {
  const opts = { today: TODAY, allowClosed: true, withinDays: 90 };
  assert.equal(isRecentlyLive({ status: 'closed' }, opts), false);
  assert.equal(isRecentlyLive({ status: 'closed', closingDate: null }, opts), false);
  assert.equal(isRecentlyLive({ status: 'closed', closingDate: 'garbage' }, opts), false);
});

test('withinDays: Infinity admits every closed row, closingDate or not', () => {
  const opts = { today: TODAY, allowClosed: true, withinDays: Infinity };
  assert.equal(isRecentlyLive({ status: 'closed' }, opts), true);
  assert.equal(isRecentlyLive({ status: 'closed', closingDate: daysAgo(4000) }, opts), true);
  assert.equal(isRecentlyLive({ status: 'cancelled' }, opts), false, 'still only closed rows');
});

test('withinDays defaults to 0: allowClosed alone admits only a row that closed today (or later)', () => {
  assert.equal(isRecentlyLive({ status: 'closed', closingDate: daysAgo(0) }, { today: TODAY, allowClosed: true }), true);
  assert.equal(isRecentlyLive({ status: 'closed', closingDate: daysAgo(1) }, { today: TODAY, allowClosed: true }), false);
});

test('a negative or non-numeric withinDays admits no closed row; null reads as 0', () => {
  for (const withinDays of [-1, NaN, 'soon']) {
    assert.equal(isRecentlyLive({ status: 'closed', closingDate: daysAgo(0) }, { today: TODAY, allowClosed: true, withinDays }), false, String(withinDays));
  }
  assert.equal(isRecentlyLive({ status: 'closed', closingDate: daysAgo(0) }, { today: TODAY, allowClosed: true, withinDays: null }), true);
  assert.equal(isRecentlyLive({ status: 'closed', closingDate: daysAgo(1) }, { today: TODAY, allowClosed: true, withinDays: null }), false);
});

test('liveStatuses overrides the default live set (array or Set)', () => {
  assert.equal(isRecentlyLive({ status: 'upcoming' }, { liveStatuses: ['open'] }), false);
  assert.equal(isRecentlyLive({ status: 'announced' }, { liveStatuses: new Set(['announced']) }), true);
  assert.equal(isRecentlyLive({ status: 'open' }, { liveStatuses: [] }), false);
});

test('today accepts a Date, an ISO day string, or epoch ms; ISO strings read as their written calendar day', () => {
  const show = { status: 'closed', closingDate: '2026-09-20T23:59:00+00:00' };
  for (const today of [TODAY, new Date(Date.UTC(2026, 8, 28, 12)), Date.UTC(2026, 8, 28, 1)]) {
    assert.equal(isRecentlyLive(show, { today, allowClosed: true, withinDays: 8 }), true);
    assert.equal(isRecentlyLive(show, { today, allowClosed: true, withinDays: 7 }), false);
  }
  const day = Math.floor(Date.UTC(2026, 8, 28) / 86_400_000);
  assert.equal(toUtcDayNumber('2026-09-28'), day, 'plain YYYY-MM-DD → that UTC day, no local-timezone drift');
  assert.equal(toUtcDayNumber('2026-09-28T23:00:00-05:00'), day, 'a datetime keeps its written date even when the UTC instant is the next day');
  assert.equal(toUtcDayNumber('Sep 28, 2026 UTC'), day, 'other parseable forms fall back to Date parsing');
  assert.equal(toUtcDayNumber(''), null);
  assert.equal(toUtcDayNumber({}), null);
  assert.equal(daysSinceClosing({ closingDate: '2026-09-18' }, TODAY), 10);
  assert.equal(daysSinceClosing({ closingDate: null }, TODAY), null);
  assert.equal(daysSinceClosing({ closingDate: '2026-09-18' }, 'not a date'), null);
});

test('non-object shows are never live', () => {
  for (const bad of [null, undefined, 'open', 42]) {
    assert.equal(isRecentlyLive(bad, { allowClosed: true, withinDays: Infinity }), false, String(bad));
  }
});

// ---------------------------------------------------------------------------
// Per-caller equivalence: the frozen option object each caller passes must
// reproduce that caller's OLD inline filter over the whole matrix.
// ---------------------------------------------------------------------------

test('zero-review-catchup: CATCHUP_LIVENESS ≡ old `s.status === \'open\'`', () => {
  assert.deepEqual(CATCHUP_LIVENESS, { liveStatuses: ['open'], allowClosed: false });
  for (const s of matrix()) {
    assert.equal(isRecentlyLive(s, { ...CATCHUP_LIVENESS, today: TODAY }), s.status === 'open', s.id);
  }
});

test('zero-review-catchup: selectCatchupCandidates still dispatches only status=open (a recently closed zero-review show is not a target)', () => {
  const now = Date.UTC(2026, 8, 28);
  const opened = new Date(now - 10 * 86_400_000).toISOString().slice(0, 10);
  const shows = [
    { id: 'open-show', status: 'open', openingDate: opened },
    { id: 'closed-yesterday', status: 'closed', openingDate: opened, closingDate: daysAgo(1) },
    { id: 'previews-show', status: 'previews', openingDate: opened },
  ];
  const { batch } = selectCatchupCandidates(shows, [], {}, { now });
  assert.deepEqual(batch, ['open-show']);
});

test('opening-night-completeness: STALE_UPCOMING_LIVENESS ≡ old STALE_UPCOMING_STATUSES = {open}', () => {
  assert.deepEqual(STALE_UPCOMING_LIVENESS, { liveStatuses: ['open'], allowClosed: false });
  for (const s of matrix()) {
    const show = { ...s, tags: ['upcoming'] };
    assert.equal(hasStaleUpcomingTag(show), s.status === 'open', s.id);
  }
  assert.equal(hasStaleUpcomingTag({ status: 'open', tags: ['lottery'] }), false);
  assert.equal(hasStaleUpcomingTag({ status: 'open' }), false, 'no tags array');
});

test('ob-date-fix-eligibility: OB_DATE_FIX_LIVENESS ≡ old ELIGIBLE_STATUSES.has(status); closed admission stays flag+year based', () => {
  assert.deepEqual(OB_DATE_FIX_LIVENESS, { liveStatuses: [...ELIGIBLE_STATUSES], allowClosed: false });
  assert.deepEqual([...ELIGIBLE_STATUSES], ['open', 'previews', 'upcoming', 'announced']);
  for (const s of matrix()) {
    assert.equal(isRecentlyLive(s, { ...OB_DATE_FIX_LIVENESS, today: TODAY }), ELIGIBLE_STATUSES.has(s.status), s.id);
    // The script's two entry points: unchanged truth table.
    const expectedStatus = ELIGIBLE_STATUSES.has(s.status);
    assert.equal(isStatusEligibleForDateFix(s), expectedStatus, `status/no-flag ${s.id}`);
    assert.equal(isStatusEligibleForDateFix(s, { includeClosedWhenYearMatches: true }), expectedStatus || s.status === 'closed', `status/flag ${s.id}`);
    assert.equal(isEligibleForDateFix(s, 2026), expectedStatus, `final/no-flag ${s.id}`);
  }
  // A recently closed row is NOT admitted by recency — only by the exact
  // Playbill-year match under the flag.
  const closedLastWeek = { id: 'x-off-broadway-2026', status: 'closed', closingDate: daysAgo(7), openingDate: '2026-06-01' };
  assert.equal(isEligibleForDateFix(closedLastWeek, 2025, { includeClosedWhenYearMatches: true }), false);
  assert.equal(isEligibleForDateFix(closedLastWeek, 2026, { includeClosedWhenYearMatches: true }), true);
});

test('replay-pending-bylines: --all-open (closedWithinDays=0) ≡ old [open, previews].includes(status)', () => {
  assert.deepEqual([...PENDING_DRAIN_LIVE_STATUSES], ['open', 'previews']);
  assert.deepEqual(pendingDrainLivenessOptions(0, TODAY), {
    liveStatuses: PENDING_DRAIN_LIVE_STATUSES, allowClosed: false, withinDays: 0, today: TODAY,
  });
  for (const s of matrix()) {
    assert.equal(isPendingDrainEligible(s, 0, TODAY), ['open', 'previews'].includes(s.status), s.id);
  }
  assert.equal(isPendingDrainEligible(undefined, 0, TODAY), false, 'a _pending dir with no shows.json row');
});

test('replay-pending-bylines: --closed-within-days=90 adds exactly the rows that closed ≤90 days ago', () => {
  assert.deepEqual(pendingDrainLivenessOptions(90, TODAY), {
    liveStatuses: PENDING_DRAIN_LIVE_STATUSES, allowClosed: true, withinDays: 90, today: TODAY,
  });
  for (const s of matrix()) {
    const since = daysSinceClosing(s, TODAY);
    const expected = ['open', 'previews'].includes(s.status)
      || (s.status === 'closed' && since !== null && since <= 90);
    assert.equal(isPendingDrainEligible(s, 90, TODAY), expected, s.id);
  }
  // Othello Off-Broadway-class row: closed, reviews stranded — now drains.
  assert.equal(isPendingDrainEligible({ status: 'closed', closingDate: daysAgo(30) }, 90, TODAY), true);
  // 'upcoming' stays out even with the widening — nothing to drain pre-previews.
  assert.equal(isPendingDrainEligible({ status: 'upcoming' }, 90, TODAY), false);
});

test('replay-pending-bylines: parseClosedWithinDays reads the flag and rejects junk', () => {
  assert.equal(parseClosedWithinDays(['--all-open', '--closed-within-days=90']), 90);
  assert.equal(parseClosedWithinDays(['--all-open']), 0);
  assert.equal(parseClosedWithinDays(['--closed-within-days=abc']), 0);
  assert.equal(parseClosedWithinDays(['--closed-within-days=-4']), 0);
  assert.equal(parseClosedWithinDays(['--closed-within-days=0']), 0);
  assert.equal(parseClosedWithinDays([]), 0);
  assert.equal(parseClosedWithinDays(undefined), 0);
});

// ---------------------------------------------------------------------------
// Source assertions: every caller imports the shared predicate and calls it.
// ---------------------------------------------------------------------------

const CALLERS = [
  { file: 'scripts/lib/zero-review-catchup.js', importRe: /require\(['"]\.\/show-liveness['"]\)/ },
  { file: 'scripts/lib/opening-night-completeness.js', importRe: /require\(['"]\.\/show-liveness['"]\)/ },
  { file: 'scripts/lib/ob-date-fix-eligibility.js', importRe: /require\(['"]\.\/show-liveness['"]\)/ },
  { file: 'scripts/replay-pending-bylines.js', importRe: /require\(['"]\.\/lib\/show-liveness['"]\)/ },
];

for (const { file, importRe } of CALLERS) {
  test(`${file} imports scripts/lib/show-liveness and calls isRecentlyLive()`, () => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(src, importRe, `${file} no longer requires show-liveness — the shared liveness predicate was dropped`);
    assert.match(src, /\bisRecentlyLive\(/, `${file} never calls isRecentlyLive()`);
  });
}

// Code only — the callers' comments legitimately quote the old filter they
// replaced, so line and block comments are stripped before matching.
function codeOnly(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

test('the old ad-hoc status filters are gone from the four callers (code, not comments)', () => {
  assert.doesNotMatch(codeOnly('scripts/lib/zero-review-catchup.js'), /s\.status !== 'open'/);
  assert.doesNotMatch(codeOnly('scripts/lib/opening-night-completeness.js'), /STALE_UPCOMING_STATUSES/);
  assert.doesNotMatch(codeOnly('scripts/lib/ob-date-fix-eligibility.js'), /ELIGIBLE_STATUSES\.has\(/);
  assert.doesNotMatch(codeOnly('scripts/replay-pending-bylines.js'), /\['open', 'previews'\]\.includes\(/);
});

test('enrich-off-broadway-dates.js still reaches the predicate through the eligibility module', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/enrich-off-broadway-dates.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/ob-date-fix-eligibility['"]\)/);
  assert.match(src, /isStatusEligibleForDateFix\(/);
});
