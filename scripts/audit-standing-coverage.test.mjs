import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  evaluateStandingCoverage,
  evaluateCoverageExpectationDrift,
  classifyCoverageExpectationDrift,
  MIN_PRESS_OUTLETS,
  MIN_SEASON_SHOWS,
  COVERAGE_EXPECTATION_DECAY_DAYS,
} = require('./audit-standing-coverage.js');

const NOW = Date.parse('2026-07-30T12:00:00Z');
const DAY = 86400000;
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10);

/** Build `count` broadway shows in the season `seasonIndex` seasons back. */
function makeShows(prefix, count, seasonIndex) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${seasonIndex}-${i}`,
    category: 'broadway',
    openingDate: iso(seasonIndex * 365 + 10 + i),
  }));
}

/** Reviews so every show has MIN_PRESS_OUTLETS filler outlets, plus `covered` shows from `outletId`. */
function makeReviews(shows, outletId, coveredCount) {
  const rows = [];
  for (const s of shows) {
    for (let i = 0; i < MIN_PRESS_OUTLETS; i++) rows.push({ showId: s.id, outletId: `filler-${i}` });
  }
  for (const s of shows.slice(0, coveredCount)) rows.push({ showId: s.id, outletId });
  return rows;
}

const REG = (extra) => ({ probe: { tier: 1, ...extra } });

/** Same coverage rate in all 3 seasons, N shows each. */
function scenario(rate, { flagged = false, n = 20, outletId = 'probe', registry } = {}) {
  const shows = [];
  const reviews = [];
  for (let s = 0; s < 3; s++) {
    const seasonShows = makeShows('bw', n, s);
    shows.push(...seasonShows);
    reviews.push(...makeReviews(seasonShows, outletId, Math.round(n * rate)));
  }
  return evaluateStandingCoverage(shows, reviews, registry || REG(flagged ? { standingCoverage: true } : {}), NOW);
}

test('promotes an outlet that covers virtually every Broadway opening', () => {
  const r = scenario(0.95);
  assert.deepEqual(r.promote, ['probe']);
  assert.deepEqual(r.demote, []);
});

test('does not promote a mid-coverage outlet (the false-GAP class)', () => {
  const r = scenario(0.8); // above the demote floor, below the promote bar
  assert.deepEqual(r.promote, []);
  assert.deepEqual(r.demote, []);
});

test('demotes a flagged outlet whose coverage collapsed', () => {
  const r = scenario(0.2, { flagged: true });
  assert.deepEqual(r.demote, ['probe']);
  assert.deepEqual(r.promote, []);
});

test('hysteresis: a flagged outlet between the two bars keeps its flag', () => {
  const r = scenario(0.8, { flagged: true });
  assert.deepEqual(r.demote, []);
  assert.deepEqual(r.promote, []);
});

test('one strong season cannot carry an outlet that faded in the latest one', () => {
  const shows = [];
  const reviews = [];
  const rates = [0.4, 1, 1]; // latest season first
  for (let s = 0; s < 3; s++) {
    const seasonShows = makeShows('bw', 20, s);
    shows.push(...seasonShows);
    reviews.push(...makeReviews(seasonShows, 'probe', Math.round(20 * rates[s])));
  }
  const r = evaluateStandingCoverage(shows, reviews, REG(), NOW);
  assert.deepEqual(r.promote, []); // overall 80% would tempt, min season 40% blocks
});

test('never promotes a CI-unfetchable outlet however complete its coverage', () => {
  const r = scenario(1, { outletId: 'wsj', registry: { wsj: { tier: 1 } } });
  assert.deepEqual(r.promote, []);
  assert.equal(r.rows.find((x) => x.outletId === 'wsj').unfetchable, true);
});

test('demotes a CI-unfetchable outlet that somehow carries the flag', () => {
  const r = scenario(1, { outletId: 'wsj', registry: { wsj: { tier: 1, standingCoverage: true } } });
  assert.deepEqual(r.demote, ['wsj']);
});

test('shows with no real press are excluded from the denominator', () => {
  // 20 shows/season: 10 fully-covered, 10 with a single review and no press.
  const shows = [];
  const reviews = [];
  for (let s = 0; s < 3; s++) {
    const seasonShows = makeShows('bw', 20, s);
    shows.push(...seasonShows);
    const press = seasonShows.slice(0, 10);
    reviews.push(...makeReviews(press, 'probe', 10));
    for (const q of seasonShows.slice(10)) reviews.push({ showId: q.id, outletId: 'filler-0' });
  }
  const r = evaluateStandingCoverage(shows, reviews, REG(), NOW);
  assert.deepEqual(r.promote, ['probe']); // 100% of the 10 real openings, not 50% of 20
  assert.deepEqual(r.seasons.map((x) => x.shows), [10, 10, 10]);
});

test('a season too thin to support a rate is dropped, not counted as zero', () => {
  const shows = [];
  const reviews = [];
  for (let s = 0; s < 3; s++) {
    const n = s === 0 ? MIN_SEASON_SHOWS - 1 : 20;
    const seasonShows = makeShows('bw', n, s);
    shows.push(...seasonShows);
    reviews.push(...makeReviews(seasonShows, 'probe', s === 0 ? 0 : n));
  }
  const r = evaluateStandingCoverage(shows, reviews, REG(), NOW);
  assert.deepEqual(r.seasons.length, 2);
  assert.deepEqual(r.promote, ['probe']);
});

test('an outlet with no in-window evidence is left alone in both directions', () => {
  const r = evaluateStandingCoverage([], [], REG({ standingCoverage: true }), NOW);
  assert.deepEqual(r.promote, []);
  assert.deepEqual(r.demote, []);
});

test('tier-3 outlets are out of scope entirely', () => {
  const r = scenario(1, { registry: { probe: { tier: 3 } } });
  assert.deepEqual(r.promote, []);
  assert.equal(r.rows.length, 0);
});

test('non-broadway openings never count toward the rate', () => {
  const shows = [];
  const reviews = [];
  for (let s = 0; s < 3; s++) {
    const seasonShows = makeShows('bw', 20, s);
    shows.push(...seasonShows);
    reviews.push(...makeReviews(seasonShows, 'probe', 20));
    const ob = makeShows('ob', 20, s).map((x) => ({ ...x, category: 'off-broadway' }));
    shows.push(...ob);
    reviews.push(...makeReviews(ob, 'probe', 0));
  }
  const r = evaluateStandingCoverage(shows, reviews, REG(), NOW);
  assert.deepEqual(r.promote, ['probe']);
  assert.deepEqual(r.seasons.map((x) => x.shows), [20, 20, 20]);
});

// --- no-press-night gate (lib/standing-outlets.js, card #627 smoke test) ---

const {
  isNoPressNightShow,
  NO_PRESS_NIGHT_GRACE_DAYS,
  NO_PRESS_NIGHT_MIN_OUTLETS,
} = require('./lib/standing-outlets.js');

const HOURS = (days) => days * 24;

test('no-press-night: a long-past engagement nobody reviewed is suppressed', () => {
  // Beetlejuice 2025 (limited return of the 2019 production): 0 scored outlets.
  assert.equal(isNoPressNightShow(HOURS(NO_PRESS_NIGHT_GRACE_DAYS + 60), 0), true);
});

test('no-press-night: one stray T2 outlet is still not a press night', () => {
  // All Out (2025-12-12): exactly one dispatch-tier review, 10 standing GAP cells.
  assert.equal(isNoPressNightShow(HOURS(200), 1), true);
});

test('no-press-night: a real press opening is never suppressed', () => {
  // Celebrity Autobiography: 7 dispatch-tier outlets — its remaining gaps are real.
  assert.equal(isNoPressNightShow(HOURS(70), 7), false);
});

test('no-press-night: never fires inside the grace window, however silent', () => {
  // The whole point of standing coverage: day-1 silence IS the signal.
  assert.equal(isNoPressNightShow(HOURS(NO_PRESS_NIGHT_GRACE_DAYS - 1), 0), false);
  assert.equal(isNoPressNightShow(1, 0), false);
});

test('no-press-night: exactly at the outlet bar is a press night', () => {
  assert.equal(isNoPressNightShow(HOURS(200), NO_PRESS_NIGHT_MIN_OUTLETS), false);
  assert.equal(isNoPressNightShow(HOURS(200), NO_PRESS_NIGHT_MIN_OUTLETS - 1), true);
});

test('no-press-night: an unknown clock never suppresses', () => {
  assert.equal(isNoPressNightShow(null, 0), false);
  assert.equal(isNoPressNightShow(NaN, 0), false);
});

// --- coverageExpectation drift (card #640) ---

describe('classifyCoverageExpectationDrift', () => {
  test('claim active: decided within the decay window, not contradicted', () => {
    const entry = { coverageExpectation: 'reviews', coverageExpectationDecidedAt: iso(9) };
    const v = classifyCoverageExpectationDrift(entry, { hasEvidence: true, overall: 0.05 }, NOW);
    assert.equal(v.status, 'active');
    assert.equal(v.isNoReviewClaim, false);
  });

  test('claim decayed: decidedAt older than the decay window', () => {
    const entry = { coverageExpectation: 'reviews', coverageExpectationDecidedAt: iso(COVERAGE_EXPECTATION_DECAY_DAYS + 1) };
    const v = classifyCoverageExpectationDrift(entry, { hasEvidence: true, overall: 0.05 }, NOW);
    assert.equal(v.status, 'decayed');
  });

  test('claim decayed: no decidedAt timestamp at all', () => {
    const entry = { coverageExpectation: 'reviews' };
    const v = classifyCoverageExpectationDrift(entry, { hasEvidence: true, overall: 0.05 }, NOW);
    assert.equal(v.status, 'decayed');
    assert.equal(v.ageDays, null);
  });

  test('claim contradicted: "none" claim but measured coverage is non-trivial', () => {
    const entry = { coverageExpectation: 'none', coverageExpectationDecidedAt: iso(3) };
    const v = classifyCoverageExpectationDrift(entry, { hasEvidence: true, overall: 0.6 }, NOW);
    assert.equal(v.status, 'contradicted');
    assert.equal(v.isNoReviewClaim, true);
  });

  test('claim contradicted fires even for an already-decayed determination', () => {
    const entry = { reviewsTheater: false, coverageExpectationDecidedAt: iso(100) };
    const v = classifyCoverageExpectationDrift(entry, { hasEvidence: true, overall: 0.9 }, NOW);
    assert.equal(v.status, 'contradicted');
  });

  test('no-evidence: too few in-window shows to measure, regardless of age', () => {
    const entry = { coverageExpectation: 'none', coverageExpectationDecidedAt: iso(1) };
    const v = classifyCoverageExpectationDrift(entry, { hasEvidence: false }, NOW);
    assert.equal(v.status, 'no-evidence');
  });

  test('a "none" claim with low measured coverage is active, not contradicted', () => {
    const entry = { coverageExpectation: 'none', coverageExpectationDecidedAt: iso(1) };
    const v = classifyCoverageExpectationDrift(entry, { hasEvidence: true, overall: 0.1 }, NOW);
    assert.equal(v.status, 'active');
  });

  test('outlet with no coverageExpectation claim at all returns null', () => {
    assert.equal(classifyCoverageExpectationDrift({}, { hasEvidence: true, overall: 0.9 }, NOW), null);
    assert.equal(classifyCoverageExpectationDrift(undefined, { hasEvidence: true, overall: 0.9 }, NOW), null);
  });
});

describe('evaluateCoverageExpectationDrift', () => {
  test('is not tier-filtered — a claim on any outlet is surfaced', () => {
    const shows = [];
    const reviews = [];
    for (let s = 0; s < 3; s++) {
      const seasonShows = makeShows('bw', 20, s);
      shows.push(...seasonShows);
      reviews.push(...makeReviews(seasonShows, 'probe', 20));
    }
    const registry = { probe: { tier: 5, coverageExpectation: 'none', coverageExpectationDecidedAt: iso(1) } };
    const r = evaluateCoverageExpectationDrift(shows, reviews, registry, NOW);
    assert.deepEqual(r.needsReprobe, ['probe']); // 100% coverage contradicts the "none" claim
  });

  test('outlets without any coverageExpectation claim are absent from rows', () => {
    const registry = { probe: { tier: 1 } };
    const r = evaluateCoverageExpectationDrift([], [], registry, NOW);
    assert.deepEqual(r.rows, []);
    assert.deepEqual(r.needsReprobe, []);
  });

  test('needsReprobe collects both decayed and contradicted, sorted', () => {
    const shows = [];
    const reviews = [];
    for (let s = 0; s < 3; s++) {
      const seasonShows = makeShows('bw', 20, s);
      shows.push(...seasonShows);
      reviews.push(...makeReviews(seasonShows, 'zzz', 20));
      reviews.push(...makeReviews(seasonShows, 'aaa', 0));
    }
    const registry = {
      zzz: { tier: 1, coverageExpectation: 'none', coverageExpectationDecidedAt: iso(1) }, // contradicted
      aaa: { tier: 1, coverageExpectation: 'reviews', coverageExpectationDecidedAt: iso(COVERAGE_EXPECTATION_DECAY_DAYS + 5) }, // decayed
    };
    const r = evaluateCoverageExpectationDrift(shows, reviews, registry, NOW);
    assert.deepEqual(r.needsReprobe, ['aaa', 'zzz']);
  });
});
