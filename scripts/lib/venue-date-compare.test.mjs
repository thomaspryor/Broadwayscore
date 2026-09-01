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
  orderProvisionalTargets, deferredHighPriorityShows, mergeCarriedForwardResults, buildPriorTierMap,
  missingUrlOutcome, serpQueryCompleted, TRANSIENT_PRIOR_RESULTS, provisionalPriorityTier,
  resolveLastDefinitive, blocksOnDeferral,
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
  // 'no-playbill-url' is a DEFINITIVE answer (we reached the providers; the show
  // has no Playbill page), so nothing about it is left open.
  assert.deepEqual(deferredHighPriorityShows([{ id: 'no-page' }], { 'no-page': 'no-playbill-url' }), []);
});

test('deferredHighPriorityShows: a show known ONLY through a transient failure DOES block (BRO-2701 review 4)', () => {
  // It has never once been definitively looked at, so deferring it leaves the
  // question wide open — this is the brand-new-stub-during-an-outage case.
  assert.deepEqual(
    deferredHighPriorityShows([{ id: 'was-transient' }], { 'was-transient': 'fetch-error' }).map((x) => x.id),
    ['was-transient'],
  );
  // But a show we HAVE looked at before does not block on a later transient
  // failure: we still know what we knew, so an outage cannot redden the corpus.
  assert.deepEqual(
    deferredHighPriorityShows([{ id: 'known' }], { known: { result: 'fetch-error', lastDefinitiveResult: 'match' } }),
    [],
  );
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

// ---------------------------------------------------------------------------
// BRO-2701 adversarial review — three regressions the first cut introduced.
// ---------------------------------------------------------------------------

// FINDING 1. findPlaybillUrl() returns the same "no url" shape whether we
// looked and found no Playbill page, or every SERP query threw and we never
// looked at all. Collapsing both into 'no-playbill-url' would put a brand-new
// stub that happened to be checked during a provider outage into the
// permanently-deferred, never-blocking tier. 'serp-error' keeps it retry-worthy.
test("a SERP outage ('serp-error') is a transient tier, NOT the no-Playbill-page tier (BRO-2701 review)", () => {
  const shows = [{ id: 'no-page' }, { id: 'outage' }, { id: 'was-clean' }];
  const prev = { 'no-page': 'no-playbill-url', outage: 'serp-error', 'was-clean': 'match' };
  assert.deepEqual(
    orderProvisionalTargets(shows, prev).map((s) => s.id),
    ['outage', 'was-clean', 'no-page'],
    'a failed lookup must be rechecked before a clean show, and long before a genuine no-page show',
  );
});

// FINDING 2. Tier alone is not enough: a checked no-playbill-url show is
// re-stamped with the same result, so its tier never changes. With a stable
// index tiebreak the budget reached the same head every run and the rest of the
// tail — the shows never once validated — were deferred forever, which also
// left the "Persist rotation state" CI step with no rotation to persist.
test('within a tier, the least-recently-checked show goes first (BRO-2701 review)', () => {
  const shows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const prev = {
    a: { result: 'no-playbill-url', checkedAt: '2026-09-01T00:00:00.000Z' },
    b: { result: 'no-playbill-url', checkedAt: '2026-08-01T00:00:00.000Z' },
    c: { result: 'no-playbill-url' }, // never checked since checkedAt existed
  };
  assert.deepEqual(orderProvisionalTargets(shows, prev).map((s) => s.id), ['c', 'b', 'a']);
});

test('rotation actually drains a starved tail instead of re-checking the same head (BRO-2701 review)', () => {
  // 6 no-playbill shows, a budget that reaches 2 per run. Every show must be
  // covered within 3 runs; the pre-fix stable-index order covered the same 2
  // on all three.
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const shows = ids.map((id) => ({ id }));
  const prev = Object.fromEntries(ids.map((id) => [id, { result: 'no-playbill-url' }]));
  const seen = new Set();
  for (let run = 0; run < 3; run += 1) {
    const checked = orderProvisionalTargets(shows, prev).slice(0, 2);
    for (const s of checked) {
      seen.add(s.id);
      // A run re-stamps what it checked, exactly as buildAuditResults does.
      prev[s.id] = { result: 'no-playbill-url', checkedAt: new Date(Date.UTC(2026, 8, 1 + run)).toISOString() };
    }
  }
  assert.deepEqual([...seen].sort(), ids, 'every show must be reached within 3 runs');
});

// FINDING 3. The tiering map must apply the same fingerprint-staleness rule
// buildAuditResults applies at write time. Otherwise a show whose venue was
// just rewritten keeps its old non-blocking tier, is deferred, does not block
// the gate, and is caught only on the NEXT run.
test('buildPriorTierMap drops a fingerprint-stale row so an edited show tiers as new (BRO-2701 review)', () => {
  const showsById = {
    edited: { id: 'edited', venue: 'New Venue', openingDate: '2026-03-01', closingDate: null },
    untouched: { id: 'untouched', venue: 'Old Venue', openingDate: '2026-03-01', closingDate: null },
  };
  const previousResultsById = {
    // Compute the "unchanged" fingerprint from the real helper so this test
    // tracks the fingerprint FORMAT rather than hard-coding one (the format
    // gained isRevival in BRO-2701 review 3, finding 4).
    edited: { id: 'edited', result: 'no-playbill-url', fingerprint: 'Old Venue|2026-03-01||false' },
    untouched: { id: 'untouched', result: 'no-playbill-url', fingerprint: showFingerprint(showsById.untouched) },
  };
  const tierMap = buildPriorTierMap({ previousResultsById, showsById });
  assert.equal(tierMap.edited, undefined, 'the edited show has no valid prior evidence');
  assert.equal(tierMap.untouched.result, 'no-playbill-url');

  // The consequence the gate cares about: deferring the edited show now blocks.
  assert.deepEqual(
    deferredHighPriorityShows([{ id: 'edited' }, { id: 'untouched' }], tierMap).map((s) => s.id),
    ['edited'],
  );
  // ...and it sorts first, so a budget-capped run checks it rather than deferring it.
  assert.equal(
    orderProvisionalTargets([{ id: 'untouched' }, { id: 'edited' }], tierMap)[0].id,
    'edited',
  );
});

test('buildPriorTierMap carries rows that predate fingerprints (BRO-2701 review)', () => {
  const showsById = { legacy: { id: 'legacy', venue: 'V', openingDate: '2026-01-01', closingDate: null } };
  const previousResultsById = { legacy: { id: 'legacy', result: 'match' } };
  assert.equal(buildPriorTierMap({ previousResultsById, showsById }).legacy.result, 'match');
});

test('buildAuditResults stamps checkedAt on fresh rows so the NEXT run can rotate (BRO-2701 review)', () => {
  const out = buildAuditResults({
    freshResults: [{ id: 'a', result: 'no-playbill-url' }],
    previousResultsById: {},
    currentProvisionalIds: new Set(['a']),
    showsById: { a: { id: 'a', venue: 'V', openingDate: '2026-01-01', closingDate: null } },
  });
  assert.ok(out[0].checkedAt, 'fresh row must carry a checkedAt timestamp');
  assert.ok(!Number.isNaN(Date.parse(out[0].checkedAt)));
});

test('missingUrlOutcome: an unreached lookup is serp-error, a completed one is no-playbill-url (BRO-2701 review)', () => {
  assert.deepEqual(missingUrlOutcome({ anyQueryCompleted: false }), { source: 'serp-error', result: 'serp-error' });
  assert.deepEqual(missingUrlOutcome({ anyQueryCompleted: true }), { source: 'none', result: 'no-playbill-url' });
});

test("missingUrlOutcome's failure result is in the transient set, so it never lands in the starved tail (BRO-2701 review)", () => {
  const failed = missingUrlOutcome({ anyQueryCompleted: false }).result;
  assert.ok(TRANSIENT_PRIOR_RESULTS.has(failed), 'a failed lookup must be retry-worthy');
  const looked = missingUrlOutcome({ anyQueryCompleted: true }).result;
  assert.ok(!TRANSIENT_PRIOR_RESULTS.has(looked));
  // And the tiers that follow from that: retry-worthy outranks previously-clean.
  assert.deepEqual(
    orderProvisionalTargets([{ id: 'clean' }, { id: 'failed' }], { clean: 'match', failed }).map((x) => x.id),
    ['failed', 'clean'],
  );
});

// ---------------------------------------------------------------------------
// BRO-2701 second adversarial review.
// ---------------------------------------------------------------------------

// FINDING 1 — the one that mattered. The first cut of the serp-error fix set
// anyQueryCompleted on any iteration that did not THROW, but serpQuery() does
// not throw on an outage: it returns null when there are no SERP keys, and
// _serpWithChain returns {results: null} when every provider fails (each
// provider helper catches its own error and returns null). null vs [] is a
// deliberate distinction in that chain. Guarding only against throws made the
// entire serp-error path unreachable.
test('serpQueryCompleted: null is a provider outage, [] is a real empty answer (BRO-2701 review 2)', () => {
  assert.equal(serpQueryCompleted(null), false, 'null = no provider answered');
  assert.equal(serpQueryCompleted(undefined), false);
  assert.equal(serpQueryCompleted([]), true, 'an empty array IS an answer: we looked, there was nothing');
  assert.equal(serpQueryCompleted([{ url: 'https://playbill.com/production/x' }]), true);
});

test('a SERP outage cannot demote a show into the never-blocking tail (BRO-2701 review 2)', () => {
  // The full chain the bug ran through: every query returns null (not throws),
  // so the show must end up transient/tier-2, never 'no-playbill-url'/tier-4.
  const anyQueryCompleted = [null, null, null].some(serpQueryCompleted);
  assert.equal(anyQueryCompleted, false);
  const outcome = missingUrlOutcome({ anyQueryCompleted });
  assert.equal(outcome.result, 'serp-error');
  assert.ok(TRANSIENT_PRIOR_RESULTS.has(outcome.result));
  assert.equal(provisionalPriorityTier('s', { s: outcome.result }), 2, 'rechecked early, not parked');
  assert.deepEqual(
    deferredHighPriorityShows([{ id: 's' }], { s: outcome.result }).map((x) => x.id), ['s'],
    'and with no definitive verdict on record, deferring it still fails closed',
  );

  // And the contrast: a provider that answered with nothing is a real no-page.
  const looked = missingUrlOutcome({ anyQueryCompleted: [null, [], null].some(serpQueryCompleted) });
  assert.equal(looked.result, 'no-playbill-url');
  assert.equal(provisionalPriorityTier('s', { s: looked.result }), 4);
});

// FINDING 3 — buildPriorTierMap iterates by MAP KEY, so a row body missing its
// own `id` must not silently bypass the staleness check via byId[undefined].
test('buildPriorTierMap uses the map key, not row.id, for the staleness check (BRO-2701 review 2)', () => {
  const showsById = { edited: { id: 'edited', venue: 'New Venue', openingDate: '2026-03-01', closingDate: null } };
  const previousResultsById = {
    edited: { result: 'no-playbill-url', fingerprint: 'Old Venue|2026-03-01|' }, // NOTE: no `id` field
  };
  assert.equal(
    buildPriorTierMap({ previousResultsById, showsById }).edited, undefined,
    'a fingerprint-stale row must be dropped even when the row body has no id',
  );
});

// ---------------------------------------------------------------------------
// BRO-2701 third adversarial review.
// ---------------------------------------------------------------------------

// FINDING 1 — the serious one. Transient outcomes tier as 2, which the deferral
// gate does not block on, and a fresh row overwrites the prior one. So a run
// that merely FAILED TO REACH a show could erase a known mismatch's blocking
// status and let main go green over an unfixed venue error.
test('a transient outcome cannot erase a known mismatch (BRO-2701 review 3)', () => {
  const showsById = { x: { id: 'x', venue: 'V', openingDate: '2026-01-01', closingDate: null, isRevival: false } };
  const previousResultsById = {
    x: { id: 'x', result: 'mismatch', fingerprint: showFingerprint(showsById.x), mismatches: [{ field: 'venue' }] },
  };
  // Run 2: the fetch times out.
  const out = buildAuditResults({
    freshResults: [{ id: 'x', result: 'fetch-error', mismatches: [] }],
    previousResultsById,
    currentProvisionalIds: new Set(['x']),
    showsById,
  });
  const row = out.find((r) => r.id === 'x');
  assert.equal(row.result, 'fetch-error', 'the row honestly records what this run actually got');
  assert.equal(row.lastDefinitiveResult, 'mismatch', 'but the last thing we KNEW survives it');
  assert.ok(row.checkedAt, 'and checkedAt still advances, so rotation is unaffected');

  // Run 3: the budget defers x. It must STILL block.
  const tierMap = buildPriorTierMap({ previousResultsById: Object.fromEntries(out.map((r) => [r.id, r])), showsById });
  assert.deepEqual(deferredHighPriorityShows([{ id: 'x' }], tierMap).map((r) => r.id), ['x']);
});

test('a DEFINITIVE fresh verdict still wins, so a landed fix clears the gate (BRO-2701 review 3)', () => {
  const showsById = { x: { id: 'x', venue: 'V', openingDate: '2026-01-01', closingDate: null, isRevival: false } };
  const previousResultsById = { x: { id: 'x', result: 'mismatch', fingerprint: showFingerprint(showsById.x) } };
  const out = buildAuditResults({
    freshResults: [{ id: 'x', result: 'match', mismatches: [] }],
    previousResultsById,
    currentProvisionalIds: new Set(['x']),
    showsById,
  });
  assert.equal(out.find((r) => r.id === 'x').result, 'match', 'a fixed show must be able to go clean');
  assert.equal(out.find((r) => r.id === 'x').lastDefinitiveResult, 'match');
  assert.deepEqual(deferredHighPriorityShows([{ id: 'x' }], { x: { result: 'match', lastDefinitiveResult: 'match' } }), []);
});

test('resolveLastDefinitive: a transient outcome neither creates nor destroys certainty (BRO-2701 review 4)', () => {
  assert.equal(resolveLastDefinitive('fetch-error', undefined), undefined, 'cannot manufacture certainty');
  assert.equal(resolveLastDefinitive('serp-error', { lastDefinitiveResult: 'mismatch' }), 'mismatch', 'cannot destroy it');
  assert.equal(resolveLastDefinitive('serp-error', { lastDefinitiveResult: 'match' }), 'match');
});

test('resolveLastDefinitive: losing the Playbill page cannot clear a mismatch (BRO-2701 review 4)', () => {
  // Google's top-10 shifting, or a title slug drifting, must not be able to
  // retire a recorded venue/date defect into the never-blocking tier.
  assert.equal(resolveLastDefinitive('no-playbill-url', { lastDefinitiveResult: 'mismatch' }), 'mismatch');
  assert.deepEqual(
    deferredHighPriorityShows([{ id: 'x' }], { x: { result: 'no-playbill-url', lastDefinitiveResult: 'mismatch' } }).map((r) => r.id),
    ['x'],
  );
  // Only an actual look at an actual page may supersede it.
  assert.equal(resolveLastDefinitive('match', { lastDefinitiveResult: 'mismatch' }), 'match');
  assert.equal(resolveLastDefinitive('mismatch', { lastDefinitiveResult: 'match' }), 'mismatch');
  // And with no prior mismatch, no-playbill-url is simply the answer.
  assert.equal(resolveLastDefinitive('no-playbill-url', { lastDefinitiveResult: 'match' }), 'no-playbill-url');
});

test('blocksOnDeferral: a legacy row with no lastDefinitiveResult derives one from result (BRO-2701 review 4)', () => {
  // The committed ledger has 65 rows and none of them carry the new field, so
  // the migration has to work with no backfill step.
  assert.equal(blocksOnDeferral('a', { a: { result: 'match' } }), false);
  assert.equal(blocksOnDeferral('a', { a: { result: 'no-playbill-url' } }), false);
  assert.equal(blocksOnDeferral('a', { a: { result: 'mismatch' } }), true);
  assert.equal(blocksOnDeferral('a', { a: { result: 'fetch-error' } }), true);
  assert.equal(blocksOnDeferral('a', {}), true, 'never seen at all');
});

test('a stale mismatch is NOT resurrected onto a corrected show (BRO-2701 review 4, finding 3)', () => {
  const showsById = { x: { id: 'x', venue: 'New Venue', openingDate: '2026-01-01', closingDate: null, isRevival: false } };
  const previousResultsById = {
    x: {
      id: 'x', result: 'mismatch', lastDefinitiveResult: 'mismatch',
      fingerprint: 'Wrong Venue|2026-01-01||false',
      mismatches: [{ field: 'venue', shows: 'Wrong Venue' }],
    },
  };
  const out = buildAuditResults({
    freshResults: [{ id: 'x', result: 'fetch-error', mismatches: [] }],
    previousResultsById, currentProvisionalIds: new Set(['x']), showsById,
  });
  const row = out.find((r) => r.id === 'x');
  assert.equal(row.lastDefinitiveResult, undefined,
    'evidence about a venue the owner has since corrected must not carry forward');
  assert.equal(blocksOnDeferral('x', { x: row }), true,
    'and the show is treated as never-validated, so it still fails closed');
});

// FINDING 4 — isRevival is validated by compareShow, so it must be part of the
// evidence fingerprint, or flipping it leaves a stale 'match' looking valid.
test('showFingerprint covers isRevival, which compareShow validates (BRO-2701 review 3)', () => {
  const base = { venue: 'V', openingDate: '2026-01-01', closingDate: null };
  assert.notEqual(
    showFingerprint({ ...base, isRevival: false }),
    showFingerprint({ ...base, isRevival: true }),
    'flipping isRevival must invalidate prior evidence',
  );
});
