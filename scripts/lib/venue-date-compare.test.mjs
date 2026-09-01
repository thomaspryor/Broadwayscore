// Regression test for compareShow()'s priorRuns corroboration (BRO-2544):
// test.yml's "Validate provisional show venue+dates against Playbill" step
// went red on two genuine recurring/remounted Off-Broadway shows whose
// current shows.json dates were verified correct (BroadwayWorld/TheaterMania
// season announcements) but whose only indexed Playbill production page
// described an EARLIER run at the same venue — the-dead-1904-off-broadway-2026
// (2026 remount vs Playbill's still-indexed 2024 page) and
// othello-bedlam-off-broadway-2026 (Nov 2026 encore vs Playbill's page for the
// May 2026 original run). Uses the real compareShow()/findCorroboratingPriorRun()
// functions (CLAUDE.md §15) — never re-implement the corroboration logic here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  compareShow, findCorroboratingPriorRun, daysBetween, urlYear,
  orderProvisionalTargets, deferredHighPriorityShows, mergeCarriedForwardResults,
  buildAuditResults, showFingerprint,
} = require('./venue-date-compare.js');

const DEAD_1904_SHOW = {
  id: 'the-dead-1904-off-broadway-2026',
  title: 'The Dead, 1904',
  venue: 'American Irish Historical Society',
  openingDate: '2026-11-24',
  closingDate: '2027-01-03',
  category: 'off-broadway',
  isRevival: true,
  priorRuns: [
    { openingDate: '2024-11-26', closingDate: '2025-01-05', venue: 'American Irish Historical Society' },
  ],
};
const DEAD_1904_PARSED = {
  titleParse: { rawTitle: 'The Dead, 1904', market: 'Off-Broadway', venue: 'The American Irish Historical Society', year: 2024 },
  dates: { firstPreview: null, openingDate: '2024-11-26', closingDate: '2025-01-05' },
  tagLine: { revivalStatus: 'unknown' },
};
const DEAD_1904_URL = 'https://playbill.com/production/the-dead-1904-off-broadway-the-american-irish-historical-society-2024';

const OTHELLO_SHOW = {
  id: 'othello-bedlam-off-broadway-2026',
  title: 'Othello (Bedlam)',
  venue: 'West End Theatre',
  openingDate: null,
  closingDate: '2026-11-29',
  category: 'off-broadway',
  isRevival: true,
  priorRuns: [
    { openingDate: '2026-05-10', closingDate: '2026-05-31', venue: 'West End Theatre' },
  ],
};
const OTHELLO_PARSED = {
  titleParse: { rawTitle: 'Othello', market: 'Off-Broadway', venue: 'The West End Theatre', year: 2026 },
  dates: { firstPreview: null, openingDate: '2026-05-10', closingDate: '2026-05-31' },
  tagLine: { revivalStatus: 'unknown' },
};
const OTHELLO_URL = 'https://playbill.com/production/othello-off-broadway-the-west-end-theatre-2026';

test('compareShow: The Dead, 1904 2026 remount is fully explained by its 2024 priorRun (no unexplained mismatches)', () => {
  const { mismatches, explainedByPriorRun } = compareShow(DEAD_1904_SHOW, DEAD_1904_PARSED, DEAD_1904_URL);
  assert.deepEqual(mismatches, []);
  const fields = explainedByPriorRun.map(m => m.field).sort();
  assert.deepEqual(fields, ['closingDate', 'opening-year', 'openingDate']);
  // venue never enters either bucket — normalizeVenueName's leading-"The" strip
  // (venue-classification.js) already makes "American Irish Historical Society"
  // ≡ "The American Irish Historical Society" via venuesMatch(), so there's no
  // venue mismatch to explain in the first place.
  assert.ok(!mismatches.some(m => m.field === 'venue'));
  assert.ok(!explainedByPriorRun.some(m => m.field === 'venue'));
});

test('compareShow: Bedlam Othello Nov 2026 encore is explained by its May 2026 priorRun', () => {
  const { mismatches, explainedByPriorRun } = compareShow(OTHELLO_SHOW, OTHELLO_PARSED, OTHELLO_URL);
  assert.deepEqual(mismatches, []);
  assert.deepEqual(explainedByPriorRun.map(m => m.field), ['closingDate']);
});

test('compareShow: an unrelated priorRuns entry does NOT suppress a genuine mismatch', () => {
  const show = {
    id: 'fake-show-off-broadway-2026',
    title: 'Fake Show',
    venue: 'Real Venue',
    openingDate: '2026-11-24',
    closingDate: '2027-01-03',
    category: 'off-broadway',
    priorRuns: [
      { openingDate: '2024-11-26', closingDate: '2025-01-05', venue: 'Real Venue' },
    ],
  };
  const parsed = {
    titleParse: { rawTitle: 'Fake Show', market: 'Off-Broadway', venue: 'Totally Different Venue', year: 2023 },
    dates: { firstPreview: null, openingDate: '2023-03-01', closingDate: '2023-04-01' },
    tagLine: { revivalStatus: 'unknown' },
  };
  const url = 'https://playbill.com/production/fake-show-off-broadway-totally-different-venue-2023';
  const { mismatches, explainedByPriorRun } = compareShow(show, parsed, url);
  assert.deepEqual(mismatches.map(m => m.field).sort(), ['closingDate', 'opening-year', 'openingDate', 'venue']);
  assert.deepEqual(explainedByPriorRun, []);
});

test('compareShow: a show with no priorRuns behaves exactly as before (real mismatch surfaces)', () => {
  const show = {
    id: 'no-prior-runs-off-broadway-2026',
    title: 'No Prior Runs',
    venue: 'Some Venue',
    openingDate: '2026-11-24',
    closingDate: '2027-01-03',
    category: 'off-broadway',
  };
  const parsed = {
    titleParse: { rawTitle: 'No Prior Runs', market: 'Off-Broadway', venue: 'Some Venue', year: 2024 },
    dates: { firstPreview: null, openingDate: '2024-11-26', closingDate: '2025-01-05' },
    tagLine: { revivalStatus: 'unknown' },
  };
  const url = 'https://playbill.com/production/no-prior-runs-off-broadway-some-venue-2024';
  const { mismatches, explainedByPriorRun } = compareShow(show, parsed, url);
  assert.deepEqual(explainedByPriorRun, []);
  assert.deepEqual(mismatches.map(m => m.field).sort(), ['closingDate', 'opening-year', 'openingDate']);
});

test('findCorroboratingPriorRun: requires BOTH venue match and a date within 30 days — venue-only match is not enough', () => {
  const show = {
    priorRuns: [{ openingDate: '2020-01-01', closingDate: '2020-02-01', venue: 'Some Venue' }],
  };
  const parsed = {
    titleParse: { venue: 'Some Venue' },
    dates: { openingDate: '2024-11-26', closingDate: '2025-01-05' },
  };
  assert.equal(findCorroboratingPriorRun(show, parsed), null);
});

test('findCorroboratingPriorRun: returns null when show has no priorRuns', () => {
  assert.equal(findCorroboratingPriorRun({ priorRuns: [] }, DEAD_1904_PARSED), null);
  assert.equal(findCorroboratingPriorRun({}, DEAD_1904_PARSED), null);
});

test('daysBetween / urlYear still work as re-exported (parity with the pre-extraction inline versions)', () => {
  assert.equal(daysBetween('2024-11-26', '2025-01-05'), 40);
  assert.equal(daysBetween(null, '2025-01-05'), null);
  assert.equal(urlYear('https://playbill.com/production/foo-off-broadway-bar-2026'), 2026);
  assert.equal(urlYear('https://playbill.com/production/foo-off-broadway-bar'), null);
});

// BRO-2627: --time-budget-min caps how many provisional shows a CI run can
// afford to check, so ordering determines which shows are actually covered.
test('orderProvisionalTargets: new (absent from prior report) shows sort before previously-broken, before previously-clean', () => {
  const shows = [
    { id: 'clean-old' },
    { id: 'new-stub' },
    { id: 'still-broken' },
    { id: 'another-new-stub' },
  ];
  const prev = { 'clean-old': 'match', 'still-broken': 'mismatch' };
  const ordered = orderProvisionalTargets(shows, prev).map((s) => s.id);
  assert.deepEqual(ordered, ['new-stub', 'another-new-stub', 'still-broken', 'clean-old']);
});

test('orderProvisionalTargets: a TRANSIENT prior error outranks previously-clean (a retry may yet yield evidence)', () => {
  const shows = [{ id: 'was-clean' }, { id: 'was-fetch-error' }];
  const prev = { 'was-clean': 'match', 'was-fetch-error': 'fetch-error' };
  const ordered = orderProvisionalTargets(shows, prev).map((s) => s.id);
  assert.deepEqual(ordered, ['was-fetch-error', 'was-clean']);
});

// BRO-2701 — 'no-playbill-url' means the show has no Playbill production page
// at all, so a recheck can never produce evidence in either direction, and it
// is the MOST expensive target in the set (~24s burning the full SERP fallback
// chain looking for a page that is not there, vs ~11s for a findable one).
// It must therefore sort behind previously-clean, not ahead of it.
test('orderProvisionalTargets: previously no-playbill-url sorts LAST, behind previously-clean (BRO-2701)', () => {
  const shows = [{ id: 'no-page' }, { id: 'was-clean' }, { id: 'was-mismatch' }, { id: 'brand-new' }];
  const prev = { 'no-page': 'no-playbill-url', 'was-clean': 'match', 'was-mismatch': 'mismatch' };
  const ordered = orderProvisionalTargets(shows, prev).map((s) => s.id);
  assert.deepEqual(ordered, ['brand-new', 'was-mismatch', 'was-clean', 'no-page']);
});

test('deferredHighPriorityShows: a deferred no-playbill-url show does NOT block certification (BRO-2701)', () => {
  // validate-show-venue.js --fail-on-mismatch gates on `mismatches` only and
  // explicitly excludes no-playbill-url when the show IS checked (BRO-2560).
  // An outcome that cannot fail the build when seen must not fail it when unseen.
  const prev = { 'no-page': 'no-playbill-url', 'was-transient': 'fetch-error' };
  const deferred = [{ id: 'no-page' }, { id: 'was-transient' }];
  assert.deepEqual(deferredHighPriorityShows(deferred, prev), []);
});

test('deferredHighPriorityShows: an unrecognised prior result still blocks (fail safe, BRO-2701)', () => {
  const prev = { weird: 'some-future-result-value' };
  assert.deepEqual(
    deferredHighPriorityShows([{ id: 'weird' }], prev).map((s) => s.id),
    ['weird'],
  );
});

// The exact production shape that made main permanently red: the tracked
// ledger held 32 'match' + 33 'no-playbill-url' (run 33458412904). Under the
// old `!== 2` rule all 33 no-playbill-url shows tiered as "still broken", sorted
// ahead of the 32 clean ones, and at ~24s each could not fit a 9-minute budget
// (~13.2 min) — so the deferred tail ALWAYS held a blocking show and the step
// ALWAYS exited 1, with zero mismatches in the data, on every push forever.
test('the 32-match/33-no-playbill ledger can certify a clean pass under a partial budget (BRO-2701)', () => {
  const shows = [];
  const prev = {};
  for (let i = 0; i < 32; i += 1) { shows.push({ id: `clean-${i}` }); prev[`clean-${i}`] = 'match'; }
  for (let i = 0; i < 33; i += 1) { shows.push({ id: `nopage-${i}` }); prev[`nopage-${i}`] = 'no-playbill-url'; }

  const ordered = orderProvisionalTargets(shows, prev);
  // Evidence-bearing targets run first, so a budget cut costs only no-evidence ones.
  assert.deepEqual(ordered.slice(0, 32).map((s) => s.id), shows.slice(0, 32).map((s) => s.id));

  // Budget reaches 40 of 65; the 25 deferred are all no-playbill-url.
  const deferred = ordered.slice(40);
  assert.equal(deferred.length, 25);
  assert.deepEqual(deferredHighPriorityShows(deferred, prev), [], 'must not block a clean pass');

  // And the guarantee BRO-2627 added is intact: add one genuinely new stub and
  // deferring it still fails closed.
  const withStub = orderProvisionalTargets([...shows, { id: 'bad-new-stub' }], prev);
  assert.equal(withStub[0].id, 'bad-new-stub', 'a new stub is always checked first');
  assert.deepEqual(
    deferredHighPriorityShows([{ id: 'bad-new-stub' }], prev).map((s) => s.id),
    ['bad-new-stub'],
  );
});

test('orderProvisionalTargets: no prior report (undefined map) treats every show as new — stable, original order preserved', () => {
  const shows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(orderProvisionalTargets(shows, undefined).map((s) => s.id), ['a', 'b', 'c']);
});

test('orderProvisionalTargets: stable within a tier (does not reorder same-priority shows)', () => {
  const shows = [{ id: 'z' }, { id: 'a' }, { id: 'm' }];
  assert.deepEqual(orderProvisionalTargets(shows, {}).map((s) => s.id), ['z', 'a', 'm']);
});

test('deferredHighPriorityShows: previously-clean deferrals are fine; new/broken deferrals are flagged', () => {
  const prev = { clean: 'match', broken: 'mismatch' };
  const deferred = [{ id: 'clean' }, { id: 'broken' }, { id: 'never-seen' }];
  const flagged = deferredHighPriorityShows(deferred, prev).map((s) => s.id);
  assert.deepEqual(flagged, ['broken', 'never-seen']);
});

test('deferredHighPriorityShows: empty deferred tail flags nothing', () => {
  assert.deepEqual(deferredHighPriorityShows([], { anything: 'match' }), []);
});

test('mergeCarriedForwardResults: fresh results win; untouched-but-still-provisional rows carry forward; retired rows drop', () => {
  const fresh = [{ id: 'checked-this-run', result: 'match' }];
  const previous = {
    'checked-this-run': { id: 'checked-this-run', result: 'mismatch' }, // stale — fresh wins
    'deferred-still-provisional': { id: 'deferred-still-provisional', result: 'match' },
    'no-longer-provisional': { id: 'no-longer-provisional', result: 'match' },
  };
  const currentProvisionalIds = new Set(['checked-this-run', 'deferred-still-provisional']);
  const merged = mergeCarriedForwardResults(fresh, previous, currentProvisionalIds);
  assert.deepEqual(
    merged.map((r) => [r.id, r.result]).sort(),
    [['checked-this-run', 'match'], ['deferred-still-provisional', 'match']],
  );
});

test('mergeCarriedForwardResults: no prior report is a no-op (returns fresh results unchanged)', () => {
  const fresh = [{ id: 'a', result: 'match' }];
  assert.deepEqual(mergeCarriedForwardResults(fresh, {}, new Set(['a'])), fresh);
});

// BRO-2696 — a `--show=<id>` run used to write ONLY the row it checked over the
// shared, tracked data/audit/venue-date-mismatches.json. CI loads that file as
// its `previousResultById`, so a one-row report made 64 of 65 provisional shows
// tier as "new"; the budget-deferred tail was then also "new" and
// deferredHighPriorityShows() correctly refused to certify — main red on
// run 33454567745 with `0 mismatch` in the data. Observed twice in one day,
// both times from the per-show command CLAUDE.md rule 3 tells operators to run.
//
// These exercise the REAL buildAuditResults() that validate-show-venue.js calls
// on every write path (CLAUDE.md §15) — the point is that no mode can write a
// truncated report, so a single-show run's output must still contain the other
// still-provisional shows' last-known rows.

test('buildAuditResults: a single-show run does NOT truncate the shared report (BRO-2696)', () => {
  // Shape of the real incident: 3 provisional shows, an operator checks one.
  const previousResultsById = {
    'show-a': { id: 'show-a', result: 'match' },
    'show-b': { id: 'show-b', result: 'match' },
    'show-c': { id: 'show-c', result: 'mismatch' },
  };
  const currentProvisionalIds = new Set(['show-a', 'show-b', 'show-c']);
  const out = buildAuditResults({
    freshResults: [{ id: 'show-c', result: 'match' }], // the one show re-checked
    previousResultsById,
    currentProvisionalIds,
  });
  assert.equal(out.length, 3, 'filtered run must not shrink the report to its own row');
  const byId = Object.fromEntries(out.map((r) => [r.id, r.result]));
  assert.equal(byId['show-c'], 'match', "this run's fresh result must win");
  assert.equal(byId['show-a'], 'match', 'untouched show keeps its last-known tier');
  assert.equal(byId['show-b'], 'match', 'untouched show keeps its last-known tier');
});

test('buildAuditResults: the carried-forward rows keep every show OUT of tier 0 next run (BRO-2696)', () => {
  // The consequence the gate actually cares about: after a single-show run, a
  // deferred show must still tier as previously-clean (2), not new (0) — tier 0
  // in a budget-deferred tail is what makes deferredHighPriorityShows() fail CI.
  const previousResultsById = {
    'deferred-clean': { id: 'deferred-clean', result: 'match' },
  };
  const out = buildAuditResults({
    freshResults: [{ id: 'checked', result: 'match' }],
    previousResultsById,
    currentProvisionalIds: new Set(['deferred-clean', 'checked']),
  });
  const nextRunResultById = Object.fromEntries(out.map((r) => [r.id, r.result]));
  const deferred = [{ id: 'deferred-clean' }];
  assert.deepEqual(
    deferredHighPriorityShows(deferred, nextRunResultById),
    [],
    'a previously-clean deferred show must not escalate after a filtered run',
  );
});

test('buildAuditResults: a missing currentProvisionalIds THROWS rather than silently truncating (BRO-2696)', () => {
  // The pre-fix caller passed null here and fell through to "write exactly what
  // this run checked". Writing fewer rows looks like a successful write, so the
  // regression has to be loud.
  for (const bad of [null, undefined, ['show-a']]) {
    assert.throws(
      () => buildAuditResults({
        freshResults: [{ id: 'checked', result: 'match' }],
        previousResultsById: { 'show-a': { id: 'show-a', result: 'match' } },
        currentProvisionalIds: bad,
      }),
      /currentProvisionalIds/,
      `expected a throw for ${JSON.stringify(bad)}`,
    );
  }
});

// Hardening from the BRO-2696 pre-ship review (adversarial pass): carry-forward
// makes the ledger long-lived, so it also has to be honest about WHAT it holds
// and about how old its evidence is.

test('buildAuditResults: rows for ids that are not currently provisional never enter the ledger (BRO-2696)', () => {
  // --candidates-file synthesises ids ("<slug>-off-broadway-pending") for shows
  // with no shows.json entry at all. The ledger is what CI reads as its
  // provisional coverage state, so a discovery-only id in it is a lie.
  const out = buildAuditResults({
    freshResults: [
      { id: 'real-provisional', result: 'match' },
      { id: 'made-up-off-broadway-pending', result: 'match' },
    ],
    previousResultsById: {},
    currentProvisionalIds: new Set(['real-provisional']),
  });
  assert.deepEqual(out.map((r) => r.id), ['real-provisional']);
});

test('buildAuditResults: a carried row is DROPPED once its show has been edited (BRO-2696 review)', () => {
  // The row asserts "clean when we last looked". After a venue/date edit that
  // assertion is about values that no longer exist — keeping it tier-2 would
  // let a budget-deferred CI run certify a venue nobody ever checked.
  const show = { id: 'edited', venue: 'Old Venue', openingDate: '2026-01-01', closingDate: null };
  const priorRow = { id: 'edited', result: 'match', fingerprint: showFingerprint(show) };
  const edited = { ...show, venue: 'New Venue' };
  const out = buildAuditResults({
    freshResults: [],
    previousResultsById: { edited: priorRow },
    currentProvisionalIds: new Set(['edited']),
    showsById: { edited },
  });
  assert.deepEqual(out, [], 'an edited show must go back to needing a check');

  const untouched = buildAuditResults({
    freshResults: [],
    previousResultsById: { edited: priorRow },
    currentProvisionalIds: new Set(['edited']),
    showsById: { edited: show },
  });
  assert.equal(untouched.length, 1, 'an unedited show keeps its evidence');
});

test('buildAuditResults: rows written before fingerprints existed are still carried (BRO-2696 review)', () => {
  // Dropping them would re-create the original red on the first run after this
  // ships, since no committed row has a fingerprint yet.
  const out = buildAuditResults({
    freshResults: [],
    previousResultsById: { legacy: { id: 'legacy', result: 'match' } }, // no fingerprint
    currentProvisionalIds: new Set(['legacy']),
    showsById: { legacy: { id: 'legacy', venue: 'V', openingDate: '2026-01-01' } },
  });
  assert.deepEqual(out.map((r) => r.id), ['legacy']);
});

test('buildAuditResults: fresh rows are stamped with a fingerprint so the NEXT run can tell (BRO-2696 review)', () => {
  const show = { id: 'a', venue: 'V', openingDate: '2026-01-01', closingDate: '2026-03-01' };
  const [row] = buildAuditResults({
    freshResults: [{ id: 'a', result: 'match' }],
    previousResultsById: {},
    currentProvisionalIds: new Set(['a']),
    showsById: { a: show },
  });
  assert.equal(row.fingerprint, showFingerprint(show));
});
