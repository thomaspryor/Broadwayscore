/**
 * Per-record validation rules for data/commercial.json: the single copy.
 *
 * Moved out of validate-data.js's validateCommercialJson() (BRO-4623) so the
 * human-approved plan runner (execute-approved-fix.js) refuses a plan with the
 * SAME rules the site build enforces. Before this, the runner had a partial
 * hand-copy, so a plan could pass the runner, push the private data repo, and
 * only then fail test.yml. Add new commercial rules HERE, never inline.
 *
 * Pure: no I/O. Each function returns an array of message strings ([] = ok).
 */

const VALID_COST_METHODOLOGIES = [
  'reddit-standard',
  'trade-reported',
  'sec-filing',
  'producer-confirmed',
  'deep-research',
  'industry-estimate'
];

const VALID_PRODUCTION_TYPES = ['original', 'tour-stop', 'return-engagement', 'international-transfer', 'International Transfer', 'enhancement'];
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

// Fields /biz renders verbatim. weeklyRunningCostSource is not here: its
// figures are estimates and the UI filters that line at render time.
const PUBLIC_TEXT_FIELDS = ['notes', 'capitalizationSource', 'recoupedSource'];
// Research-pipeline wording that reached the public page (BRO-4623): "SEC
// filings (GPT Deep Research)", "Trade press / deep research synthesis",
// "Auto-enrolled stub; awaiting model + curation", "Auto-designated ...".
const INTERNAL_TEXT_RE = /\bGPT\b|\bdeep[ -]research\b|\bDR Batch\b|\bauto-(?:enrolled|designated)\b|\bawaiting model\b|\bresearch synthesis\b|\bLLM\b/i;

/**
 * @param {string} showId - the commercial.json key (a shows.json slug)
 * @param {object} show - the commercial record
 * @param {{ showRecord?: object, allRecords?: object }} ctx -
 *   showRecord: the shows.json entry whose slug is showId (venue checks are
 *   skipped without it); allRecords: the whole commercial.json `shows` map.
 */
function commercialRecordErrors(showId, show, ctx = {}) {
  const out = [];
  const validProductionTypes = VALID_PRODUCTION_TYPES;

  // Validate productionType
  if (show.productionType !== undefined) {
    if (!validProductionTypes.includes(show.productionType)) {
      out.push(`commercial.json: "${showId}" has invalid productionType: "${show.productionType}" (must be one of: ${validProductionTypes.join(', ')})`);
    }
  }

  // Validate estimatedRecoupmentPct
  if (show.estimatedRecoupmentPct != null) {
    if (!Array.isArray(show.estimatedRecoupmentPct) || show.estimatedRecoupmentPct.length !== 2) {
      out.push(`commercial.json: "${showId}" estimatedRecoupmentPct must be a 2-element array [low, high]`);
    } else {
      const [low, high] = show.estimatedRecoupmentPct;
      if (typeof low !== 'number' || typeof high !== 'number') {
        out.push(`commercial.json: "${showId}" estimatedRecoupmentPct values must be numbers`);
      } else if (low < 0 || high > 100 || low > high) {
        out.push(`commercial.json: "${showId}" estimatedRecoupmentPct must satisfy 0 <= low <= high <= 100, got [${low}, ${high}]`);
      }
    }
  }

  // Validate originalProductionId references an existing show
  if (show.originalProductionId !== undefined) {
    if (!ctx.allRecords || !ctx.allRecords[show.originalProductionId]) {
      out.push(`commercial.json: "${showId}" originalProductionId "${show.originalProductionId}" does not reference an existing show in commercial.json`);
    }
  }

  // Validate isEstimate is an object with boolean values
  if (show.isEstimate !== undefined) {
    if (typeof show.isEstimate !== 'object' || Array.isArray(show.isEstimate) || show.isEstimate === null) {
      out.push(`commercial.json: "${showId}" isEstimate must be an object`);
    } else {
      for (const [key, val] of Object.entries(show.isEstimate)) {
        if (typeof val !== 'boolean') {
          out.push(`commercial.json: "${showId}" isEstimate.${key} must be a boolean, got ${typeof val}`);
        }
      }
    }
  }

  // Validate estimatedRecoupmentDate format
  if (show.estimatedRecoupmentDate !== undefined) {
    if (!dateRegex.test(show.estimatedRecoupmentDate)) {
      out.push(`commercial.json: "${showId}" estimatedRecoupmentDate must be YYYY-MM-DD format, got "${show.estimatedRecoupmentDate}"`);
    }
  }

  // Cross-validation: Tour Stop designation must have tour-stop or return-engagement productionType
  if (show.designation === 'Tour Stop') {
    if (show.productionType !== 'tour-stop' && show.productionType !== 'return-engagement') {
      out.push(`commercial.json: "${showId}" has designation "Tour Stop" but productionType is "${show.productionType || 'missing'}" (must be "tour-stop" or "return-engagement")`);
    }
  }

  // Cross-validation: tour-stop productionType must have Tour Stop designation
  if (show.productionType === 'tour-stop') {
    if (show.designation !== 'Tour Stop') {
      out.push(`commercial.json: "${showId}" has productionType "tour-stop" but designation is "${show.designation || 'missing'}" (must be "Tour Stop")`);
    }
  }

  // CRITICAL: Recouped shows MUST have recoupedDate (used to calculate weeks)
  if (show.recouped === true && !show.recoupedDate) {
    out.push(`commercial.json: "${showId}" has recouped=true but missing recoupedDate (REQUIRED for weeks calculation)`);
  }

  // Outcome-driven designation policy (memory/feedback_enhancement_deal_designation_policy.md):
  // Easy Winner / Windfall / Miracle imply the production recouped — require recouped=true.
  // Flop / Fizzle imply it did not — require recouped=false (null means we don't know).
  // Catches the purpose-2025 / floyd-collins-2025 class of inconsistency.
  const WIN_DESIGNATIONS = ['Easy Winner', 'Windfall', 'Miracle'];
  const LOSS_DESIGNATIONS = ['Flop', 'Fizzle'];
  if (WIN_DESIGNATIONS.includes(show.designation) && show.recouped !== true) {
    out.push(`commercial.json: "${showId}" has designation "${show.designation}" but recouped=${JSON.stringify(show.recouped)} (policy: win-designations require recouped=true with hard citation, see memory/feedback_enhancement_deal_designation_policy.md)`);
  }
  if (LOSS_DESIGNATIONS.includes(show.designation) && show.recouped !== false) {
    out.push(`commercial.json: "${showId}" has designation "${show.designation}" but recouped=${JSON.stringify(show.recouped)} (policy: loss-designations require recouped=false with hard citation; demote to "Nonprofit" or "TBD" if outcome unknown)`);
  }
  // A loss designation is a final outcome ("closed without recouping"). On a
  // show that is still running it is a guess shown as a result (two-strangers
  // was a "Flop" while open, BRO-4623). Skipped without the shows.json record.
  const runStatus = ctx.showRecord && ctx.showRecord.status;
  if (LOSS_DESIGNATIONS.includes(show.designation) && runStatus && runStatus !== 'closed') {
    out.push(`commercial.json: "${showId}" has designation "${show.designation}" but the show's status is "${runStatus}" (loss designations are for closed runs; use "TBD" until it closes)`);
  }

  // Public text must read as a citation, not as research-pipeline notes.
  for (const field of PUBLIC_TEXT_FIELDS) {
    const text = show[field];
    if (typeof text === 'string' && INTERNAL_TEXT_RE.test(text)) {
      out.push(`commercial.json: "${showId}" ${field} contains internal research wording ("${text.match(INTERNAL_TEXT_RE)[0]}"); /biz shows this field verbatim, so rewrite it as a public citation or set it to null`);
    }
  }

  // nonprofitOrg must match the show's venue. Catches the inverse of the
  // purpose-2025/job-2024 trap: tagging Liberation as Roundabout when the
  // venue was actually James Earl Jones (ATG commercial). Does NOT catch
  // commercial-rentals-at-correct-venue — that needs season-membership
  // verification, see memory/feedback_nonprofit_venue_vs_production.md.
  if (show.nonprofitOrg) {
    const showRecord = ctx.showRecord;
    if (showRecord?.venue) {
      const NP_VENUES = {
        'Lincoln Center Theater': ['Vivian Beaumont Theater', 'Mitzi E. Newhouse Theater', 'Claire Tow Theater'],
        'Manhattan Theatre Club': ['Samuel J. Friedman Theatre', 'New York City Center Stage I', 'New York City Center Stage II'],
        'Roundabout Theatre Company': ['Todd Haimes Theatre', 'American Airlines Theatre', 'Stephen Sondheim Theatre', 'Studio 54', 'Laura Pels Theatre', 'Harold and Miriam Steinberg Center for Theatre'],
        'Second Stage Theater': ['Helen Hayes Theater', 'Tony Kiser Theater'],
        // 'The Public Theater' venue field is the building name; specific room names
        // (Newman/Anspacher/Martinson/LuEsther/Shiva) appear in title metadata but
        // not as venue strings in shows.json.
        'The Public Theater': ['The Public Theater', 'Newman Theater', 'Anspacher Theater', 'Martinson Hall', 'LuEsther Hall', 'Shiva Theater'],
        // Off-Broadway nonprofit venues added 2026-05-24 backfill.
        'New York Theatre Workshop': ['New York Theatre Workshop'],
        'Atlantic Theater Company': ['Atlantic Theater Company', 'Linda Gross Theater', 'Atlantic Stage 2'],
        'MCC Theater': ['MCC Theater', 'Newman Mills Theater', 'The Lucille Lortel Theatre'],
        'Vineyard Theatre': ['Vineyard Theatre'],
        'Signature Theatre': ['Signature Theatre', 'Romulus Linney Courtyard Theatre', 'Irene Diamond Stage', 'Alice Griffin Jewel Box Theatre'],
        'Playwrights Horizons': ['Playwrights Horizons', 'Mainstage Theater', 'Peter Jay Sharp Theater'],
      };
      const allowed = NP_VENUES[show.nonprofitOrg];
      if (allowed && !allowed.includes(showRecord.venue)) {
        out.push(`commercial.json: "${showId}" has nonprofitOrg="${show.nonprofitOrg}" but venue is "${showRecord.venue}" (expected one of: ${allowed.join(', ')}). Likely a stale tag — was this a commercial production at a non-nonprofit venue?`);
      }
    }
  }

  // Validate recoupedDate format if present (YYYY-MM or YYYY)
  if (show.recoupedDate) {
    const validRecoupDateFormat = /^\d{4}(-\d{2})?$/;
    if (!validRecoupDateFormat.test(show.recoupedDate)) {
      out.push(`commercial.json: "${showId}" recoupedDate must be YYYY-MM or YYYY format, got "${show.recoupedDate}"`);
    }
  }

  // Validate profitMargin (if present, must be a number)
  if (show.profitMargin !== undefined && show.profitMargin !== null && typeof show.profitMargin !== 'number') {
    out.push(`commercial.json: "${showId}" profitMargin must be a number, got ${typeof show.profitMargin}`);
  }

  // Validate investorMultiple (if present, must be a number >= 0)
  if (show.investorMultiple !== undefined && show.investorMultiple !== null) {
    if (typeof show.investorMultiple !== 'number') {
      out.push(`commercial.json: "${showId}" investorMultiple must be a number, got ${typeof show.investorMultiple}`);
    } else if (show.investorMultiple < 0) {
      out.push(`commercial.json: "${showId}" investorMultiple must be >= 0, got ${show.investorMultiple}`);
    }
  }

  // Validate insiderProfitSharePct (if present, must be a number 0-100)
  if (show.insiderProfitSharePct !== undefined && show.insiderProfitSharePct !== null) {
    if (typeof show.insiderProfitSharePct !== 'number') {
      out.push(`commercial.json: "${showId}" insiderProfitSharePct must be a number, got ${typeof show.insiderProfitSharePct}`);
    } else if (show.insiderProfitSharePct < 0 || show.insiderProfitSharePct > 100) {
      out.push(`commercial.json: "${showId}" insiderProfitSharePct must be 0-100, got ${show.insiderProfitSharePct}`);
    }
  }

  // Validate sources array (if present)
  if (show.sources !== undefined && show.sources !== null) {
    if (!Array.isArray(show.sources)) {
      out.push(`commercial.json: "${showId}" sources must be an array`);
    } else {
      const validSourceTypes = ['trade', 'reddit', 'sec', 'manual'];
      const sourceDateRegex = /^\d{4}-\d{2}-\d{2}$/;
      show.sources.forEach((src, idx) => {
        if (!src.type || !validSourceTypes.includes(src.type)) {
          out.push(`commercial.json: "${showId}" sources[${idx}].type must be one of: ${validSourceTypes.join(', ')}`);
        }
        if (!src.url || typeof src.url !== 'string') {
          out.push(`commercial.json: "${showId}" sources[${idx}].url must be a string`);
        }
        // Date is optional (null/undefined allowed) — many venue/aggregator URLs lack a publish date.
        // But if present, it must match YYYY-MM-DD.
        if (src.date != null && (typeof src.date !== 'string' || !sourceDateRegex.test(src.date))) {
          out.push(`commercial.json: "${showId}" sources[${idx}].date must be in YYYY-MM-DD format (or null)`);
        }
      });
    }
  }

  // Validate costMethodology
  if (show.costMethodology && !VALID_COST_METHODOLOGIES.includes(show.costMethodology)) {
    out.push(`commercial.json: "${showId}" has invalid costMethodology "${show.costMethodology}". Valid values: ${VALID_COST_METHODOLOGIES.join(', ')}`);
  }

  // Validate deepResearch object if present
  if (show.deepResearch) {
    const dr = show.deepResearch;

    // verifiedFields must be an array of strings
    if (!Array.isArray(dr.verifiedFields)) {
      out.push(`commercial.json: "${showId}" deepResearch.verifiedFields must be an array`);
    } else if (dr.verifiedFields.length === 0) {
      out.push(`commercial.json: "${showId}" deepResearch.verifiedFields cannot be empty`);
    } else if (!dr.verifiedFields.every(f => typeof f === 'string')) {
      out.push(`commercial.json: "${showId}" deepResearch.verifiedFields must contain only strings`);
    }

    // verifiedDate must be an ISO date string (YYYY-MM-DD)
    if (!dr.verifiedDate) {
      out.push(`commercial.json: "${showId}" deepResearch.verifiedDate is required`);
    } else if (!dateRegex.test(dr.verifiedDate)) {
      out.push(`commercial.json: "${showId}" deepResearch.verifiedDate must be in YYYY-MM-DD format`);
    }

    // verifiedBy is optional but must be string if present
    if (dr.verifiedBy !== undefined && typeof dr.verifiedBy !== 'string') {
      out.push(`commercial.json: "${showId}" deepResearch.verifiedBy must be a string`);
    }

    // notes is optional but must be string if present
    if (dr.notes !== undefined && typeof dr.notes !== 'string') {
      out.push(`commercial.json: "${showId}" deepResearch.notes must be a string`);
    }
  }
  return out;
}

/** All record errors for a parsed commercial.json, given shows.json's list. */
function commercialFileErrors(data, showsList) {
  const bySlug = new Map();
  for (const s of showsList || []) if (s && s.slug) bySlug.set(s.slug, s);
  const out = [];
  for (const [showId, show] of Object.entries((data && data.shows) || {})) {
    out.push(...commercialRecordErrors(showId, show, { showRecord: bySlug.get(showId), allRecords: data.shows }));
  }
  return out;
}

module.exports = { commercialRecordErrors, commercialFileErrors, VALID_COST_METHODOLOGIES, VALID_PRODUCTION_TYPES, INTERNAL_TEXT_RE, PUBLIC_TEXT_FIELDS };
