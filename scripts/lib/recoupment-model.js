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

/** Tax credit lag in weeks from opening date */
const TAX_CREDIT_LAG_WEEKS = 78; // ~18 months

/**
 * NYC Musical and Theatrical Production Tax Credit (enacted 2021, allocations
 * through 2027): 25% of qualified production + operating costs, capped at $3M
 * per production. Shows running at any point from Aug 2021 qualify, including
 * COVID reopenings — NOT just shows that opened after 2021.
 */
const TAX_CREDIT_PROGRAM_START = new Date('2021-08-01');
const TAX_CREDIT_PROGRAM_END = new Date('2027-12-31');
const TAX_CREDIT_MAX = 3000000;
const TAX_CREDIT_RATE = 0.25;

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

/** COVID shutdown: all Broadway dark from March 12, 2020 to September 14, 2021 */
const COVID_DARK_START = new Date('2020-03-12');
const COVID_DARK_END = new Date('2021-09-14');
const COVID_DARK_WEEKS = 78;

/** Known SVOG grants (max $10M per show) */
const KNOWN_SVOG = {
  'hamilton': 10000000,
  'book-of-mormon': 10000000,
  'hadestown': 10000000,
  'mj': 10000000,
  'six': 10000000,
  'moulin-rouge': 9900000,
  'aint-too-proud-2019': 10000000,
  'wicked': 10000000,
  'the-lion-king': 10000000,
  'chicago': 10000000,
  'aladdin': 10000000,
  'dear-evan-hansen-2016': 10000000,
  'come-from-away-2017': 10000000,
  'mean-girls': 10000000,
  'harry-potter': 10000000,
  'frozen-2018': 10000000,
  'jagged-little-pill': 10000000,
  'tina': 10000000,
};

/** Known star deals — weekly premium + % of gross above threshold */
const KNOWN_STAR_DEALS = {
  'the-music-man-2022': { weeklyPremium: 350000, grossPct: 0.08, grossThreshold: 1200000 }, // Jackman ($150K+/wk + 10% of gross) + Foster + elaborate production
  'hells-kitchen': { weeklyPremium: 75000, grossPct: 0.03, grossThreshold: 1000000 }, // Alicia Keys creator deal
  'gypsy-2024': { weeklyPremium: 100000, grossPct: 0.02, grossThreshold: 1200000 }, // Audra McDonald
};

/** Default star premium for star-driven shows without specific deal data */
const DEFAULT_STAR_PREMIUM = {
  weeklyPremium: 75000,    // Additional fixed weekly cost
  grossPct: 0.02,          // Additional % of gross
  grossThreshold: 1000000, // Only on gross above this
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
 * @returns {{ profit: number, variableCosts: number, theaterCost: number, fixedCosts: number }}
 */
function calcWeeklyProfit(weeklyGross, weeklyNut, baseVarRate, isPostRecoup, weekNumber, isPreview, scenarioMult, totalWeeks, showType, showCategory) {
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
  if (weekNumber > 104) {
    fixedCosts *= 0.88; // Mature run cap — no further reduction
  } else if (weekNumber > 52) {
    fixedCosts *= 0.93;
  }
  // No additional deflation for long runs — Broadway costs inflate over time.
  // The 0.88 floor already captures cast replacement savings and optimization.

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
  let operatingProfit = adjGross - variableCosts - theaterCost - fixedCosts;

  // Post-recoupment: royalty pool takes 35% of operating profit
  if (isPostRecoup && operatingProfit > 0) {
    const royaltyPool = operatingProfit * ROYALTY_POOL_POST_RECOUP;
    operatingProfit -= royaltyPool;
  }

  return {
    profit: operatingProfit,
    variableCosts,
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
 * @returns {object} RecoupmentModelResult
 */
function calculateRecoupment(show, commercial, grossesAllTime, grossesWeekly) {
  const warnings = [];

  // --- Inputs ---
  const capitalization = commercial.capitalization;
  if (!capitalization) {
    return { error: 'No capitalization data', warnings: ['Missing capitalization'] };
  }

  const weeklyNut = commercial.weeklyRunningCost || estimateWeeklyNut(show, commercial);
  const nutSource = commercial.weeklyRunningCost ? 'reported' : 'estimated';
  if (nutSource === 'estimated') {
    warnings.push('Weekly running cost estimated from show type');
  }

  const category = classifyShow(show);
  const baseVarRate = getBaseVariableRate(category);

  // --- Star deal ---
  const slug = show.slug || show.id;
  // Star deals: only apply for KNOWN deals, not as a default.
  // Most plays don't have above-scale star compensation — applying a default
  // causes false negatives for shows that actually recouped.
  const starDeal = KNOWN_STAR_DEALS[slug] || null;
  if (starDeal) {
    warnings.push(`Star deal: +$${(starDeal.weeklyPremium/1000).toFixed(0)}K/wk + ${(starDeal.grossPct*100).toFixed(0)}% above $${(starDeal.grossThreshold/1e6).toFixed(1)}M`);
  }

  // --- Effective capitalization ---
  const svogGrant = KNOWN_SVOG[slug] || parseSvogFromNotes(commercial.notes) || 0;

  // NY theater tax credit: eligible if the show's run overlaps the program
  // window (Aug 2021 – 2027), which includes COVID reopenings of older shows.
  // Credit = 25% of qualified production + operating costs (first year),
  // capped at $3M — Broadway-scale shows nearly always hit the cap.
  const notesCredit = parseTaxCreditFromNotes(commercial.notes);
  const runEndForCredit = show.closingDate ? new Date(show.closingDate) : new Date();
  const runStartForCredit = show.openingDate ? new Date(show.openingDate) : null;
  // Undated shows can't prove eligibility — no credit rather than a $3M gift
  const eligibleForTaxCredit = !!runStartForCredit &&
    runEndForCredit >= TAX_CREDIT_PROGRAM_START &&
    runStartForCredit <= TAX_CREDIT_PROGRAM_END;

  // Reserve fund: scaled by run length. Long-running shows need full reserve;
  // limited runs (< 6 months) need less because producers budget to the close date.
  const isLimitedRun = show.closingDate && show.openingDate &&
    (new Date(show.closingDate) - new Date(show.openingDate)) < 200 * 86400000;
  const reserveWeeks = isLimitedRun ? 1.5 : RESERVE_FUND_WEEKS;
  const reserveFund = weeklyNut * reserveWeeks;
  // Effective cap can't go below zero (SVOG can't make cap negative)
  const effectiveCap = Math.max(capitalization - svogGrant + reserveFund, reserveFund);
  // Tax credit timing: for closed shows, apply at closing (credit is eventual certainty).
  // For running shows, lag 18 months from opening.
  const isClosed = show.closingDate && new Date(show.closingDate) < new Date();
  const taxCreditWeek = isClosed ? Infinity : TAX_CREDIT_LAG_WEEKS; // Infinity = applied at end

  // The reserve delays WHEN recoupment is declared (recoup-week threshold) but
  // is returned to the treasury, not spent. For CLOSED shows the ledger is
  // final: recoupment means the cap itself was repaid, so the percentage is
  // measured against cap net of SVOG without the reserve. Running shows keep
  // the reserve in the denominator (conservative until the run is final).
  const capForPct = isClosed
    ? Math.max(capitalization - svogGrant, weeklyNut)
    : effectiveCap;

  // --- Gross data ---
  const openingDate = show.openingDate ? new Date(show.openingDate) : null;
  const closingDate = show.closingDate ? new Date(show.closingDate) : null;
  const previewsStart = show.previewsStartDate ? new Date(show.previewsStartDate) : null;
  const isStillRunning = !closingDate || closingDate > new Date();

  // Calculate preview weeks (cap at 8 — anything longer is COVID gap or data error)
  let previewWeeks = 0;
  if (previewsStart && openingDate) {
    let rawPreviewWeeks = Math.round((openingDate - previewsStart) / (7 * 86400000));
    // If preview period spans COVID shutdown, subtract dark weeks
    if (previewsStart < COVID_DARK_END && openingDate > COVID_DARK_START) {
      const darkStart = previewsStart < COVID_DARK_START ? COVID_DARK_START : previewsStart;
      const darkEnd = openingDate > COVID_DARK_END ? COVID_DARK_END : openingDate;
      rawPreviewWeeks -= Math.max(0, Math.round((darkEnd - darkStart) / (7 * 86400000)));
    }
    previewWeeks = Math.min(Math.max(rawPreviewWeeks, 0), 8);
  }

  // Calculate total run weeks (from previews start or opening), excluding COVID dark period
  const runStart = previewsStart || openingDate;
  const runEnd = closingDate || new Date();
  let totalRunWeeks = runStart ? Math.round((runEnd - runStart) / (7 * 86400000)) : 0;

  // Subtract COVID dark weeks if the show's run spans the shutdown
  if (runStart && runStart < COVID_DARK_END && (!closingDate || closingDate > COVID_DARK_START)) {
    const darkStart = runStart < COVID_DARK_START ? COVID_DARK_START : runStart;
    const darkEnd = (!closingDate || closingDate > COVID_DARK_END) ? COVID_DARK_END : closingDate;
    const darkWeeks = Math.round((darkEnd - darkStart) / (7 * 86400000));
    totalRunWeeks -= darkWeeks;
    if (darkWeeks > 0) warnings.push(`Excluded ${darkWeeks} COVID dark weeks`);
  }

  // Tax credit amount (needs run length): 25% of cap + first-year running costs
  const taxCreditAmount = notesCredit
    ? notesCredit
    : (eligibleForTaxCredit
        ? Math.min(TAX_CREDIT_RATE * (capitalization + weeklyNut * Math.min(Math.max(totalRunWeeks, 0), 52)), TAX_CREDIT_MAX)
        : 0);
  if (!taxCreditAmount) {
    warnings.push('No NY tax credit (run outside 2021-2027 program window)');
  }

  // --- Build weekly gross schedule ---
  const weeklySchedule = buildWeeklySchedule(
    show, grossesAllTime, grossesWeekly, previewWeeks, totalRunWeeks, warnings
  );

  if (weeklySchedule.length === 0) {
    return { error: 'No gross data available', warnings: ['No grosses data'] };
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
        week.gross, weeklyNut, baseVarRate, isPostRecoup, weekNum, week.isPreview, mult, weeklySchedule.length, show.type || 'musical', category
      );

      let weekProfit = weekResult.profit;

      // Star deal: additional cost above standard nut
      if (starDeal) {
        weekProfit -= starDeal.weeklyPremium;
        const grossAboveThreshold = Math.max(0, weekResult.adjGross - starDeal.grossThreshold);
        weekProfit -= grossAboveThreshold * starDeal.grossPct;
      }

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
  const breakeven = (weeklyNut * (1 - THEATER_DEAL.rentPctOfNut)) /
    (1 - baseVarRate - THEATER_DEAL.pctOfGross);

  // --- Data quality ---
  const grossDataSource = weeklySchedule[0]?._source || 'unknown';
  let dataQuality = 'low';
  if (commercial.costMethodology === 'sec-filing' || commercial.costMethodology === 'trade-reported') {
    dataQuality = 'high';
  } else if (commercial.weeklyRunningCost && grossesAllTime) {
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
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helper: Build Weekly Gross Schedule
// ---------------------------------------------------------------------------

function buildWeeklySchedule(show, grossesAllTime, grossesWeekly, previewWeeks, totalRunWeeks, warnings) {
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

    // Add preview weeks (estimated) before the weekly data
    for (let pw = 1; pw <= previewWeeks; pw++) {
      const mult = getPreviewGrossMultiplier(pw);
      schedule.push({
        gross: avgGross * mult,
        isPreview: true,
        _source: 'preview-estimate',
      });
    }

    // Estimate weeks before weekly data starts (Tier 2 gap-fill)
    const gapWeeks = Math.max(totalRunWeeks - previewWeeks - weekDates.length, 0);
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
        isPreview: false,
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

function parseTaxCreditFromNotes(notes) {
  const text = notes || '';
  const match = text.match(/tax\s*credit[:\s]*\$?([\d.]+)\s*(?:million|M)/i);
  if (match) return parseFloat(match[1]) * 1e6;

  const match2 = text.match(/(?:tax credit|credit)[:\s]*\$?([\d,.]+)/i);
  if (match2) {
    const val = parseFloat(match2[1].replace(/,/g, ''));
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
function calculateLifetimeRecoupment(show, commercial, grossesAllTime) {
  const warnings = ['Simplified lifetime model (10+ year run)'];

  const capitalization = commercial.capitalization;
  if (!capitalization || !grossesAllTime?.gross) {
    return { error: 'Missing cap or gross data', warnings };
  }

  const slug = show.slug || show.id;
  const category = classifyShow(show);
  const baseVarRate = getBaseVariableRate(category);
  const weeklyNut = commercial.weeklyRunningCost || estimateWeeklyNut(show, commercial, { eraAdjust: false });

  // Effective capitalization
  const svogGrant = KNOWN_SVOG[slug] || parseSvogFromNotes(commercial.notes) || 0;
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
  // Same formula as the weekly model: 25% of cap + first-year running costs.
  const closedBeforeCreditProgram = show.closingDate &&
    new Date(show.closingDate) < TAX_CREDIT_PROGRAM_START;
  const taxCredit = closedBeforeCreditProgram
    ? 0
    : Math.min(TAX_CREDIT_RATE * (capitalization + weeklyNut * 52), TAX_CREDIT_MAX);

  // Run duration
  const openDate = show.openingDate ? new Date(show.openingDate) : null;
  const closeDate = show.closingDate ? new Date(show.closingDate) : new Date();
  let totalWeeks = openDate ? Math.round((closeDate - openDate) / (7 * 86400000)) : 0;

  // Subtract COVID dark weeks
  if (openDate && openDate < COVID_DARK_END && closeDate > COVID_DARK_START) {
    const darkStart = openDate < COVID_DARK_START ? COVID_DARK_START : openDate;
    const darkEnd = closeDate > COVID_DARK_END ? COVID_DARK_END : closeDate;
    totalWeeks -= Math.max(0, Math.round((darkEnd - darkStart) / (7 * 86400000)));
  }

  const totalGross = grossesAllTime.gross;

  // Theater overage as % of gross (simplified: flat rate since we don't have weekly data)
  const theaterOverageRate = Math.max(0, THEATER_DEAL.pctOfGross - THEATER_DEAL.rentPctOfNut * weeklyNut / (totalGross / totalWeeks));

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
  const avgWeeklyNut = weeklyNut * avgNutDeflator * 0.88; // 0.88 = phase 4 mature run

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
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  calculateRecoupment,
  calculateLifetimeRecoupment,
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
  TAX_CREDIT_PROGRAM_START,
  TAX_CREDIT_PROGRAM_END,
  TAX_CREDIT_MAX,
};
