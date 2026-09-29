'use strict';

/**
 * fantasy-pricing.js — Pre-season expected-points model for the Broadway
 * Fantasy League.
 *
 * Why this exists: the 2025-26 trial priced shows from Gold Derby Tony odds
 * (compute-fantasy-scores.js --mode=projection + price-fantasy-league.js).
 * Those odds only exist from roughly April, but the 2026-27 draft opens in
 * October when most of the season hasn't opened. This module produces the
 * same E[points] shape (so price-fantasy-league.js's calibration still
 * applies) from signals we DO have in October:
 *
 *   - the show's type / revival status (base rates for noms, grosses)
 *   - a hand-set "buzz tier" 1-5 with a written reason
 *     (data/fantasy-preseason-priors.json — editable, reviewed each season;
 *     optional boxOfficeTier, runWeeks, awardsEligible per show)
 *   - category competition: how many shows are fighting for how many
 *     Best Musical / Best Play / Best Revival slots this season
 *   - realized data for shows that already opened: CriticScore,
 *     AudienceGrade, trailing weekly gross, announced closing date
 *
 * Everything is deterministic and explainable: every priced show carries a
 * `notes` array the Draft Guide can show ("Tier 5: ..., ~24 weeks of grosses,
 * 1 of 5 new musicals for 4 Best Musical slots").
 *
 * Used by: scripts/generate-fantasy-config.js (initial freeze + append-only
 * pricing of shows announced mid-season). Tested in fantasy-pricing.test.mjs.
 */

// ── Tier priors ────────────────────────────────────────────────────────
// P(CriticScore tier) by buzz tier. Rows sum to 1.
const CRITIC_TIER_PRIORS = {
  5: { 'Critical Gold': 0.40, 'Recommended': 0.35, 'Worth Seeing': 0.18, 'Skippable': 0.05, 'Critical Miss': 0.02 },
  4: { 'Critical Gold': 0.28, 'Recommended': 0.35, 'Worth Seeing': 0.25, 'Skippable': 0.09, 'Critical Miss': 0.03 },
  3: { 'Critical Gold': 0.18, 'Recommended': 0.30, 'Worth Seeing': 0.32, 'Skippable': 0.15, 'Critical Miss': 0.05 },
  2: { 'Critical Gold': 0.10, 'Recommended': 0.22, 'Worth Seeing': 0.35, 'Skippable': 0.23, 'Critical Miss': 0.10 },
  1: { 'Critical Gold': 0.05, 'Recommended': 0.15, 'Worth Seeing': 0.30, 'Skippable': 0.30, 'Critical Miss': 0.20 },
};

// P(AudienceGrade) by buzz tier. Audiences grade more generously than critics.
const AUDIENCE_GRADE_PRIORS = {
  5: { 'A+': 0.15, 'A': 0.25, 'A-': 0.30, 'B+': 0.20, 'B': 0.07, 'B-': 0.03 },
  4: { 'A+': 0.10, 'A': 0.20, 'A-': 0.30, 'B+': 0.25, 'B': 0.10, 'B-': 0.05 },
  3: { 'A+': 0.05, 'A': 0.15, 'A-': 0.28, 'B+': 0.30, 'B': 0.15, 'B-': 0.07 },
  2: { 'A+': 0.03, 'A': 0.10, 'A-': 0.22, 'B+': 0.30, 'B': 0.22, 'B-': 0.13 },
  1: { 'A+': 0.02, 'A': 0.06, 'A-': 0.15, 'B+': 0.27, 'B': 0.28, 'B-': 0.22 },
};

// Relative strength of a contender inside its Tony category, by buzz tier.
const TIER_WEIGHT = { 1: 0.4, 2: 0.7, 3: 1.0, 4: 1.5, 5: 2.2 };

// Weekly-gross multiplier on the type/revival base rate, by buzz tier.
const GROSS_MULTIPLIER = { 1: 0.70, 2: 0.85, 3: 1.00, 4: 1.20, 5: 1.50 };

// Expected additional nominations (acting, direction, design, score, book…)
// beyond the top-category nom, conditional on making the top category.
const EXTRA_NOMS_IF_TOP = { musical: 5.0, play: 3.0 };
// …and when the show misses the top category.
const EXTRA_NOMS_IF_NOT_TOP = { musical: 0.8, play: 0.5 };
// Share of nominations that convert to wins, by tier (Best-category winners
// tend to sweep more).
const WIN_RATE_BY_TIER = { 1: 0.10, 2: 0.14, 3: 0.18, 4: 0.24, 5: 0.32 };
// Pre-Tony ceremonies (Drama Desk, Outer Critics, Drama League, NYDCC) add
// roughly this much on top of Tony expectation for Broadway shows.
const PRECURSOR_MULTIPLIER = 1.35;
// Off-Broadway awards (Lortel, Drama Desk, OCC, Obie): expected points by tier.
const OB_AWARDS_EV_BY_TIER = { 1: 1.0, 2: 2.0, 3: 3.5, 4: 6.0, 5: 9.0 };

const DEFAULT_TIER = 3;
const MAX_NOM_PROB = 0.92;

// Weekly gross ceiling = seats × 8 performances × average ticket × 95% sold.
// A play at the 597-seat Hayes cannot gross the play-revival median of the
// 1,000-seat houses, so the type prior is capped by the house.
const AVG_TICKET_FOR_CAP = { musical: 150, play: 150 };
const CAP_OCCUPANCY = 0.95;
const PERFORMANCES_PER_WEEK = 8;

// Plays without an announced closing date almost always run as limited
// engagements (nonprofit houses and star vehicles alike); assume 16 weeks
// from the first performance. Musicals without a closing date carry closure
// risk that scales with their buzz: a tier-5 title is treated as open-ended
// through the scoring end, a tier-1 one as a 12-week run. Without this an
// early-opening tier-3 musical out-prices a spring frontrunner purely on
// weeks of grosses (ship-check 2026-09-29). priors.runWeeks overrides.
const DEFAULT_PLAY_RUN_WEEKS = 16;
const MUSICAL_RUN_WEEKS_BY_TIER = { 1: 12, 2: 16, 3: 22, 4: 30, 5: null };

function clampTier(t) {
  const n = Number(t);
  if (!Number.isFinite(n)) return DEFAULT_TIER;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function expectedFromPriors(priors, pointsTable) {
  let ev = 0;
  for (const [label, p] of Object.entries(priors)) ev += p * (pointsTable[label] || 0);
  return ev;
}

function round2(n) { return Math.round(n * 100) / 100; }

/** $1,245,000 → "$1.2M", $455,000 → "$455K" */
function fmtGross(n) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(n / 1000)}K`;
}

/** Which Tony top category a Broadway show competes in. */
function topCategoryFor(show) {
  if (show.category !== 'broadway') return null;
  if (show.type === 'musical') return show.isRevival ? 'Best Revival of a Musical' : 'Best Musical';
  if (show.type === 'play') return show.isRevival ? 'Best Revival of a Play' : 'Best Play';
  return null;
}

/**
 * Count scoring weeks (week-ending Sundays) a show can report grosses in the
 * fantasy window. Grosses are reported from the first preview, so the window
 * starts at previewsStartDate when known.
 */
function addDays(iso, days) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);
}

function boxOfficeWeeks(show, { scoringStart, scoringEnd, runWeeks, tier }) {
  const first = [show.previewsStartDate, show.openingDate].filter(Boolean).sort()[0];
  if (!first) return 0;
  const start = first > scoringStart ? first : scoringStart;
  let end = show.closingDate || null;
  if (!end) {
    let assumed;
    if (runWeeks != null) assumed = runWeeks;
    else if (show.type === 'musical') assumed = MUSICAL_RUN_WEEKS_BY_TIER[clampTier(tier)];
    else assumed = DEFAULT_PLAY_RUN_WEEKS;
    end = assumed != null ? addDays(first, assumed * 7) : scoringEnd;
  }
  if (end > scoringEnd) end = scoringEnd;
  if (end < start) return 0;
  const days = (Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86_400_000;
  return Math.floor(days / 7);
}

/** Weekly gross ceiling for a house, or null when capacity is unknown. */
function weeklyGrossCeiling(capacity, type) {
  if (!Number.isFinite(capacity) || capacity <= 0) return null;
  const atp = AVG_TICKET_FOR_CAP[type === 'musical' ? 'musical' : 'play'];
  return Math.round(capacity * PERFORMANCES_PER_WEEK * atp * CAP_OCCUPANCY);
}

/**
 * Build the per-category competition table for a season.
 * @param {Array} shows — Broadway shows in the catalog (need id, type, isRevival, category)
 * @param {object} priorsById — { [id]: { tier, awardsEligible? } }
 * @param {object} [slots] — nominees per category (default 4; Best Musical/Play use 5 when 8+ contenders)
 */
function buildCategoryField(shows, priorsById, slots = {}) {
  const field = {};
  for (const show of shows) {
    const cat = topCategoryFor(show);
    if (!cat) continue;
    const p = priorsById[show.id] || {};
    if (p.awardsEligible === false) continue;
    (field[cat] = field[cat] || { contenders: [], slots: 0 }).contenders.push({
      id: show.id, weight: TIER_WEIGHT[clampTier(p.tier)],
    });
  }
  for (const [cat, f] of Object.entries(field)) {
    const explicit = slots[cat];
    f.slots = explicit != null ? explicit : (f.contenders.length >= 8 ? 5 : 4);
    f.totalWeight = f.contenders.reduce((s, c) => s + c.weight, 0);
  }
  return field;
}

/**
 * Expected Tony + precursor awards points for a Broadway show.
 * Returns { points, pTopNom, pTopWin, expectedNoms, expectedWins, note }.
 */
function expectedAwardsPoints(show, priors, categoryField, scoringAwards) {
  const tier = clampTier(priors.tier);
  const cat = topCategoryFor(show);
  const eligible = priors.awardsEligible !== false && cat && categoryField[cat];
  if (!eligible) {
    // Special events / ineligible productions: an occasional design nod.
    const points = round2(0.3 * (scoringAwards.tonyNom || 0) * PRECURSOR_MULTIPLIER);
    return { points, pTopNom: 0, pTopWin: 0, expectedNoms: 0.3, expectedWins: 0, note: 'not a top-category contender' };
  }
  const field = categoryField[cat];
  const me = field.contenders.find(c => c.id === show.id);
  const weight = me ? me.weight : TIER_WEIGHT[tier];
  const pTopNom = Math.min(MAX_NOM_PROB, field.slots * weight / field.totalWeight);
  const pTopWin = Math.min(pTopNom, weight / field.totalWeight);
  const kind = show.type === 'musical' ? 'musical' : 'play';
  const expectedNoms = pTopNom * (1 + EXTRA_NOMS_IF_TOP[kind]) + (1 - pTopNom) * EXTRA_NOMS_IF_NOT_TOP[kind];
  const expectedWins = expectedNoms * WIN_RATE_BY_TIER[tier];
  const nomPts = expectedNoms * (scoringAwards.tonyNom || 0);
  // A win upgrades a nom's points to the win value.
  const winPts = expectedWins * ((scoringAwards.tonyWin || 0) - (scoringAwards.tonyNom || 0));
  const bestBonus = cat === 'Best Musical' ? (scoringAwards.tonyBestMusical || 0)
    : cat === 'Best Play' ? (scoringAwards.tonyBestPlay || 0) : 0;
  const bonusPts = pTopWin * bestBonus;
  const points = round2((nomPts + winPts + bonusPts) * PRECURSOR_MULTIPLIER);
  return {
    points, pTopNom: round2(pTopNom), pTopWin: round2(pTopWin),
    expectedNoms: round2(expectedNoms), expectedWins: round2(expectedWins),
    note: `${Math.round(pTopNom * 100)}% shot at a ${cat} nom (${field.contenders.length} contenders, ${field.slots} slots)`,
  };
}

/**
 * Project expected fantasy points for one show.
 *
 * @param {object} show — shows.json row (needs id, title, type, category, isRevival,
 *   openingDate, previewsStartDate, closingDate, status, slug)
 * @param {object} ctx
 *   ctx.scoring        — scoring tables from fantasy-season.json
 *   ctx.scoringStart / ctx.scoringEnd — ISO dates
 *   ctx.priors         — priors entry for this show ({ tier, note, awardsEligible })
 *   ctx.categoryField  — from buildCategoryField()
 *   ctx.criticScore    — realized CriticScore or null
 *   ctx.audienceGrade  — realized AudienceGrade or null
 *   ctx.criticLocked   — true when the show opened before scoringStart (score public before draft)
 *   ctx.trailingWeeklyGross — realized 4-week average gross for open shows, or null
 *   ctx.weeklyGrossPriors — { 'musical-new': 830000, ... }
 *   ctx.getCriticLabel / ctx.getAudienceGradeFromScore — tier mappers
 */
function projectShowPoints(show, ctx) {
  const priors = ctx.priors || {};
  const tier = clampTier(priors.tier);
  const notes = [];
  const isOB = show.category === 'off-broadway';
  const S = ctx.scoring;

  // CriticScore
  let criticEV = 0;
  if (ctx.criticLocked) {
    notes.push('CriticScore already public: no critic points');
  } else if (ctx.criticScore != null) {
    // Opened after scoringStart but before pricing ran (mid-season addition).
    criticEV = S.criticScore[ctx.getCriticLabel(ctx.criticScore)] || 0;
  } else {
    criticEV = expectedFromPriors(CRITIC_TIER_PRIORS[tier], S.criticScore);
  }

  // AudienceGrade
  let audienceEV = 0;
  if (ctx.criticLocked) {
    notes.push('AudienceGrade already public: no audience points');
  } else if (ctx.audienceGrade) {
    audienceEV = S.audienceGrade[ctx.audienceGrade] || 0;
  } else {
    audienceEV = expectedFromPriors(AUDIENCE_GRADE_PRIORS[tier], S.audienceGrade);
  }

  // Box office (Broadway only)
  let boxOfficeEV = 0;
  let weeks = 0;
  if (!isOB) {
    weeks = boxOfficeWeeks(show, { ...ctx, runWeeks: priors.runWeeks, tier });
    let weekly;
    if (ctx.trailingWeeklyGross) {
      weekly = ctx.trailingWeeklyGross;
      notes.push(`grossing about ${fmtGross(weekly)} a week`);
    } else {
      const key = `${show.type === 'musical' ? 'musical' : 'play'}-${show.isRevival ? 'revival' : 'new'}`;
      const base = ctx.weeklyGrossPriors[key] || 500_000;
      // A title can be a box-office lock without being an awards contender
      // (Billy Crystal's solo show) or vice versa; priors.boxOfficeTier
      // separates the two when they differ.
      const grossTier = priors.boxOfficeTier != null ? clampTier(priors.boxOfficeTier) : tier;
      weekly = base * GROSS_MULTIPLIER[grossTier];
      const ceiling = weeklyGrossCeiling(ctx.venueCapacity, show.type);
      if (ceiling != null && weekly > ceiling) weekly = ceiling;
      notes.push(`projected about ${fmtGross(weekly)} a week`);
    }
    boxOfficeEV = weeks * (weekly / 100_000) * S.boxOffice.pointsPer100K;
    const runAssumed = !show.closingDate && priors.runWeeks == null && (show.type !== 'musical' || MUSICAL_RUN_WEEKS_BY_TIER[tier] != null);
    notes.push(weeks > 0 ? `${weeks} scoring weeks of grosses${runAssumed ? ' (run length estimated)' : ''}` : 'no grosses left to earn');
  }

  // Awards
  let awardsEV = 0;
  let awardsDetail = null;
  if (isOB) {
    awardsEV = OB_AWARDS_EV_BY_TIER[tier];
  } else {
    awardsDetail = expectedAwardsPoints(show, priors, ctx.categoryField, S.awards);
    awardsEV = awardsDetail.points;
    notes.push(awardsDetail.note);
  }

  if (priors.note) notes.unshift(`Tier ${tier}: ${priors.note}`);
  else notes.unshift(`Tier ${tier}: priced as a typical ${show.category === 'off-broadway' ? 'Off-Broadway' : 'Broadway'} ${show.isRevival ? 'revival' : 'new'} ${show.type === 'musical' ? 'musical' : 'play'}`);

  const totalPoints = round2(criticEV + audienceEV + boxOfficeEV + awardsEV);
  return {
    criticScorePoints: round2(criticEV),
    audienceGradePoints: round2(audienceEV),
    boxOfficePoints: round2(boxOfficeEV),
    awardsPoints: round2(awardsEV),
    totalPoints,
    breakdown: {
      tier,
      boxOfficeWeeks: weeks,
      awards: awardsDetail,
      notes,
    },
  };
}

/** price = clamp(round(ev × k), min, max) — same shape as price-fantasy-league.js */
function priceFromEV(evPoints, k, { minPrice = 5, maxPrice = 35 } = {}) {
  if (!Number.isFinite(evPoints) || evPoints <= 0) return minPrice;
  return Math.max(minPrice, Math.min(maxPrice, Math.round(evPoints * k)));
}

/** k such that the top-N Broadway EVs average `targetTopPrice`. */
function calibrateK(evTotals, { targetTopPrice = 33, topN = 3 } = {}) {
  const sorted = evTotals.filter(Number.isFinite).sort((a, b) => b - a);
  if (sorted.length === 0) return null;
  const top = sorted.slice(0, topN);
  const avg = top.reduce((a, b) => a + b, 0) / top.length;
  if (avg <= 0) return null;
  return targetTopPrice / avg;
}

/** A one-line, player-facing pricing rationale for the Draft Guide. */
function priceNoteFor(projection) {
  const notes = projection.breakdown?.notes || [];
  return notes.slice(0, 3).join(' · ');
}

module.exports = {
  CRITIC_TIER_PRIORS,
  AUDIENCE_GRADE_PRIORS,
  TIER_WEIGHT,
  GROSS_MULTIPLIER,
  clampTier,
  topCategoryFor,
  boxOfficeWeeks,
  weeklyGrossCeiling,
  buildCategoryField,
  expectedAwardsPoints,
  projectShowPoints,
  priceFromEV,
  calibrateK,
  priceNoteFor,
};
