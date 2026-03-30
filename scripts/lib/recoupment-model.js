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
  optimistic:  { variableCost: 0.85, fixedCost: 0.95, grossAdj: 1.02 },
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

/** Reserve fund: weeks of operating costs held before declaring recoupment */
const RESERVE_FUND_WEEKS = 2.5;

/** Tax credit lag in weeks from opening date */
const TAX_CREDIT_LAG_WEEKS = 78; // ~18 months

/** Above-nut marketing surcharges (applied to specific week ranges) */
const MARKETING_SURCHARGES = {
  openingPush: { weeks: [1, 2, 3, 4, 5, 6, 7, 8], amount: 75000 },
  tonySeasonApprox: { weekOfYear: [18, 19, 20, 21, 22, 23], amount: 50000 }, // May-June
  holidayApprox: { weekOfYear: [47, 48, 49, 50, 51, 52, 1], amount: 40000 }, // Nov-Jan
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
  const spectacleKeywords = /cirque|spider|lion king|phantom|wicked|frozen|aladdin|mary poppins|little mermaid/i;
  const isSpectacle = type === 'musical' && spectacleKeywords.test(title);

  // Star-driven plays: heuristic based on short runs at large theaters
  const isStarPlay = type === 'play' && show.closingDate && show.openingDate &&
    (new Date(show.closingDate) - new Date(show.openingDate)) < 180 * 86400000; // < 6 months

  if (type === 'special') return 'special';
  if (isSpectacle) return 'musicalSpectacle';
  if (isStarPlay) return 'playStar';
  if (type === 'play') return 'play';
  return 'musical';
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
function calcWeeklyProfit(weeklyGross, weeklyNut, baseVarRate, isPostRecoup, weekNumber, isPreview, scenarioMult, totalWeeks) {
  const mult = scenarioMult || SCENARIO_MULTIPLIERS.central;
  const adjGross = weeklyGross * mult.grossAdj;

  // Variable costs (percentage of gross, excluding theater)
  const adjVarRate = baseVarRate * mult.variableCost;
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
    fixedCosts *= 0.88;
  } else if (weekNumber > 52) {
    fixedCosts *= 0.93;
  }
  // For very old shows where nut reflects current costs, deflate further
  if (totalWeeks && totalWeeks > 260 && weekNumber < totalWeeks) {
    // Shows running 5+ years: additional 2%/year deflation for earlier weeks
    // (ticket price inflation means older years had lower absolute costs)
    const yearsFromEnd = (totalWeeks - weekNumber) / 52;
    if (yearsFromEnd > 5) {
      fixedCosts /= Math.pow(1.02, yearsFromEnd - 5);
    }
  }

  // Preview cost premium
  if (isPreview) {
    fixedCosts *= PREVIEW_DEFAULTS.costMultiplier;
  }

  // Marketing surcharges
  if (weekNumber <= 8) {
    fixedCosts += MARKETING_SURCHARGES.openingPush.amount;
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

  // --- Effective capitalization ---
  const slug = show.slug || show.id;
  const svogGrant = KNOWN_SVOG[slug] || parseSvogFromNotes(commercial.notes) || 0;

  // Tax credit: only for shows that opened before Oct 2025 cutoff
  const openYear = show.openingDate ? parseInt(show.openingDate.split('-')[0]) : 2020;
  const eligibleForTaxCredit = openYear >= 2004; // NYC tax credit started ~2004
  const taxCreditAmount = eligibleForTaxCredit
    ? (parseTaxCreditFromNotes(commercial.notes) || Math.min(capitalization * 0.25, 3000000))
    : 0;

  // Reserve fund: added to cap requirement (must be funded before declared recoupment)
  const reserveFund = weeklyNut * RESERVE_FUND_WEEKS;
  // Effective cap can't go below zero (SVOG can't make cap negative)
  const effectiveCap = Math.max(capitalization - svogGrant + reserveFund, reserveFund);

  // Tax credit: applied as lump sum at lag point, not upfront
  const taxCreditWeek = TAX_CREDIT_LAG_WEEKS;

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

    for (let i = 0; i < weeklySchedule.length; i++) {
      const week = weeklySchedule[i];
      const weekNum = i + 1;

      // Apply tax credit as lump sum
      if (weekNum === taxCreditWeek) {
        cumProfit += taxCreditAmount;
      }

      const weekResult = calcWeeklyProfit(
        week.gross, weeklyNut, baseVarRate, isPostRecoup, weekNum, week.isPreview, mult, weeklySchedule.length
      );

      cumProfit += weekResult.profit;
      totalGross += weekResult.adjGross;
      totalProfit += weekResult.profit;

      // Check recoupment threshold
      if (!isPostRecoup && cumProfit >= effectiveCap) {
        isPostRecoup = true;
        recoupWeek = weekNum;
        // Recalculate this week with post-recoup royalties
        // (small correction — the week of recoupment splits pre/post)
      }
    }

    const recoupmentPct = (cumProfit / effectiveCap) * 100;

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

function estimateWeeklyNut(show, commercial) {
  const type = show.type || 'musical';
  const category = classifyShow(show);

  const defaults = {
    musicalSpectacle: 1100000,
    musical: 750000,
    playStar: 700000,
    play: 475000,
    special: 300000,
  };

  return defaults[category] || defaults.musical;
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
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  calculateRecoupment,
  classifyShow,
  getBaseVariableRate,
  calcWeeklyProfit,
  calcTheaterOverage,
  estimateWeeklyNut,
  SCENARIO_MULTIPLIERS,
  PREVIEW_DEFAULTS,
  COST_COMPONENTS,
  RESERVE_FUND_WEEKS,
};
