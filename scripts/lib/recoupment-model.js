/**
 * Broadway Recoupment Financial Model
 *
 * Calculates estimated recoupment percentage for Broadway shows using
 * a two-phase royalty model, variable cost decomposition, and weekly
 * grosses data where available.
 *
 * Key improvements over simple (gross × 0.87 - costs) / cap:
 * - Two-phase royalty model (pre/post recoupment)
 * - Theater rent as max(fixed_floor, pct_of_gross)
 * - Reserve fund requirement before declared recoupment
 * - Lagged tax credit (not applied at opening)
 * - Preview period with ramp curve and elevated costs
 * - Above-nut marketing surcharges (Tony season, holidays)
 * - Cost escalation from month 13 onward
 * - Group sales commission deduction
 * - Three-scenario output (optimistic/central/pessimistic)
 */

const { isCitedReportedWeeklyCost, REPORTED_COST_METHODOLOGIES } = require('./waltz-cost-gap-fill');
const { previewWeeksFromWeekly } = require('./preview-weeks');
const { runWindow, weeksInOwnRun, COVID_DARK_START, COVID_DARK_END } = require('./run-window');
const { taxCreditCited } = require('./tax-credit-cited');
const { nyTaxCredit, QUALIFYING_WEEKS, TAX_CREDIT_MAX, TAX_CREDIT_RATE, TAX_CREDIT_PROGRAM_START, TAX_CREDIT_PROGRAM_END } = require('./ny-tax-credit');
const { splitCosts, fixedNutFromBasis } = require('./cost-split');
const { sourcedGrossParticipation, weeklyParticipationCost, starDealUnknown } = require('./gross-participation');
const { isConvertedToCommercial } = require('./commercial-conversion');

// A nonprofit run that switched to a commercial run (BRO-5508) holds two
// productions' weeks under one grosses key, often in two theaters, and the
// shows.json dates and venue are the nonprofit's: no model rather than one
// that charges the nonprofit weeks to the commercial capitalization.
const SPLIT_RUN_ERROR = 'Split nonprofit/commercial run: not modelled';

// ---------------------------------------------------------------------------
// Constants & Defaults
// ---------------------------------------------------------------------------

/** Variable cost components (as fraction of gross) */
const COST_COMPONENTS = {
  ccFees: 0.025,           // Credit card processing
  groupSalesCommission: 0.015, // ~5-8% commission on ~20-30% of tickets
  directorRoyalty: 0.015,  // Director/choreographer
  otherVariable: 0.01,     // Insurance variable, misc
};

/**
 * Pre-recoupment author royalty rates (reduced during recoupment period).
 * Post-recoupment, authors shift to royalty pool (% of operating profit).
 */
const AUTHOR_ROYALTY_PRE = {
  musical: 0.045,   // 4.5% of gross (book + music + lyrics combined)
  play: 0.055,      // 5.5% of gross (playwright)
  special: 0.03,    // Solo/special shows
};

/** Post-recoupment royalty pool: % of weekly operating profit */
const ROYALTY_POOL_POST_RECOUP = 0.35;

/**
 * Theater owner share: The weekly nut already includes a fixed theater rent.
 * The theater owner also gets a percentage of gross ABOVE a breakpoint,
 * but only the overage above what's already in the nut.
 *
 * Modeled as: theater_variable = max(0, pct × gross - rentInNut)
 * This avoids double-counting the rent that's already in fixed costs.
 */
const THEATER_DEAL = {
  rentPctOfNut: 0.12,   // ~12% of weekly nut is theater rent (already in fixed costs)
  pctOfGross: 0.07,     // Theater gets 7% of gross OR the fixed rent, whichever is greater
};

/**
 * Variable cost rate defaults by show category.
 * These are the TOTAL pre-recoupment variable deduction from gross,
 * EXCLUDING the theater deal (modeled separately).
 */
const BASE_VARIABLE_RATES = {
  // CC + group sales + author royalty + director + other
  musical:          0.025 + 0.015 + 0.045 + 0.015 + 0.01,  // ~11%
  musicalSpectacle: 0.025 + 0.015 + 0.045 + 0.02  + 0.015, // ~12%
  play:             0.025 + 0.015 + 0.055 + 0.015 + 0.01,  // ~12%
  playStar:         0.025 + 0.02  + 0.055 + 0.015 + 0.015, // ~13% (stars add variable cost)
  special:          0.025 + 0.01  + 0.03  + 0.01  + 0.01,  // ~8.5%
};

/** Range multipliers for three-scenario output */
const SCENARIO_MULTIPLIERS = {
  optimistic:  { variableCost: 0.80, fixedCost: 0.92, grossAdj: 1.02 },
  central:     { variableCost: 1.00, fixedCost: 1.00, grossAdj: 1.00 },
  pessimistic: { variableCost: 1.20, fixedCost: 1.08, grossAdj: 0.97 },
};

/** Preview period defaults */
const PREVIEW_DEFAULTS = {
  grossPctWeek1: 0.45,    // First preview week: 45% of stabilized gross
  grossPctWeek2: 0.60,    // Second week: 60%
  grossPctWeek3: 0.75,    // Third week: 75%
  grossPctWeek4: 0.85,    // Fourth+ week: 85%
  costMultiplier: 1.25,   // 125% of weekly nut during previews (overtime, tech)
};

/** Reserve fund: weeks of operating costs held before declaring recoupment.
 *  Industry standard: 3-4 weeks for open-ended, 1.5 for limited runs. */
const RESERVE_FUND_WEEKS = 3;
const RESERVE_LAG_WEEKS = 8; // shadow, BRO-5073 opts.reserveLag
// opts.reserveIfStated: "capitalization excludes the reserve", "plus a $1M reserve".
const CAP_EXCLUDES_RESERVE = /\b(?:exclud\w*|not\s+includ\w*|plus|in\s+addition\s+to)\b[^.;]{0,40}\breserves?\b/i;

/** Tax credit lag in weeks from opening date */
const TAX_CREDIT_LAG_WEEKS = 78; // ~18 months

/**
 * NYC Musical and Theatrical Production Tax Credit: the amount, the program
 * window and the award lists live in ny-tax-credit.js (BRO-5517). Shows
 * running at any point from Aug 2021 qualify, including COVID reopenings —
 * NOT just shows that opened after 2021.
 */
// SVOG awards were first paid in late May 2021. A run replayed as of an
// earlier date (backtest asOf) had not received one (BRO-5073: Dear Evan
// Hansen replayed at its July 2017 recoupment read 937% with a 2021 grant
// netted off its cap). Live runs are always past this date.
const SVOG_FIRST_AWARDS = new Date('2021-05-25');

/**
 * Estimated-nut era adjustment: cost defaults are calibrated to 2025-26
 * price levels, but grosses are nominal to the show's era. Broadway weekly
 * operating costs inflate ~2.5%/yr, so a 2002 musical's nut was roughly
 * 55-60% of today's equivalent.
 */
const ERA_ANCHOR_YEAR = 2025;
const ERA_DEFLATION_RATE = 0.015;
const ERA_DEFLATOR_FLOOR = 0.5;

/**
 * Broadway theater seat counts, keyed by a distinctive lowercase substring of
 * the venue name. Used to scale ESTIMATED nuts: a play at the 597-seat Hayes
 * costs far less to run weekly than one at an 1,100-seat house.
 */
const THEATER_SEATS = {
  'gershwin': 1933, 'broadway theatre': 1761, 'new amsterdam': 1747, 'palace': 1743,
  'minskoff': 1710, 'st. james': 1709, 'majestic': 1645, 'lyric': 1622,
  'marquis': 1611, 'winter garden': 1526, 'lunt-fontanne': 1519, 'shubert': 1460,
  'neil simon': 1445, 'imperial': 1443, 'hirschfeld': 1424, 'richard rodgers': 1319,
  'august wilson': 1275, 'nederlander': 1235, 'broadhurst': 1156, 'ambassador': 1125,
  "eugene o'neill": 1108, 'barrymore': 1096, 'james earl jones': 1092, 'cort': 1092,
  'vivian beaumont': 1080, 'schoenfeld': 1079, 'jacobs': 1078, 'longacre': 1077,
  'lena horne': 1069, 'brooks atkinson': 1069, 'sondheim': 1055, 'belasco': 1016,
  'music box': 1009, 'studio 54': 1006, 'hudson': 970, 'walter kerr': 945,
  'lyceum': 922, 'golden': 805, 'circle in the square': 776, 'booth': 766,
  'todd haimes': 740, 'american airlines': 740, 'friedman': 650, 'hayes': 597,
};

/** Seat counts each category's default nut is calibrated to */
const NUT_SEAT_ANCHORS = {
  musicalSpectacle: 1700,
  musical: 1400,
  play: 1050,
  playStar: 1050,
  special: 900,
};

/** Above-nut marketing surcharges by show type (incremental above base marketing in the nut) */
const MARKETING_SURCHARGES = {
  openingPush: {
    weeks: [1, 2, 3, 4, 5, 6, 7, 8],
    musicalSpectacle: 200000, musical: 150000, play: 75000, playStar: 75000, special: 50000,
  },
  tonySeasonApprox: {
    weekOfYear: [18, 19, 20, 21, 22, 23],
    musicalSpectacle: 175000, musical: 125000, play: 60000, playStar: 60000, special: 40000,
  },
  holidayApprox: {
    weekOfYear: [47, 48, 49, 50, 51, 52, 1],
    musicalSpectacle: 100000, musical: 75000, play: 40000, playStar: 40000, special: 25000,
  },
};

/** Cost escalation: annual rate applied from week 53 onward */
const ANNUAL_COST_ESCALATION = 0.03;

/** COVID shutdown dates live in run-window.js; re-exported below. */
const COVID_DARK_WEEKS = 78;

/**
 * Known SVOG grants (max $10M per show).
 *
 * BRO-4623: wicked, the-lion-king and aladdin were removed. Disney is a
 * publicly traded company and was ineligible (commercial.json notes, per
 * Variety Mar 2021), and Wicked's research notes record no SVOG. Only add a
 * show here with a cited grant (news report or SBA award list). Keys are
 * commercial.json slugs (tests/unit/cost-split.test.mjs checks). Since BRO-5073
 * the grant is not netted off the cap unless opts.svogCredit is set.
 */
const KNOWN_SVOG = {
  'hamilton': 10000000,
  'book-of-mormon': 10000000,
  'hadestown': 10000000,
  'mj': 10000000,
  'six': 10000000,
  'moulin-rouge': 9900000,
  'aint-too-proud-2019': 10000000,
  'chicago': 10000000,
  'dear-evan-hansen-2016': 10000000,
  'come-from-away-2017': 10000000,
  'mean-girls-2018': 10000000,
  'harry-potter': 10000000,
  'frozen-2018': 10000000,
  'jagged-little-pill-2019': 10000000,
  'tina-2019': 10000000,
};

/** Known star deals — weekly premium + % of gross above threshold.
 *  Unsourced. opts.sourcedStarDeals (shadow, BRO-5029) ignores this list and
 *  reads commercial.json grossParticipation instead. */
const KNOWN_STAR_DEALS = {
  'the-music-man-2022': { weeklyPremium: 350000, grossPct: 0.08, grossThreshold: 1200000 }, // Jackman ($150K+/wk + 10% of gross) + Foster + elaborate production
  'hells-kitchen': { weeklyPremium: 75000, grossPct: 0.03, grossThreshold: 1000000 }, // Alicia Keys creator deal
  'gypsy-2024': { weeklyPremium: 100000, grossPct: 0.02, grossThreshold: 1200000 }, // Audra McDonald
};

/** Closing costs: strike, crew buyout, contract termination.
 *  Proportional to show size. Quick flops pay these on a near-empty treasury. */
const CLOSING_COSTS = {
  musicalSpectacle: 500000,  // Large scenic teardown
  musical: 300000,           // Standard scenic + crew
  play: 150000,              // Minimal scenic
  playStar: 200000,          // Moderate
  special: 75000,            // Minimal
};

/** Max simulation weeks (10 years) */
const MAX_SIMULATION_WEEKS = 520;

// ---------------------------------------------------------------------------
// Model Functions
// ---------------------------------------------------------------------------

/**
 * Classify a show for variable cost rate selection.
 */
function classifyShow(show) {
  const type = show.type || 'musical';
  const venue = show.venue || '';
  const title = (show.title || '').toLowerCase();

  // Spectacle musicals: large theaters + known spectacle indicators
  // (Great Comet: immersive Imperial rebuild, 30+ cast — spectacle-scale nut)
  const spectacleKeywords = /cirque|spider|lion king|phantom|wicked|frozen|aladdin|mary poppins|little mermaid|great comet/i;
  const isSpectacle = type === 'musical' && spectacleKeywords.test(title);

  // Star-driven plays: short limited runs at larger houses. Star-vehicle
  // economics (above-scale salaries, premium pricing) need a >=850-seat house;
  // a short run at the 597-seat Hayes is just a small play, not a star play.
  const seats = getTheaterSeats(venue);
  const isStarPlay = type === 'play' && show.closingDate && show.openingDate &&
    (new Date(show.closingDate) - new Date(show.openingDate)) < 180 * 86400000 && // < 6 months
    (seats === null || seats >= 850);

  if (type === 'special' || isSoloShow(show)) return 'special';
  if (isSpectacle) return 'musicalSpectacle';
  if (isStarPlay) return 'playStar';
  if (type === 'play') return 'play';
  return 'musical';
}

/**
 * Solo / one-person shows: 'special' economics (tiny cast, minimal crew,
 * low variable rate, minimal closing costs) regardless of the play/special
 * type label in shows.json.
 */
function isSoloShow(show) {
  const title = (show.title || '').toLowerCase();
  return /\bsolo\b|one.?(?:man|woman|person)\s+show/i.test(title) ||
    /prima facie|just for us|fleabag|mike birbiglia|alex edelman|colin quinn|john mulaney|derren brown/i.test(title);
}

/**
 * Deflate a 2025-anchored estimated cost to the show's opening-year price level.
 */
function eraDeflator(openingDate) {
  const year = openingDate ? parseInt(String(openingDate).split('-')[0], 10) : ERA_ANCHOR_YEAR;
  if (!year || year >= ERA_ANCHOR_YEAR) return 1;
  return Math.max(Math.pow(1 - ERA_DEFLATION_RATE, ERA_ANCHOR_YEAR - year), ERA_DEFLATOR_FLOOR);
}

/** Look up seat count from a venue name; null when unknown. */
function getTheaterSeats(venueName) {
  const venue = (venueName || '').toLowerCase();
  if (!venue) return null;
  for (const [key, count] of Object.entries(THEATER_SEATS)) {
    if (venue.includes(key)) return count;
  }
  return null;
}

/**
 * Scale an estimated nut by venue size relative to the category's anchor house.
 * Returns 1 when the venue is unknown.
 */
function venueSizeFactor(show, category) {
  const seats = getTheaterSeats(show.venue);
  if (!seats) return 1;
  const anchor = NUT_SEAT_ANCHORS[category] || NUT_SEAT_ANCHORS.musical;
  return Math.min(Math.max(seats / anchor, 0.65), 1.2);
}

/**
 * Get the base variable cost rate for a show category.
 */
function getBaseVariableRate(category) {
  return BASE_VARIABLE_RATES[category] || BASE_VARIABLE_RATES.musical;
}

/**
 * Calculate the pre-recoupment author royalty rate for a show type.
 */
function getAuthorRoyaltyPre(showType) {
  return AUTHOR_ROYALTY_PRE[showType] || AUTHOR_ROYALTY_PRE.musical;
}

/**
 * Calculate theater OVERAGE cost for a given week.
 * The fixed rent is already included in the weekly nut.
 * This calculates the additional variable share the theater gets
 * when gross × pct exceeds the fixed rent.
 */
function calcTheaterOverage(weeklyGross, weeklyNut) {
  const rentInNut = weeklyNut * THEATER_DEAL.rentPctOfNut;
  const pctShare = weeklyGross * THEATER_DEAL.pctOfGross;
  // Theater gets the GREATER of fixed rent or pct of gross.
  // Since fixed rent is already in the nut, we only add the overage.
  return Math.max(0, pctShare - rentInNut);
}

/**
 * Shadow running-cost path (BRO-5073, --opt=stepSmall|stepLate|costGrowth).
 * The live path is full cost to week 52, x0.93 to week 104, x0.88 after.
 *   stepSmall   x0.96 / x0.93 instead of x0.93 / x0.88
 *   stepLate    the same cuts a half-year later (after weeks 78 and 156)
 *   costGrowth  costs rise COST_GROWTH_RATE a year from opening (union
 *               escalators), on top of whichever step-downs apply
 * @param {number} weekNumber
 * @param {{ stepSmall?: boolean, stepLate?: boolean, costGrowth?: boolean }} path
 */
const COST_GROWTH_RATE = 0.035;
function costPathFactor(weekNumber, path) {
  const [y2, y3] = path.stepSmall ? [0.96, 0.93] : [0.93, 0.88];
  const [w2, w3] = path.stepLate ? [78, 156] : [52, 104];
  const step = weekNumber > w3 ? y3 : weekNumber > w2 ? y2 : 1;
  const growth = path.costGrowth ? Math.pow(1 + COST_GROWTH_RATE, (weekNumber - 1) / 52) : 1;
  return step * growth;
}

/**
 * Shadow variable-cost shape (BRO-5073, --opt=varBand|varOverage). Live
 * deducts a flat ~11% of gross plus any theater overage. u/Boring_Waltz_9545's
 * weekly posts deduct more as gross rises against cost: about 12% of gross
 * below 0.9x cost, about 23.5% at 1.5x and up (inference, so shadow only).
 *   varBand     total deductions ramp linearly from VAR_BAND.low at 0.9x
 *               cost to VAR_BAND.high at 1.5x; the extra over live is added
 *   varOverage  the same deduction at 1.5x, but charged only on gross above
 *               the weekly cost (theater and royalty steps on overages):
 *               OVERAGE_RATE = (0.235 - 0.11) x 1.5 / 0.5
 *   varBandMusicals  varBand for musicals only (his posts are mostly musicals)
 *   varOverageMusicals  varOverage for musicals only (BRO-5091)
 *   varBandMusicalsRamp varBand for musicals only, phased in from week 26
 *               to week 78 (VAR_RAMP, BRO-5091): the timing test's fast
 *               recoupers (under ~45 weeks) carry no such gap, the long-run
 *               hits a steady $110-160K a week the live model leaves out.
 *               Windows 0-52 and 30-60 pushed Hairspray, Jersey Boys,
 *               Kinky Boots and Merrily out of band; 39-91 and 52-104 did less.
 *               Weeks are the schedule index (estimated previews plus
 *               gap-filled weeks), so a little ahead of weeks played. The
 *               window was tuned on the rows it is scored on: promote only
 *               after a holdout check. Plays are never ramped.
 * Returns the extra variable cost in dollars (0 when neither is set).
 */
const VAR_BAND = { fromRatio: 0.9, toRatio: 1.5, low: 0.12, high: 0.235 };
const OVERAGE_RATE = 0.375;
const VAR_RAMP = { from: 26, to: 78 };
function extraVariableCost(adjGross, nut, liveDeductions, path) {
  if (!path || !(nut > 0) || !(adjGross > 0)) return 0;
  if (path.varBand) {
    const t = Math.min(1, Math.max(0, (adjGross / nut - VAR_BAND.fromRatio) / (VAR_BAND.toRatio - VAR_BAND.fromRatio)));
    return Math.max(0, (VAR_BAND.low + (VAR_BAND.high - VAR_BAND.low) * t) * adjGross - liveDeductions);
  }
  if (path.varOverage) return OVERAGE_RATE * Math.max(0, adjGross - nut);
  return 0;
}

/**
 * Calculate weekly operating profit for ONE week.
 *
 * Pre-recoupment: variable costs = base rate × gross + theater deal
 * Post-recoupment: add royalty pool (35% of operating profit)
 *
 * @param {number} weeklyGross - Broadway League reported gross
 * @param {number} weeklyNut - Fixed weekly operating costs
 * @param {number} baseVarRate - Base variable cost rate (excl theater)
 * @param {boolean} isPostRecoup - Whether recoupment has been reached
 * @param {number} weekNumber - Week number from opening (for cost escalation)
 * @param {boolean} isPreview - Whether this is a preview week
 * @param {number} scenarioMult - Scenario multiplier object
 * @param {object} [costPath] - shadow cost path (costPathFactor); live passes none
 * @returns {{ profit: number, variableCosts: number, theaterCost: number, fixedCosts: number }}
 */
function calcWeeklyProfit(weeklyGross, weeklyNut, baseVarRate, isPostRecoup, weekNumber, isPreview, scenarioMult, totalWeeks, showType, showCategory, costPath) {
  const mult = scenarioMult || SCENARIO_MULTIPLIERS.central;
  const adjGross = weeklyGross * mult.grossAdj;

  // Variable costs (percentage of gross, excluding theater)
  // Post-recoupment: REMOVE author royalty from base rate (replaced by royalty pool)
  let effectiveVarRate = baseVarRate;
  if (isPostRecoup) {
    const authorRate = AUTHOR_ROYALTY_PRE[showType] || AUTHOR_ROYALTY_PRE.musical;
    effectiveVarRate = baseVarRate - authorRate; // Authors shift to profit pool
  }
  const adjVarRate = effectiveVarRate * mult.variableCost;
  const variableCosts = adjGross * adjVarRate;

  // Theater cost: max(floor, pct of gross)
  const theaterCost = calcTheaterOverage(adjGross, weeklyNut);

  // Fixed costs: phased model reflecting how costs change over a run.
  // The weeklyNut we have is typically the steady-state cost.
  // Phase 1 (weeks 1-26): Full nut (launch period, original cast/stars)
  // Phase 2 (weeks 27-52): Full nut (steady state, year 1)
  // Phase 3 (weeks 53-104): Nut × 0.93 (year 2+: cast replacements save ~7%, reduced marketing)
  // Phase 4 (weeks 105+): Nut × 0.88 (mature run: further optimization, but offset by union escalators)
  let fixedCosts = weeklyNut * mult.fixedCost;
  if (costPath) {
    fixedCosts *= costPathFactor(weekNumber, costPath); // shadow, BRO-5073
  } else if (weekNumber > 104) {
    fixedCosts *= 0.88; // Mature run cap — no further reduction
  } else if (weekNumber > 52) {
    fixedCosts *= 0.93;
  }
  // No additional deflation for long runs — Broadway costs inflate over time.
  // The 0.88 floor already captures cast replacement savings and optimization.

  // Shadow variable-cost shape against this week's running cost (BRO-5073).
  const musical = !/^play/.test(showCategory || '');
  const bandPath = costPath && musical && (costPath.varBandMusicals || costPath.varBandMusicalsRamp) ? { ...costPath, varBand: true }
    : costPath && musical && costPath.varOverageMusicals ? { ...costPath, varOverage: true } : costPath;
  const ramp = costPath && musical && costPath.varBandMusicalsRamp ? Math.min(1, Math.max(0, weekNumber - VAR_RAMP.from) / (VAR_RAMP.to - VAR_RAMP.from)) : 1;
  const extraVar = costPath ? extraVariableCost(adjGross, fixedCosts, variableCosts + theaterCost, bandPath) * mult.variableCost * ramp : 0;

  // Preview cost premium
  if (isPreview) {
    fixedCosts *= PREVIEW_DEFAULTS.costMultiplier;
  }

  // Marketing surcharges (scaled by show type)
  const cat = showCategory || 'musical';
  if (weekNumber <= 8) {
    fixedCosts += MARKETING_SURCHARGES.openingPush[cat] || MARKETING_SURCHARGES.openingPush.musical;
  }

  // Pre-recoupment operating profit
  let operatingProfit = adjGross - variableCosts - extraVar - theaterCost - fixedCosts;

  // Post-recoupment: royalty pool takes 35% of operating profit
  if (isPostRecoup && operatingProfit > 0) {
    const royaltyPool = operatingProfit * ROYALTY_POOL_POST_RECOUP;
    operatingProfit -= royaltyPool;
  }

  return {
    profit: operatingProfit,
    variableCosts: variableCosts + extraVar,
    theaterCost,
    fixedCosts,
    adjGross,
  };
}

/**
 * Estimate preview period weekly grosses as a ramp.
 */
function getPreviewGrossMultiplier(previewWeek) {
  if (previewWeek <= 1) return PREVIEW_DEFAULTS.grossPctWeek1;
  if (previewWeek <= 2) return PREVIEW_DEFAULTS.grossPctWeek2;
  if (previewWeek <= 3) return PREVIEW_DEFAULTS.grossPctWeek3;
  return PREVIEW_DEFAULTS.grossPctWeek4;
}

/**
 * Calculate recoupment for a single show.
 *
 * @param {object} show - Show data from shows.json
 * @param {object} commercial - Commercial data from commercial.json
 * @param {object} grossesAllTime - From grosses.json { gross, performances, attendance }
 * @param {object} grossesWeekly - From grosses-history.json { [weekDate]: { gross, capacity, atp, attendance, performances } }
 * @param {object} [opts]
 * @param {boolean} [opts.previewsFromWeekly] - shadow only (BRO-5002): estimate
 *   only the preview weeks the weekly history does not already cover. Off
 *   (live behavior) by default.
 * @param {boolean} [opts.playedWeeksOnly] - shadow only (BRO-5003): count a
 *   running show's weeks to today, not to an announced closing date. Off
 *   (live behavior) by default.
 * @param {boolean} [opts.ownRunOnly] - shadow only (BRO-4989): drop weekly
 *   rows from outside this production's previews..closing window, which an
 *   earlier production sharing the grosses key leaves behind (Cabaret 2024
 *   ran on 239 weeks back to 2001). Off (live behavior) by default.
 * @param {boolean} [opts.sourcedStarDeals] - shadow only (BRO-5029): star
 *   deals come only from sourced commercial.grossParticipation entries; a
 *   star-driven show with none returns starDealUnknown (held), never a guessed
 *   premium. Off (live behavior) by default. Before a live switch the
 *   checker must rule whether a reported weeklyRunningCost already holds the
 *   star's guarantee (and the playStar rate its share): the charge here is
 *   on top of both.
 * @returns {object} RecoupmentModelResult
 */
/**
 * Musical calibration (BRO-5598): three former shadow options are live for
 * musicals only, so the live play bar is unchanged.
 *   previewsFromWeekly  estimate only the preview weeks the weekly grosses
 *                       do not already cover (BRO-5002: they were counted twice)
 *   datedCosts          each week's cost from its own date (cost index, BRO-4989)
 *   varBandMusicalsCited the varBand deduction shape (BRO-5073), only on a cited
 *                       running cost: an estimated cost was fitted to the old
 *                       flat deduction, and an all-in or breakeven figure
 *                       already holds the gross-linked costs
 * Timing backtest, musicals: MAE 18.4 -> 14.1, inside 34 -> 37 of 60; reported
 * truth musicals 4.6 -> 3.7, 0 new false recouped. An explicit false in opts
 * turns one off (shadow comparisons).
 */
const MUSICAL_LIVE_OPTS = Object.freeze({ previewsFromWeekly: true, datedCosts: true, varBandMusicalsCited: true });
function withMusicalDefaults(show, opts) {
  return (show.type || 'musical') === 'musical' ? { ...MUSICAL_LIVE_OPTS, ...opts } : opts;
}

function calculateRecoupment(show, commercial, grossesAllTime, grossesWeekly, opts = {}) {
  opts = withMusicalDefaults(show, opts);
  const warnings = [];
  if (isConvertedToCommercial(commercial)) return { error: SPLIT_RUN_ERROR, warnings: [SPLIT_RUN_ERROR] };
  if (opts.ownRunOnly) {
    const own = weeksInOwnRun(grossesWeekly, show);
    if (own.dropped.length) warnings.push(`Dropped ${own.dropped.length} weekly rows from outside this production's run (${own.dropped[0]}..${own.dropped[own.dropped.length - 1]})`);
    grossesWeekly = own.weekly;
  }

  // Backtest only (BRO-4989): run the model as it stood on a past date
  // (a reported figure's as-of date): weekly rows after it are dropped, the
  // run ends there, and a show still running then is treated as running.
  const asOf = opts.asOf ? new Date(opts.asOf) : null;
  const weeklyUncut = grossesWeekly; // a cost quote's period may lie past asOf
  if (asOf) {
    if (Number.isNaN(asOf.getTime())) return { error: 'Bad asOf date', warnings: ['Bad asOf date'] };
    const iso = asOf.toISOString().slice(0, 10);
    grossesWeekly = Object.fromEntries(Object.entries(grossesWeekly || {}).filter(([d]) => d <= iso));
    if (!Object.keys(grossesWeekly).length) return { error: 'No weekly grosses before asOf', warnings: ['No weekly grosses before asOf'] };
    grossesAllTime = null; // a cumulative total cannot be cut at a date
  }
  const now = asOf || new Date();

  // --- Inputs ---
  const capitalization = commercial.capitalization;
  if (!capitalization) {
    return { error: 'No capitalization data', warnings: ['Missing capitalization'] };
  }

  const category = classifyShow(show);
  // Shadow only (BRO-5093, opts.costBasis): a breakeven or all-in figure is
  // turned back into the fixed nut the rest of the model expects. The
  // reserve and tax-credit estimate follow it (they are weeks of the real
  // nut), and costSplit is skipped so the share is not taken off twice.
  const basisNut = opts.costBasis && commercial.weeklyRunningCost ? fixedNutFromBasis(commercial, commercial.weeklyRunningCost, getBaseVariableRate(category), THEATER_DEAL, weeklyUncut) : null;
  const weeklyNut = basisNut ? basisNut.nut : commercial.weeklyRunningCost || estimateWeeklyNut(show, commercial);
  // opts.costSourcedOnly (shadow, BRO-5073): a weekly cost with no cited
  // source counts as 'unsourced', and only a cited cost lifts quality (a
  // methodology label with no cost behind it does not).
  const costUnsourced = !!(opts.costSourcedOnly && commercial.weeklyRunningCost && !isCitedReportedWeeklyCost(commercial));
  const nutSource = costUnsourced ? 'unsourced' : commercial.weeklyRunningCost ? 'reported' : 'estimated';
  if (nutSource === 'estimated') {
    warnings.push('Weekly running cost estimated from show type');
  }
  if (basisNut && basisNut.basis !== 'running') warnings.push(`Weekly cost is ${basisNut.basis}: fixed nut ${Math.round(basisNut.nut)}${basisNut.gross ? ` at ${basisNut.fromPeriod ? 'the quoted period\'s average gross' : 'a gross equal to the figure (no period in the quote)'} ${Math.round(basisNut.gross)}` : ''}`);
  if (basisNut && basisNut.rejected) warnings.push(`Weekly cost tagged ${basisNut.rejected} but its gross-linked share exceeds it: used as a fixed nut`);

  // Shadow only (BRO-5073, opts.costSplit): fixed part of the cost and a
  // larger gross-linked rate. The reserve and cap stay on the reported cost.
  const split = opts.costSplit && !basisNut ? splitCosts(commercial, category, weeklyNut, getBaseVariableRate(category), THEATER_DEAL.pctOfGross) : null;
  const baseVarRate = split ? split.varRate : getBaseVariableRate(category);
  const runNut = split ? split.fixedNut : weeklyNut;
  const citedBand = !!opts.varBandMusicalsCited && isCitedReportedWeeklyCost(commercial) && !['all-in', 'breakeven'].includes(commercial.weeklyRunningCostBasis);
  const costPath = opts.stepSmall || opts.stepLate || opts.costGrowth || opts.varBand || opts.varOverage || opts.varBandMusicals || opts.varOverageMusicals || opts.varBandMusicalsRamp || citedBand
    ? { stepSmall: !!opts.stepSmall, stepLate: !!opts.stepLate, costGrowth: !!opts.costGrowth, varBand: !!opts.varBand, varOverage: !!opts.varOverage, varBandMusicals: !!opts.varBandMusicals || citedBand, varOverageMusicals: !!opts.varOverageMusicals, varBandMusicalsRamp: !!opts.varBandMusicalsRamp } : null; // shadow, BRO-5073/5091

  // --- Star deal ---
  const slug = show.slug || show.id;
  // Star deals: only apply for KNOWN deals, not as a default.
  // Most plays don't have above-scale star compensation — applying a default
  // causes false negatives for shows that actually recouped.
  const sourcedDeals = opts.sourcedStarDeals ? sourcedGrossParticipation(commercial) : null;
  const starDeal = sourcedDeals ? null : KNOWN_STAR_DEALS[slug] || null;
  const dealUnknown = !!sourcedDeals && starDealUnknown({ starDriven: category === 'playStar' || !!KNOWN_STAR_DEALS[slug], entries: sourcedDeals.entries });
  if (sourcedDeals) {
    for (const { reason } of sourcedDeals.ignored) warnings.push(`grossParticipation entry ignored: ${reason}`);
    if (sourcedDeals.entries.length) warnings.push(`Star deal: ${sourcedDeals.entries.length} sourced grossParticipation entr${sourcedDeals.entries.length === 1 ? 'y' : 'ies'}`);
    if (dealUnknown) warnings.push('Star deal unknown: star-driven with no sourced grossParticipation (held)');
  }
  if (starDeal) {
    warnings.push(`Star deal: +$${(starDeal.weeklyPremium/1000).toFixed(0)}K/wk + ${(starDeal.grossPct*100).toFixed(0)}% above $${(starDeal.grossThreshold/1e6).toFixed(1)}M`);
  }

  // --- Effective capitalization ---
  // SVOG is not netted off the cap (BRO-5073). The model counts played weeks
  // only, and the grant mostly reimbursed shutdown costs it never charges, so
  // subtracting it double-counted (Six: $10M grant on a $5M cap read 1879%).
  // No record says a grant went to investors. opts.svogCredit replays the old rule.
  const svogGrant = now < SVOG_FIRST_AWARDS || !opts.svogCredit ? 0 : (KNOWN_SVOG[slug] || parseSvogFromNotes(commercial.notes) || 0);

  // NY theater tax credit: eligible if the show's run overlaps the program
  // window (Aug 2021 – 2027), which includes COVID reopenings of older shows.
  // Credit = 25% of qualified production + operating costs (first year),
  // capped at $3M — Broadway-scale shows nearly always hit the cap.
  const notesCredit = parseTaxCreditFromNotes(commercial.notes);
  const runEndForCredit = show.closingDate && new Date(show.closingDate) < now ? new Date(show.closingDate) : now;
  const runStartForCredit = show.openingDate ? new Date(show.openingDate) : null;
  // Undated shows can't prove eligibility — no credit rather than a $3M gift
  const eligibleForTaxCredit = !!runStartForCredit &&
    runEndForCredit >= TAX_CREDIT_PROGRAM_START &&
    runStartForCredit <= TAX_CREDIT_PROGRAM_END;

  // Reserve fund: scaled by run length. Long-running shows need full reserve;
  // limited runs (< 6 months) need less because producers budget to the close date.
  const isLimitedRun = show.closingDate && show.openingDate &&
    (new Date(show.closingDate) - new Date(show.openingDate)) < 200 * 86400000;
  // Shadow (BRO-5073, opts.reserveLag): producers hold more than 3 weeks
  // (bonds, working capital) and announce a few weeks after the books close.
  // Shadow (BRO-5073): a Broadway capitalization usually already budgets the
  // reserve and bonds, so adding one on top may double count. opts.noReserve
  // drops it; opts.reserveIfStated keeps it only when the record says the
  // capitalization excludes the reserve.
  const reserveExcluded = !opts.reserveIfStated || CAP_EXCLUDES_RESERVE.test(`${commercial.capitalizationSource || ''} ${commercial.notes || ''}`);
  const reserveWeeks = opts.noReserve || !reserveExcluded ? 0 : isLimitedRun ? 1.5 : (opts.reserveLag ? RESERVE_LAG_WEEKS : RESERVE_FUND_WEEKS);
  const reserveFund = weeklyNut * reserveWeeks;
  // Effective cap can't go below zero (SVOG can't make cap negative); with no
  // reserve the floor is one week of nut, as for a closed run.
  const effectiveCap = Math.max(capitalization - svogGrant + reserveFund, reserveFund || weeklyNut);
  // Tax credit timing: for closed shows, apply at closing (credit is eventual certainty).
  // For running shows, lag 18 months from opening.
  const isClosed = show.closingDate && new Date(show.closingDate) < now;
  const taxCreditWeek = isClosed ? Infinity : TAX_CREDIT_LAG_WEEKS; // Infinity = applied at end

  // The reserve delays WHEN recoupment is declared (recoup-week threshold) but
  // is returned to the treasury, not spent. For CLOSED shows the ledger is
  // final: recoupment means the cap itself was repaid, so the percentage is
  // measured against cap net of SVOG without the reserve. Running shows keep
  // the reserve in the denominator (conservative until the run is final).
  const capForPct = isClosed
    ? Math.max(capitalization - svogGrant, weeklyNut)
    : effectiveCap;

  // --- Run window: preview weeks and weeks played (scripts/lib/run-window.js) ---
  const { previewWeeks, totalRunWeeks, darkWeeks } = runWindow(show, { now, playedOnly: !!(opts.playedWeeksOnly || asOf) });
  if (darkWeeks > 0) warnings.push(`Excluded ${darkWeeks} COVID dark weeks`);

  // Tax credit amount (needs run length): a published ESD award, else the
  // formula on the cap + the first QUALIFYING_WEEKS of running costs (BRO-5517).
  // notesCredit is null when the notes say nothing usable, 0 when they say the
  // credit was NOT received (BRO-4623: All Out), or a parsed dollar amount.
  const credit = nyTaxCredit({
    slug, notesCredit, eligible: eligibleForTaxCredit, capitalization, now,
    qualifyingRunningCosts: weeklyNut * Math.min(Math.max(totalRunWeeks, 0), QUALIFYING_WEEKS),
  });
  const expectedTaxCredit = credit.amount;
  // Shadow (BRO-4989): a running show's credit counts only once a source says
  // it was received (an ESD payment counts). A closed show keeps it: the
  // credit does get paid.
  // opts.taxCreditPre (BRO-5073): pre-credit basis, no credit at all, so the
  // backtest can score a pre-credit truth figure like with like.
  const taxCreditExcluded = opts.taxCreditPre || (opts.taxCreditCitedOnly && !isClosed && !credit.received && !taxCreditCited(commercial).cited) ? expectedTaxCredit : 0;
  const taxCreditAmount = expectedTaxCredit - taxCreditExcluded;
  if (notesCredit === 0) {
    warnings.push(NO_TAX_CREDIT_FROM_NOTES_WARNING);
  } else if (!expectedTaxCredit) {
    warnings.push('No NY tax credit (run outside 2021-2027 program window)');
  } else if (taxCreditExcluded) {
    warnings.push(`Not counting an expected NY tax credit of up to $${(taxCreditExcluded / 1e6).toFixed(1)}M (not cited as received)`);
  }

  // --- Build weekly gross schedule ---
  const weeklySchedule = buildWeeklySchedule(
    show, grossesAllTime, grossesWeekly, previewWeeks, totalRunWeeks, warnings, opts
  );

  if (weeklySchedule.length === 0) {
    return { error: 'No gross data available', warnings: ['No grosses data'] };
  }

  // Shadow only (BRO-4989 checker #3): each week's cost from its own date
  // (dated anchors carried by the Broadway cost index, costForWeek) instead
  // of one current figure for the whole run. Live passes no opts.
  // A record with no cost figure at all keeps the live nut (flat era
  // deflator): a category estimate is never carried back by the index.
  const datedCosts = opts.datedCosts && datedCostsApply(show, commercial, warnings);
  const nutByWeek = datedCosts ? datedWeeklyNuts(show, commercial, category, weeklySchedule) : null;
  if (datedCosts && !nutByWeek) {
    return { error: 'No dated cost for the run', warnings: ['No dated cost for the run'] };
  }

  // --- Run the model (three scenarios) ---
  const results = {};
  for (const [scenario, mult] of Object.entries(SCENARIO_MULTIPLIERS)) {
    let cumProfit = 0;
    let recoupWeek = null;
    let isPostRecoup = false;
    let totalGross = 0;
    let totalProfit = 0;

    // Cap simulation at 520 weeks (10 years) to prevent accumulation errors
    const maxWeeks = Math.min(weeklySchedule.length, 520);

    for (let i = 0; i < maxWeeks; i++) {
      const week = weeklySchedule[i];
      const weekNum = i + 1;

      // Apply tax credit as lump sum
      if (weekNum === taxCreditWeek) {
        cumProfit += taxCreditAmount;
      }

      const weekResult = calcWeeklyProfit(
        week.gross, nutByWeek ? nutByWeek[i] : runNut, baseVarRate, isPostRecoup, weekNum, week.isPreview, mult, weeklySchedule.length, show.type || 'musical', category, costPath
      );

      let weekProfit = weekResult.profit;

      // Star deal: additional cost above standard nut
      if (starDeal) {
        weekProfit -= starDeal.weeklyPremium;
        const grossAboveThreshold = Math.max(0, weekResult.adjGross - starDeal.grossThreshold);
        weekProfit -= grossAboveThreshold * starDeal.grossPct;
      }
      if (sourcedDeals && sourcedDeals.entries.length) weekProfit -= weeklyParticipationCost(sourcedDeals.entries, weekResult.adjGross);

      cumProfit += weekProfit;
      totalGross += weekResult.adjGross;
      totalProfit += weekProfit;

      // Check recoupment threshold
      if (!isPostRecoup && cumProfit >= effectiveCap) {
        isPostRecoup = true;
        recoupWeek = weekNum;
        // Recalculate this week with post-recoup royalties
        // (small correction — the week of recoupment splits pre/post)
      }
    }

    // Apply tax credit at end for closed shows (it's an eventual certainty)
    if (taxCreditWeek === Infinity) {
      cumProfit += taxCreditAmount;
    }

    // Closing costs for shows that closed within 2 years (strike, crew buyouts).
    // Long-running shows budget closing into their final weeks' nut.
    if (isClosed && weeklySchedule.length < 104) {
      const closingCost = CLOSING_COSTS[category] || CLOSING_COSTS.musical;
      cumProfit -= closingCost;
    }

    const recoupmentPct = (cumProfit / capForPct) * 100;

    results[scenario] = {
      cumulativeProfit: Math.round(cumProfit),
      recoupmentPct: Math.round(recoupmentPct * 10) / 10,
      recouped: recoupmentPct >= 100,
      recoupWeek,
      totalGross: Math.round(totalGross),
      totalProfit: Math.round(totalProfit),
      avgWeeklyProfit: weeklySchedule.length > 0 ? Math.round(totalProfit / weeklySchedule.length) : 0,
    };
  }

  // --- Weekly breakeven ---
  // Breakeven: gross × (1 - varRate) - theaterOverage - nut = 0
  // When gross is above theater breakpoint: gross × (1 - varRate - 0.07) + rentInNut = nut
  // → gross = (nut - rentInNut) / (1 - varRate - 0.07)
  // Simplified: gross = nut × (1 - rentPct) / (1 - varRate - theaterPct)
  const breakeven = (runNut * (1 - THEATER_DEAL.rentPctOfNut)) /
    (1 - baseVarRate - THEATER_DEAL.pctOfGross);

  // --- Data quality ---
  const grossDataSource = weeklySchedule[0]?._source || 'unknown';
  // 'high' needs a reported weekly cost that names its source: /biz shows an
  // uncited one as an estimate, so its model is not "High confidence" (BRO-4666).
  let dataQuality = 'low';
  if (isCitedReportedWeeklyCost(commercial)) {
    dataQuality = 'high';
  } else if (!opts.costSourcedOnly && (REPORTED_COST_METHODOLOGIES.has(commercial.costMethodology) || (commercial.weeklyRunningCost && grossesAllTime))) {
    dataQuality = 'medium';
  }

  return {
    slug: show.slug || show.id,
    title: show.title,
    category,

    // Inputs
    capitalization,
    svogGrant,
    taxCreditAmount,
    // The credit actually inside the % (a running show's lands at week TAX_CREDIT_LAG_WEEKS).
    taxCreditApplied: taxCreditWeek === Infinity || Math.min(weeklySchedule.length, 520) >= taxCreditWeek ? taxCreditAmount : 0,
    ...(opts.taxCreditCitedOnly || opts.taxCreditPre ? { taxCreditExcluded } : {}),
    reserveFund: Math.round(reserveFund),
    effectiveCapitalization: Math.round(effectiveCap),
    weeklyFixedCosts: weeklyNut,
    weeklyFixedCostSource: nutSource,
    baseVariableRate: Math.round(baseVarRate * 1000) / 1000,
    previewWeeks,
    totalRunWeeks: weeklySchedule.length,

    // Three scenarios
    optimistic: results.optimistic,
    central: results.central,
    pessimistic: results.pessimistic,

    // Convenience
    recoupmentPctLow: results.pessimistic.recoupmentPct,
    recoupmentPctCentral: results.central.recoupmentPct,
    recoupmentPctHigh: results.optimistic.recoupmentPct,
    modelRecouped: results.central.recouped,

    // Derived
    weeklyBreakeven: Math.round(breakeven),
    weeksToRecoupEstimate: results.central.recoupWeek,

    // Confidence
    dataQuality,
    grossDataSource,
    ...(sourcedDeals ? { starDealUnknown: dealUnknown } : {}),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helper: Build Weekly Gross Schedule
// ---------------------------------------------------------------------------

/**
 * Per-week running cost for the schedule, from each week's date. Weekly-
 * history rows carry their own date; estimated rows before them are dated
 * back from the first one, and an all-estimated schedule runs forward from
 * the first preview (or opening). Null when there is no date to anchor to or
 * no cost figure at all.
 */
function datedWeeklyNuts(show, commercial, category, schedule) {
  // Lazy: cost-for-week requires this module.
  const { costForWeek } = require('./cost-for-week');
  const WEEK_MS = 7 * 86400000;
  const first = schedule.findIndex((w) => w.date);
  let t0;
  if (first >= 0) t0 = Date.parse(schedule[first].date) - first * WEEK_MS;
  else t0 = Date.parse(show.previewsStartDate || show.openingDate || '');
  if (!Number.isFinite(t0)) return null;
  const fallbackCost = estimateWeeklyNut(show, commercial, { eraAdjust: false });
  const nuts = [];
  for (let i = 0; i < schedule.length; i++) {
    const date = schedule[i].date || new Date(t0 + i * WEEK_MS).toISOString().slice(0, 10);
    const c = costForWeek(commercial, date, { show, category, fallbackCost });
    if (!c) return null;
    nuts.push(c.cost);
  }
  return nuts;
}

/** opts.datedCosts applies only to a record with a real cost figure. */
function datedCostsApply(show, commercial, warnings) {
  const { hasCostAnchor } = require('./cost-for-week');
  if (hasCostAnchor(commercial, show)) return true;
  warnings.push('No reported cost anchor (producer, SEC or trade): dated costs off, flat era deflator kept');
  return false;
}

/** Mean dated weekly cost over the played weeks of [open, close), COVID dark excluded. */
function averageDatedNut(show, commercial, category, openDate, closeDate) {
  const { costForWeek } = require('./cost-for-week');
  if (!openDate || !(closeDate > openDate)) return null;
  const WEEK_MS = 7 * 86400000;
  const fallbackCost = estimateWeeklyNut(show, commercial, { eraAdjust: false });
  let sum = 0;
  let n = 0;
  for (let t = openDate.getTime(); t < closeDate.getTime(); t += WEEK_MS) {
    if (t >= COVID_DARK_START.getTime() && t < COVID_DARK_END.getTime()) continue;
    const c = costForWeek(commercial, new Date(t).toISOString().slice(0, 10), { show, category, fallbackCost });
    if (!c) return null;
    sum += c.cost;
    n++;
  }
  return n ? sum / n : null;
}

function buildWeeklySchedule(show, grossesAllTime, grossesWeekly, previewWeeks, totalRunWeeks, warnings, opts = {}) {
  const schedule = [];

  // Check for weekly history data
  const weeklyData = grossesWeekly || {};
  const weekDates = Object.keys(weeklyData).sort();
  const hasWeekly = weekDates.length > 0;

  // Decide: use weekly history if available AND either:
  // (a) covers most of the run (>50%), OR
  // (b) allTime data is contaminated (too many performances from prior productions)
  const weeklyCoverage = hasWeekly ? weekDates.length / Math.max(totalRunWeeks, 1) : 0;
  const expectedPerfs = totalRunWeeks * 8;
  const actualPerfs = grossesAllTime?.performances || 0;
  const isContaminated = actualPerfs > expectedPerfs * 1.3;
  const useWeekly = hasWeekly && (weeklyCoverage > 0.5 || isContaminated);

  if (useWeekly) {
    // Tier 1: Weekly data covers most of the run
    const avgGross = weekDates.reduce((sum, d) => sum + (weeklyData[d]?.gross || 0), 0) / weekDates.length;

    // Weekly grosses start at first preview, so rows before opening already
    // are the previews. Live still estimates all of them on top (counted
    // twice); the shadow option estimates only the uncovered ones (BRO-5002).
    const covers = opts.previewsFromWeekly
      ? previewWeeksFromWeekly(weekDates, show.openingDate, previewWeeks, show.previewsStartDate)
      : { toEstimate: previewWeeks, previewRowDates: new Set() };

    // Add preview weeks (estimated) before the weekly data
    for (let pw = 1; pw <= covers.toEstimate; pw++) {
      const mult = getPreviewGrossMultiplier(pw);
      schedule.push({
        gross: avgGross * mult,
        isPreview: true,
        _source: 'preview-estimate',
      });
    }

    // Estimate weeks before weekly data starts (Tier 2 gap-fill)
    const gapWeeks = Math.max(totalRunWeeks - covers.toEstimate - weekDates.length, 0);
    for (let w = 0; w < gapWeeks; w++) {
      schedule.push({
        gross: avgGross, // Best estimate for pre-history weeks
        isPreview: false,
        _source: 'gap-estimated',
      });
    }

    // Add actual weekly data
    for (const date of weekDates) {
      schedule.push({
        gross: weeklyData[date].gross,
        isPreview: covers.previewRowDates.has(date),
        date,
        _source: 'weekly-history',
      });
    }

    return schedule;
  }

  // Tier 3: allTime data (covers full run, or weekly data is too sparse)
  if (grossesAllTime && grossesAllTime.gross > 0 && grossesAllTime.performances > 0) {
    // Decontaminate: check if performances count matches expected run
    const expectedPerfs = totalRunWeeks * 8;
    const actualPerfs = grossesAllTime.performances;
    const contamRatio = actualPerfs / Math.max(expectedPerfs, 1);

    let cleanGross = grossesAllTime.gross;
    if (contamRatio > 1.3) {
      warnings.push(`Gross decontaminated: ${actualPerfs} perfs vs ${expectedPerfs} expected (${contamRatio.toFixed(1)}x)`);
      cleanGross = grossesAllTime.gross / contamRatio;
    }

    // Distribute evenly across run weeks
    const avgWeeklyGross = cleanGross / Math.max(totalRunWeeks - previewWeeks, 1);

    // Add preview weeks
    for (let pw = 1; pw <= previewWeeks; pw++) {
      const mult = getPreviewGrossMultiplier(pw);
      schedule.push({
        gross: avgWeeklyGross * mult,
        isPreview: true,
        _source: 'alltime-estimated',
      });
    }

    // Add regular weeks
    const regularWeeks = totalRunWeeks - previewWeeks;
    for (let w = 0; w < regularWeeks; w++) {
      schedule.push({
        gross: avgWeeklyGross,
        isPreview: false,
        _source: contamRatio > 1.3 ? 'alltime-decontaminated' : 'alltime-clean',
      });
    }

    return schedule;
  }

  // No gross data at all
  return [];
}

// ---------------------------------------------------------------------------
// Helper: Estimate Weekly Nut
// ---------------------------------------------------------------------------

function estimateWeeklyNut(show, commercial, opts = {}) {
  const category = classifyShow(show);

  const defaults = {
    musicalSpectacle: 1100000,
    musical: 750000,
    playStar: 600000,  // Reduced from 700K — stars add variable cost, not fixed
    play: 425000,      // Reduced from 475K — typical straight play
    special: 300000,
  };

  // Solo/one-person shows have much lower costs than even 'special' defaults
  // (type-special shows kept at 175K to match prior calibration)
  const base = (isSoloShow(show) || show.type === 'special')
    ? 175000
    : (defaults[category] || defaults.musical);

  // Defaults are 2025-anchored and calibrated to each category's typical house;
  // adjust to the show's era and venue size. The lifetime model passes
  // eraAdjust:false — it deflates the current nut to a run-average itself.
  const era = opts.eraAdjust === false ? 1 : eraDeflator(show.openingDate);
  return Math.round(base * era * venueSizeFactor(show, category));
}

// ---------------------------------------------------------------------------
// Helper: Parse SVOG and Tax Credits from Notes
// ---------------------------------------------------------------------------

function parseSvogFromNotes(notes, deepResearch) {
  const text = (notes || '') + ' ' + (deepResearch || '');
  // Look for SVOG/PPP/grant amounts
  const match = text.match(/SVOG[:\s]*\$?([\d.]+)\s*(?:million|M)/i);
  if (match) return parseFloat(match[1]) * 1e6;

  const match2 = text.match(/(?:shuttered|venue|grant)[:\s]*\$?([\d,.]+)/i);
  if (match2) {
    const val = parseFloat(match2[1].replace(/,/g, ''));
    return val > 1000 ? val : val * 1e6;
  }

  return 0;
}

/**
 * Notes that say the show did NOT get the NY theater tax credit. Checked
 * before any amount is parsed, so "did NOT receive NY tax credit" (All Out)
 * yields 0 instead of falling through to the default $3M credit.
 */
const NO_TAX_CREDIT_RE = new RegExp([
  // "did NOT receive NY tax credit", "never qualified for the tax credit", "not eligible for the state tax credit"
  // The gap may not cross a sentence end or a "but" ("did not get SVOG but got a tax credit").
  String.raw`\b(?:did\s+not|didn['’]t|never|not|no\s+longer)\s+(?:receive|receiv\w*|get|got|qualif\w*\s+for|eligible\s+for|apply\s+for|applied\s+for)\b(?:(?!\bbut\b)[^.;]){0,40}?\btax\s*credit`,
  // "No NY tax credit", "no New York State theatre tax credit"
  String.raw`\bno\s+(?:NY\s+|NYS\s+|New\s+York\s+)?(?:state\s+)?(?:theat(?:er|re)\s+)?(?:production\s+)?tax\s*credit`,
  // "ineligible for the NY tax credit"
  String.raw`\bineligible\s+for\b(?:(?!\bbut\b)[^.;]){0,40}?\btax\s*credit`,
  // "tax credit was not received", "tax credit was never granted"
  String.raw`\btax\s*credit\b[^.]{0,30}?\b(?:was|were|is)\s+(?:not|never)\s+(?:received|granted|awarded|approved)`,
].join('|'), 'i');

const NO_TAX_CREDIT_FROM_NOTES_WARNING = 'No NY tax credit (notes say it was not received)';

/**
 * Tax credit stated in the show's notes.
 * Returns 0 when the notes say the credit was not received, a positive
 * dollar amount when one is stated, and null otherwise (the caller then uses
 * the default program-window calculation). Never returns NaN.
 */
function parseTaxCreditFromNotes(notes) {
  const text = notes || '';
  if (NO_TAX_CREDIT_RE.test(text)) return 0;

  const usable = (n) => (Number.isFinite(n) && n > 0 ? n : null);

  const match = text.match(/tax\s*credit[:\s]*\$?([\d.]+)\s*(?:million|M)/i);
  if (match) {
    const parsed = usable(parseFloat(match[1]) * 1e6);
    if (parsed !== null) return parsed;
  }

  const match2 = text.match(/(?:tax credit|credit)[:\s]*\$?([\d,.]+)/i);
  if (match2) {
    const val = parseFloat(match2[1].replace(/,/g, ''));
    if (!Number.isFinite(val) || val <= 0) return null; // e.g. "tax credit." captured just "."
    if (val > 100000) return val; // Already in dollars
    if (val > 100) return val * 1000; // In thousands
    return val * 1e6; // In millions
  }

  return null; // Will use default calculation
}

// ---------------------------------------------------------------------------
// Simplified Lifetime Model (Tier 2: shows running 10+ years)
// ---------------------------------------------------------------------------

/**
 * For ultra-long-running shows, the weekly simulation breaks down because:
 * - Weekly nut reflects current costs, not historical
 * - Cost phases and marketing surcharges accumulate errors over decades
 * - The 10-year cap truncates most of the run
 *
 * Instead: use total lifetime gross with a blended cost ratio.
 * Formula: operatingProfit = totalGross × (1 - totalCostRate) - (weeklyNut × totalWeeks)
 * Where totalCostRate includes variable costs + theater overage as a % of gross.
 *
 * The blended weekly nut is deflated to a run-average (current nut reflects end-of-run costs).
 */
function calculateLifetimeRecoupment(show, commercial, grossesAllTime, opts = {}) {
  opts = withMusicalDefaults(show, opts);
  const warnings = ['Simplified lifetime model (10+ year run)'];
  if (isConvertedToCommercial(commercial)) return { error: SPLIT_RUN_ERROR, warnings: [SPLIT_RUN_ERROR] };

  const capitalization = commercial.capitalization;
  if (!capitalization || !grossesAllTime?.gross) {
    return { error: 'Missing cap or gross data', warnings };
  }

  const slug = show.slug || show.id;
  const category = classifyShow(show);
  // opts.sourcedStarDeals (shadow, BRO-5029): the lifetime tier never charged
  // star deals; it only carries the held flag, and says when a sourced deal
  // goes uncharged.
  const lifetimeDeals = opts.sourcedStarDeals ? sourcedGrossParticipation(commercial) : null;
  if (lifetimeDeals && lifetimeDeals.entries.length) warnings.push('Star deal: sourced grossParticipation not charged on the lifetime tier');
  const basisNut = opts.costBasis && commercial.weeklyRunningCost ? fixedNutFromBasis(commercial, commercial.weeklyRunningCost, getBaseVariableRate(category), THEATER_DEAL) : null; // shadow, BRO-5093
  const weeklyNut = basisNut ? basisNut.nut : commercial.weeklyRunningCost || estimateWeeklyNut(show, commercial, { eraAdjust: false });
  const split = opts.costSplit && !basisNut ? splitCosts(commercial, category, weeklyNut, getBaseVariableRate(category), THEATER_DEAL.pctOfGross) : null; // shadow, BRO-5073
  const baseVarRate = split ? split.varRate : getBaseVariableRate(category);
  const runNut = split ? split.fixedNut : weeklyNut;

  // Effective capitalization
  const svogGrant = opts.svogCredit ? (KNOWN_SVOG[slug] || parseSvogFromNotes(commercial.notes) || 0) : 0; // see calculateRecoupment (BRO-5073)
  const reserveFund = weeklyNut * 1.5; // Minimal for established long-runners
  const effectiveCap = Math.max(capitalization - svogGrant + reserveFund, reserveFund);
  // Same semantics as the weekly model: closed shows measure against cap net
  // of SVOG (no reserve); still-running long-runners keep the reserve.
  const isClosedRun = show.closingDate && new Date(show.closingDate) < new Date();
  const capForPct = isClosedRun
    ? Math.max(capitalization - svogGrant, weeklyNut)
    : effectiveCap;

  // NY tax credit only for shows whose run overlaps the 2021-2027 program
  // (long-runners still open in Aug 2021 qualified via the reopening provision).
  // Same helper as the weekly model (BRO-5517); a long-runner is past the
  // qualifying weeks, so they all count.
  const closedBeforeCreditProgram = show.closingDate &&
    new Date(show.closingDate) < TAX_CREDIT_PROGRAM_START;
  // BRO-4623: an explicit "did not receive the tax credit" in the notes wins.
  const notesCredit = parseTaxCreditFromNotes(commercial.notes);
  if (notesCredit === 0) warnings.push(NO_TAX_CREDIT_FROM_NOTES_WARNING);
  const credit = nyTaxCredit({
    slug, notesCredit, eligible: !closedBeforeCreditProgram, capitalization,
    qualifyingRunningCosts: weeklyNut * QUALIFYING_WEEKS,
  });
  const expectedTaxCredit = credit.amount;
  // Shadow (BRO-4989): same running-only, cited-only rule as the weekly model.
  const taxCreditExcluded = opts.taxCreditPre || (opts.taxCreditCitedOnly && !isClosedRun && !credit.received && !taxCreditCited(commercial).cited) ? expectedTaxCredit : 0;
  const taxCredit = expectedTaxCredit - taxCreditExcluded;

  // Run duration
  const openDate = show.openingDate ? new Date(show.openingDate) : null;
  let closeDate = show.closingDate ? new Date(show.closingDate) : new Date();
  // Shadow only (BRO-5003): the all-time gross is to date, so an announced
  // future closing must not add unplayed weeks of cost. Live keeps it.
  if (opts.playedWeeksOnly && closeDate > new Date()) closeDate = new Date();
  let totalWeeks = openDate ? Math.round((closeDate - openDate) / (7 * 86400000)) : 0;

  // Subtract COVID dark weeks
  if (openDate && openDate < COVID_DARK_END && closeDate > COVID_DARK_START) {
    const darkStart = openDate < COVID_DARK_START ? COVID_DARK_START : openDate;
    const darkEnd = closeDate > COVID_DARK_END ? COVID_DARK_END : closeDate;
    totalWeeks -= Math.max(0, Math.round((darkEnd - darkStart) / (7 * 86400000)));
  }

  const totalGross = grossesAllTime.gross;

  // Theater overage as % of gross (simplified: flat rate since we don't have weekly data)
  const theaterOverageRate = Math.max(0, THEATER_DEAL.pctOfGross - THEATER_DEAL.rentPctOfNut * runNut / (totalGross / totalWeeks));

  // Total variable cost rate (pre-recoup rate for most of the run is wrong —
  // long-runners recoup early, so most weeks are post-recoup with lower author royalties)
  const authorRate = AUTHOR_ROYALTY_PRE[show.type] || AUTHOR_ROYALTY_PRE.musical;
  const postRecoupVarRate = baseVarRate - authorRate; // Authors in royalty pool
  // Assume recoup at ~week 50, so ~95% of weeks are post-recoup
  const blendedVarRate = postRecoupVarRate * 0.95 + baseVarRate * 0.05;

  // Blended cost ratio: variable + theater overage
  const totalCostRate = blendedVarRate + theaterOverageRate;

  // Average weekly nut over the run — deflate current nut by 2%/year for historical average
  const runYears = totalWeeks / 52;
  const avgNutDeflator = runYears > 3 ? (1 - Math.pow(0.98, runYears)) / (runYears * 0.02) : 1;
  let avgWeeklyNut = runNut * avgNutDeflator * 0.88; // 0.88 = phase 4 mature run
  // Shadow only (BRO-4989 checker #3): the run's average of each week's
  // dated cost (costForWeek) replaces the flat 2%/year deflator.
  if (opts.datedCosts && datedCostsApply(show, commercial, warnings)) {
    const avg = averageDatedNut(show, commercial, category, openDate, closeDate);
    if (avg == null) return { error: 'No dated cost for the run', warnings: ['No dated cost for the run'] };
    avgWeeklyNut = avg * 0.88;
  }

  // Post-recoup royalty pool: 35% of operating profit after recoupment
  // Since most of the run is post-recoup, apply pool to ~90% of profit
  const grossAfterVariable = totalGross * (1 - totalCostRate);
  const totalFixedCosts = avgWeeklyNut * totalWeeks;
  const rawOperatingProfit = grossAfterVariable - totalFixedCosts;
  const royaltyPoolDrag = Math.max(0, rawOperatingProfit * 0.90) * ROYALTY_POOL_POST_RECOUP;
  const operatingProfit = rawOperatingProfit - royaltyPoolDrag + taxCredit;

  // Three scenarios
  const scenarios = {};
  for (const [name, mult] of Object.entries(SCENARIO_MULTIPLIERS)) {
    const adjGross = totalGross * mult.grossAdj;
    const adjVarCosts = adjGross * totalCostRate * mult.variableCost;
    const adjFixedCosts = avgWeeklyNut * totalWeeks * mult.fixedCost;
    const adjRawProfit = adjGross - adjVarCosts - adjFixedCosts;
    const adjRoyalty = Math.max(0, adjRawProfit * 0.90) * ROYALTY_POOL_POST_RECOUP;
    const adjProfit = adjRawProfit - adjRoyalty + taxCredit;
    const pct = (adjProfit / capForPct) * 100;

    scenarios[name] = {
      cumulativeProfit: Math.round(adjProfit),
      recoupmentPct: Math.round(pct * 10) / 10,
      recouped: pct >= 100,
      recoupWeek: pct >= 100 ? Math.round(effectiveCap / (adjProfit / totalWeeks)) : null,
      totalGross: Math.round(adjGross),
      totalProfit: Math.round(adjProfit),
      avgWeeklyProfit: totalWeeks > 0 ? Math.round(adjProfit / totalWeeks) : 0,
    };
  }

  return {
    slug,
    title: show.title,
    category,
    capitalization,
    svogGrant,
    taxCreditAmount: taxCredit,
    taxCreditApplied: taxCredit,
    ...(opts.taxCreditCitedOnly || opts.taxCreditPre ? { taxCreditExcluded } : {}),
    reserveFund: Math.round(reserveFund),
    effectiveCapitalization: Math.round(effectiveCap),
    weeklyFixedCosts: weeklyNut,
    weeklyFixedCostSource: commercial.weeklyRunningCost ? 'reported' : 'estimated',
    baseVariableRate: Math.round(blendedVarRate * 1000) / 1000,
    previewWeeks: 0,
    totalRunWeeks: totalWeeks,
    optimistic: scenarios.optimistic,
    central: scenarios.central,
    pessimistic: scenarios.pessimistic,
    recoupmentPctLow: scenarios.pessimistic.recoupmentPct,
    recoupmentPctCentral: scenarios.central.recoupmentPct,
    recoupmentPctHigh: scenarios.optimistic.recoupmentPct,
    modelRecouped: scenarios.central.recouped,
    weeklyBreakeven: Math.round(weeklyNut / (1 - totalCostRate)),
    weeksToRecoupEstimate: scenarios.central.recoupWeek,
    dataQuality: commercial.weeklyRunningCost ? 'medium' : 'low',
    grossDataSource: 'alltime-lifetime',
    ...(lifetimeDeals ? { starDealUnknown: starDealUnknown({ starDriven: category === 'playStar' || !!KNOWN_STAR_DEALS[slug], entries: lifetimeDeals.entries }) } : {}),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  MUSICAL_LIVE_OPTS,
  calculateRecoupment,
  calculateLifetimeRecoupment,
  SPLIT_RUN_ERROR,
  buildWeeklySchedule,
  classifyShow,
  getBaseVariableRate,
  calcWeeklyProfit,
  calcTheaterOverage,
  estimateWeeklyNut,
  isSoloShow,
  eraDeflator,
  venueSizeFactor,
  SCENARIO_MULTIPLIERS,
  PREVIEW_DEFAULTS,
  COST_COMPONENTS,
  RESERVE_FUND_WEEKS,
  costPathFactor, extraVariableCost,
  TAX_CREDIT_PROGRAM_START,
  TAX_CREDIT_PROGRAM_END,
  TAX_CREDIT_MAX,
  // Exported for the shadow investor-return model (BRO-4989); values unchanged.
  THEATER_DEAL,
  AUTHOR_ROYALTY_PRE,
  ROYALTY_POOL_POST_RECOUP,
  MARKETING_SURCHARGES,
  KNOWN_STAR_DEALS,
  CLOSING_COSTS,
  TAX_CREDIT_LAG_WEEKS,
  TAX_CREDIT_RATE,
  COVID_DARK_START,
  COVID_DARK_END,
  getPreviewGrossMultiplier,
  getTheaterSeats,
  // Exported for tests (BRO-4623)
  KNOWN_SVOG,
  KNOWN_STAR_DEALS,
  parseSvogFromNotes,
  parseTaxCreditFromNotes,
  NO_TAX_CREDIT_FROM_NOTES_WARNING,
};
