// BRO-4623 item 5: the Friday SERP scan and the hourly RSS poller both kept
// only shows 28-365 days past opening, so Purpose's post-closing tax-credit
// recoupment (announced 2026-06-04) and every long-running unrecouped show
// were invisible. Fixtures copy the real shows.json / commercial.json fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  recoupmentScanDecision,
  pickRecoupmentCandidates,
  rotateScanOrder,
  RSS_SCOPE,
  SERP_SCOPE,
} = require('./recoupment-scan-scope.js');

const NOW = Date.parse('2026-10-04T12:00:00Z');

const PURPOSE = { id: 'purpose-2025', slug: 'purpose-2025', status: 'closed', category: 'broadway', previewsStartDate: '2025-02-25', openingDate: '2025-03-17', closingDate: '2025-08-31' };
const PURPOSE_COMM = { designation: 'Fizzle', recouped: false, classifiedBy: 'classify-stale-closures' };
const MAYBE_HAPPY_ENDING = { id: 'maybe-happy-ending-2024', slug: 'maybe-happy-ending', status: 'open', category: 'broadway', previewsStartDate: '2024-10-16', openingDate: '2024-11-12', closingDate: null };
const THE_GREAT_GATSBY = { id: 'the-great-gatsby-2024', slug: 'the-great-gatsby', status: 'open', category: 'broadway', previewsStartDate: '2024-03-29', openingDate: '2024-04-25', closingDate: '2027-01-03' };
const DEATH_OF_A_SALESMAN = { id: 'death-of-a-salesman-2026', slug: 'death-of-a-salesman', status: 'closed', category: 'broadway', previewsStartDate: '2026-03-06', openingDate: '2026-04-09', closingDate: '2026-08-09' };
const THE_OUTSIDERS = { id: 'the-outsiders-2024', slug: 'the-outsiders', status: 'open', category: 'broadway', previewsStartDate: '2024-03-16', openingDate: '2024-04-11', closingDate: '2027-03-11' };
const THE_BALUSTERS = { id: 'the-balusters-2026', slug: 'the-balusters', status: 'closed', category: 'broadway', previewsStartDate: '2026-03-31', openingDate: '2026-04-21', closingDate: '2026-06-21' };
const BUENA_VISTA_OFF_BROADWAY = { id: 'buena-vista-social-club-off-broadway', slug: 'buena-vista-social-club-off-broadway', status: 'closed', category: 'off-broadway', openingDate: '2023-12-07', closingDate: '2024-01-28' };
const OTHER_DESERT_CITIES = { id: 'other-desert-cities', slug: 'other-desert-cities', status: 'previews', category: 'broadway', previewsStartDate: '2026-09-23', openingDate: '2026-10-15' };

// The filter both scripts carried before this change, verbatim in logic.
function oldFilter(s, c, nowMs) {
  if (c?.recouped === true) return false;
  const opened = s.openingDate || s.previewsStartDate;
  if (!opened) return false;
  const age = Math.floor((nowMs - new Date(opened).getTime()) / 86_400_000);
  if (age < 28 || age > 365) return false;
  return ['open', 'closed', 'closing'].includes(s.status);
}

test('purpose-2025 (closed 2025-08-31, recouped 2026-06 via tax credit): old filter missed it, RSS scope catches it', () => {
  assert.equal(oldFilter(PURPOSE, PURPOSE_COMM, NOW), false);
  assert.equal(oldFilter(PURPOSE, PURPOSE_COMM, Date.parse('2026-06-04T12:00:00Z')), false, 'missed on the very day of the announcement');
  assert.equal(recoupmentScanDecision(PURPOSE, PURPOSE_COMM, RSS_SCOPE, NOW).include, true);
  assert.equal(recoupmentScanDecision(PURPOSE, PURPOSE_COMM, RSS_SCOPE, Date.parse('2026-06-04T12:00:00Z')).include, true);
  assert.equal(recoupmentScanDecision(PURPOSE, PURPOSE_COMM, SERP_SCOPE, Date.parse('2026-06-04T12:00:00Z')).include, true, 'within a year of closing, the SERP scan watches it too');
  // 399 days after closing: past the SERP scan's one-year window by design (cost), RSS still watching.
  assert.equal(recoupmentScanDecision(PURPOSE, PURPOSE_COMM, SERP_SCOPE, NOW).include, false);
});

test('maybe-happy-ending (open since 2024-11, unrecouped): old filter missed it, both scopes include it', () => {
  assert.equal(oldFilter(MAYBE_HAPPY_ENDING, { designation: 'TBD' }, NOW), false);
  assert.equal(recoupmentScanDecision(MAYBE_HAPPY_ENDING, { designation: 'TBD' }, SERP_SCOPE, NOW).include, true);
  assert.equal(recoupmentScanDecision(MAYBE_HAPPY_ENDING, { designation: 'TBD' }, RSS_SCOPE, NOW).include, true);
  assert.equal(recoupmentScanDecision(THE_GREAT_GATSBY, { designation: 'TBD', recouped: false }, SERP_SCOPE, NOW).include, true);
});

test('shows the old filter already covered stay covered', () => {
  assert.equal(oldFilter(DEATH_OF_A_SALESMAN, { designation: 'TBD', recouped: false }, NOW), true);
  assert.equal(recoupmentScanDecision(DEATH_OF_A_SALESMAN, { designation: 'TBD', recouped: false }, SERP_SCOPE, NOW).include, true);
});

test('exclusions: already recouped, pure nonprofit, Off-Broadway, closed too long ago', () => {
  assert.equal(recoupmentScanDecision(THE_OUTSIDERS, { recouped: true }, RSS_SCOPE, NOW).include, false);
  // Nonprofit with no enhancement-friendly org named: skipped.
  assert.equal(recoupmentScanDecision(THE_BALUSTERS, { designation: 'Nonprofit' }, RSS_SCOPE, NOW).include, false);
  // Its real org, MTC, is enhancement-friendly: still scanned.
  assert.equal(recoupmentScanDecision(THE_BALUSTERS, { designation: 'Nonprofit', nonprofitOrg: 'Manhattan Theatre Club' }, RSS_SCOPE, NOW).include, true);
  assert.equal(recoupmentScanDecision(BUENA_VISTA_OFF_BROADWAY, undefined, RSS_SCOPE, NOW).include, false);
  assert.equal(recoupmentScanDecision(PURPOSE, PURPOSE_COMM, RSS_SCOPE, Date.parse('2027-09-01T00:00:00Z')).include, false, 'more than two years after closing');
});

test('previews: the free RSS scope watches a show in previews, the paid SERP scope waits 28 days past opening', () => {
  assert.equal(recoupmentScanDecision(OTHER_DESERT_CITIES, undefined, RSS_SCOPE, NOW).include, true);
  assert.equal(recoupmentScanDecision(OTHER_DESERT_CITIES, undefined, SERP_SCOPE, NOW).include, false);
});

test('pickRecoupmentCandidates reads commercial.json by slug', () => {
  const picked = pickRecoupmentCandidates(
    [PURPOSE, MAYBE_HAPPY_ENDING, THE_OUTSIDERS],
    { 'purpose-2025': PURPOSE_COMM, 'maybe-happy-ending': { designation: 'TBD' }, 'the-outsiders': { recouped: true } },
    RSS_SCOPE,
    NOW
  );
  assert.deepEqual(picked.map((s) => s.slug), ['purpose-2025', 'maybe-happy-ending']);
});

test('closed with no closingDate: kept while it opened inside the window (a closure that recent closed inside it too)', () => {
  const recent = { ...DEATH_OF_A_SALESMAN, closingDate: null };
  assert.equal(oldFilter(recent, undefined, NOW), true, 'the old filter kept it');
  assert.equal(recoupmentScanDecision(recent, undefined, SERP_SCOPE, NOW).include, true);
  assert.equal(recoupmentScanDecision(recent, undefined, RSS_SCOPE, NOW).include, true);
  const old = { ...PURPOSE, closingDate: undefined };
  assert.equal(recoupmentScanDecision(old, PURPOSE_COMM, SERP_SCOPE, NOW).include, false, 'opened 566d ago: cannot tell it closed within a year');
  assert.equal(recoupmentScanDecision(old, PURPOSE_COMM, RSS_SCOPE, NOW).include, true, 'opened within two years: closed within two years');
  const undated = { ...PURPOSE, closingDate: null, openingDate: null, previewsStartDate: null };
  assert.equal(recoupmentScanDecision(undated, PURPOSE_COMM, RSS_SCOPE, NOW).include, false);
});

// rotateScanOrder: the Friday scan stops at --time-budget-min, so a fixed
// order deferred the same tail shows every week.
const mkShows = (n) => Array.from({ length: n }, (_, i) => ({ slug: `show-${String(i).padStart(3, '0')}` }));

test('rotateScanOrder returns the same members, deterministic within a week', () => {
  const shows = mkShows(35).reverse();
  for (const week of [0, 1, 2913, 2914]) {
    const a = rotateScanOrder(shows, week);
    assert.deepEqual(a.map((s) => s.slug).sort(), shows.map((s) => s.slug).sort());
    assert.deepEqual(rotateScanOrder([...shows].reverse(), week), a, 'input order does not matter');
  }
  assert.deepEqual(rotateScanOrder([], 5), []);
  assert.deepEqual(rotateScanOrder([{ slug: 'only' }], 5), [{ slug: 'only' }]);
  assert.equal(shows[0].slug, 'show-034', 'input array not mutated');
});

test('rotateScanOrder: every start position comes round, and no show is deferred two weeks running', () => {
  for (let n = 2; n <= 300; n++) {
    const shows = mkShows(n);
    const starts = new Set();
    // A run that gets through half the list plus two (the scan's budget
    // covers about 30 of today's 35 shows).
    const k = Math.min(n, Math.ceil(n / 2) + 2);
    let prevDeferred = null;
    for (let week = 1000; week < 1000 + n; week++) {
      const order = rotateScanOrder(shows, week);
      starts.add(order[0].slug);
      const deferred = new Set(order.slice(k).map((s) => s.slug));
      if (prevDeferred) {
        for (const slug of deferred) assert.ok(!prevDeferred.has(slug), `n=${n} week=${week}: ${slug} deferred twice in a row`);
      }
      prevDeferred = deferred;
    }
    assert.equal(starts.size, n, `n=${n}: every show leads the scan once per ${n} weeks`);
  }
});
