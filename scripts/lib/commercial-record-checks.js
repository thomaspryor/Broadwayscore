/**
 * Per-record validation rules for data/commercial.json: the single copy.
 *
 * Moved out of validate-data.js's validateCommercialJson() (BRO-4623) so the
 * human-approved plan runner (execute-approved-fix.js) refuses a plan with the
 * SAME rules the site build enforces. Before this, the runner had a partial
 * hand-copy, so a plan could pass the runner, push the private data repo, and
 * only then fail test.yml. Add new commercial rules HERE, never inline.
 *
 * Pure: no I/O. The *Errors / *Warnings functions return arrays of message
 * strings ([] = ok).
 */

const { ourRecoupEstimateErrors } = require('./our-recoup-estimate');

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

// Fields /biz renders verbatim. weeklyRunningCostSource is not here: the UI
// prints it only through publicSourceText(), and a cost whose source that
// drops reads "Estimate" (src/lib/commercial-display.ts, BRO-4666).
const PUBLIC_TEXT_FIELDS = ['notes', 'capitalizationSource', 'recoupedSource'];
// Two double quotation marks in a row, straight or curly: a quoted title at
// the edge of a quote, printed as ""The Band's Visit" has recouped" (BRO-5549).
const DOUBLED_QUOTE_RE = /["“”]{2}/;
// Research-pipeline wording that reached the public page (BRO-4623): "SEC
// filings (GPT Deep Research)", "Trade press / deep research synthesis",
// "Auto-enrolled stub; awaiting model + curation", "Auto-designated ...".
// "[PLAUSIBILITY WARNING: ...]" is the prefix batch-commercial-research.js
// adds to a model's notes for reviewers; it must never reach the page.
// Model names are matched with their family word ("Claude Sonnet", not
// "Claude": Claude-Michel Schönberg wrote Les Misérables).
// Hand-edit process notes ("Per policy applied 2026-05-24: ...", "Kept ...
// per owner review") are internal too (BRO-4669).
const INTERNAL_TEXT_RE = /\bGPT\b|\bChatGPT\b|\bdeep[ -]research\b|\bDR Batch\b|\bauto-(?:enrolled|designated)\b|\bawaiting model\b|\bresearch synthesis\b|\bLLM\b|\bPLAUSIBILITY WARNING\b|\bo[134]-mini\b|\bAI[- ]estimated?\b|\bClaude (?:Sonnet|Opus|Haiku)\b|\bGemini (?:\d|Pro|Flash|Ultra)|\bper policy\b|\bowner (?:review|decision|sign-?off)\b/i;
// "Section C: ...", the weekly update's name for a part of its model context
// (BRO-4666). Capital letters only, so prose ("see section a: ...") passes.
const CONTEXT_SECTION_RE = /\b[Ss]ections? [A-H](?:\s*(?:,|&|and|or|\/|-|–)\s*[A-H])*\s*:/;
// A record field written as code: "recouped:null because no public citation",
// "designation=Nonprofit" (BRO-4669). Case-sensitive (lowercase field name) so
// "Based on a True story" never matches. Mirrors INTERNAL_TOKEN_RE in
// src/lib/commercial-display.ts.
const INTERNAL_TOKEN_RE = /\b[a-z][A-Za-z]*\s?[:=]\s?(?:true|false|null)\b|\b[a-z][A-Za-z]*=[A-Z]/;
// A researcher talking about the search: first person ("I couldn't verify a
// weekly nut", "I used the $17M AP figure", "we found no report"), the
// record's own fields ("so that field is null", "best-fit designation"). The
// BRO-4990 backfill wrote these into notes, and /biz would print them as the
// site speaking (BRO-5041). Capital "I" only, and never a numeral ("Act I
// could not", "Stage I run", "Henry I did").
const FIRST_PERSON_SEARCH_RE = /(?<!\b(?:Act|Part|Book|Chapter|Volume|Stage|Phase|Season|Level|War|Title|Henry|Richard|Elizabeth|Charles|James|George|Edward|William|Mary|Louis|Peter|Catherine|Alexander|Frederick|Philip|Napoleon) )\bI (?!and [Yy]ou\b)(?:[a-z]+)\b|\b[Ww]e (?:couldn['’]t|could not|did not|didn['’]t|were unable|found no|cannot|can['’]t|weren['’]t able|used|classify|checked)\b|\b(?:[Tt]hat|[Tt]his) field\b|\b[Bb]est[- ]fit (?:designation|label)\b/;
// A markdown link ("([ibdb.com](https://...?utm_source=openai))") is a research
// tool's citation; /biz prints text, so it would show as raw brackets.
const MARKDOWN_LINK_RE = /\[[^\]\n]*\]\(\s*https?:\/\/[^)\s]*\)/;
// In a citation field the link's URL is the citation: keep it, bare, without
// the research tool's tracking parameter.
const MARKDOWN_LINK_URL_RE = /\(?\[[^\]\n]*\]\(\s*(https?:\/\/[^)\s]*)\)\)?/g;
function bareCitationUrls(text) {
  return text.replace(MARKDOWN_LINK_URL_RE, (_m, url) => url.replace(/([?&])utm_source=openai(&|$)/, (_s, pre, post) => (post ? pre : '')).replace(/[?&]$/, ''));
}
const MARKDOWN_CITATION_RE = /\s*\(?\[[^\]\n]*\]\(\s*https?:\/\/[^)\s]*\)\)?/g;
// Writers store article URLs as sources; a URL slug ("...-gpt-...") or query
// string ("?type=D") is not wording a reader sees.
const URL_RE = /\bhttps?:\/\/\S+/gi;
// Source fields are citations. Research wording in one means the citation is
// research output, so a writer clears the field rather than trimming it to
// something that reads like a checked source.
const CITATION_FIELDS = ['capitalizationSource', 'recoupedSource'];
const { NP_VENUES, venueMatches } = require('./nonprofit-venues');
const { VALID_DESIGNATIONS, VALID_DESIGNATION_BASES, DESIGNATION_BASES, FIZZLE_MIN_RETURNED_PCT, ownReturnedEstimatePct, returnedEstimatePct, labelSizingPct, isLossDesignation, lossDesignationFor, REPORTED_WIN_DESIGNATIONS, WAIT_AND_SEE, WAIT_AND_SEE_MIN_RETURNED_PCT, modelPctWithoutCredit } = require('./commercial-designations');
const { conversionOf, conversionShapeProblems } = require('./commercial-conversion');
const { COST_BASES, BASIS_CUE_TEXT } = require('./cost-split');
const { CAPITALIZATION_BASES } = require('./public-source-text');

/** The research wording in `text` outside any URL, or null. */
function internalWordingIn(text) {
  if (typeof text !== 'string') return null;
  const link = text.match(MARKDOWN_LINK_RE);
  if (link) return link[0];
  const prose = text.replace(URL_RE, ' ');
  // A quoted line ('"I lost everything," the producer said') is a source
  // speaking, not the researcher.
  const unquoted = prose.replace(/"[^"]*"|“[^”]*”/g, ' ');
  const match = prose.match(INTERNAL_TEXT_RE) || prose.match(INTERNAL_TOKEN_RE) || prose.match(CONTEXT_SECTION_RE)
    || unquoted.match(FIRST_PERSON_SEARCH_RE);
  return match ? match[0] : null;
}

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

  // Validate productionType. null means unset, like a missing key: a plan's
  // data-edit can only write a value, so null is how it clears the field
  // (BRO-5520). A Tour Stop still needs a real type (below).
  if (show.productionType != null) {
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

  for (const problem of ourRecoupEstimateErrors(show)) out.push(`commercial.json: "${showId}" ${problem}`);

  // ourEstimateRangePct (BRO-6245): our own rounded [low, high], ends in whole 5s,
  // never on a recouped show (it would read as an earlier share outranking the recoupment).
  if (show.ourEstimateRangePct != null) {
    const r = show.ourEstimateRangePct;
    if (!Array.isArray(r) || r.length !== 2 || !r.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      out.push(`commercial.json: "${showId}" ourEstimateRangePct must be a 2-element numeric array [low, high]`);
    } else if (r[0] < 0 || r[0] > r[1] || r[1] > 150 || r.some((v) => v % 5 !== 0)) {
      out.push(`commercial.json: "${showId}" ourEstimateRangePct must satisfy 0 <= low <= high <= 150 with both ends multiples of 5, got [${r.join(', ')}]`);
    }
    if (show.recouped === true) {
      out.push(`commercial.json: "${showId}" is recouped but carries ourEstimateRangePct (remove it)`);
    }
    if (show.estimatedRecoupmentPct != null) {
      out.push(`commercial.json: "${showId}" carries both estimatedRecoupmentPct and ourEstimateRangePct (label sizing and the displayed range would read different numbers; remove one)`);
    }
    if (show.analystRecoupPct != null) {
      out.push(`commercial.json: "${showId}" carries both analystRecoupPct and ourEstimateRangePct (the analyst's figure wins, so ours is dead weight; remove it)`);
    }
  }

  // A nonprofit run that switched to a commercial run (BRO-5508,
  // commercial-conversion.js): a commercial designation (it has investors),
  // the presenting nonprofit, and a date inside the run.
  for (const problem of conversionShapeProblems(show.commercialConversion)) {
    out.push(`commercial.json: "${showId}" commercialConversion ${problem}`);
  }
  const conversion = conversionOf(show);
  if (conversion) {
    if (show.designation === 'Nonprofit' || show.designation === 'Tour Stop') {
      out.push(`commercial.json: "${showId}" has commercialConversion but designation "${show.designation}" (a commercial run has investors: use TBD until the outcome is known)`);
    }
    if (!show.nonprofitOrg) {
      out.push(`commercial.json: "${showId}" has commercialConversion but no nonprofitOrg (name the nonprofit that presented the first run)`);
    }
    const run = ctx.showRecord;
    if (conversion.date && run) {
      if (run.previewsStartDate && conversion.date <= run.previewsStartDate) {
        out.push(`commercial.json: "${showId}" commercialConversion.date ${conversion.date} is not after the first preview (${run.previewsStartDate})`);
      }
      if (run.closingDate && conversion.date > run.closingDate) {
        out.push(`commercial.json: "${showId}" commercialConversion.date ${conversion.date} is after the closing date (${run.closingDate})`);
      }
    }
    if (conversion.date && typeof show.recoupedDate === 'string' && show.recoupedDate.slice(0, 7) < conversion.date.slice(0, 7)) {
      out.push(`commercial.json: "${showId}" recoupedDate ${show.recoupedDate} is before its commercial run began (${conversion.date})`);
    }
  }

  // Validate originalProductionId references an existing show. A data plan
  // clears a field by writing null, so null counts as absent (BRO-5602).
  if (show.originalProductionId != null) {
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

  // Validate estimatedRecoupmentDate format (null = cleared, as above)
  if (show.estimatedRecoupmentDate != null) {
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
  // Loss labels (Fizzle, Flop, Did Not Recoup) imply it did not — require recouped=false (null means we don't know).
  // Catches the purpose-2025 / floyd-collins-2025 class of inconsistency.
  const WIN_DESIGNATIONS = REPORTED_WIN_DESIGNATIONS;
  const modelEstimated = show.designationBasis === DESIGNATION_BASES.MODEL_ESTIMATE;
  // A model-estimate tier is our estimate, not a reported recoupment (owner 2026-10-24, BRO-6158).
  if (WIN_DESIGNATIONS.includes(show.designation) && show.recouped !== true && !modelEstimated) {
    out.push(`commercial.json: "${showId}" has designation "${show.designation}" but recouped=${JSON.stringify(show.recouped)} (policy: win-designations require recouped=true with hard citation, see memory/feedback_enhancement_deal_designation_policy.md)`);
  }
  if (isLossDesignation(show.designation) && show.recouped !== false && !(modelEstimated && show.recouped == null)) {
    out.push(`commercial.json: "${showId}" has designation "${show.designation}" but recouped=${JSON.stringify(show.recouped)} (policy: loss-designations require recouped=false with hard citation; demote to "Nonprofit" or "TBD" if outcome unknown)`);
  }
  // Squeaker (BRO-6499): recouped only because the NY State tax credit pushed returns over 100%.
  // Reported, never our estimate: it needs the cited recoupment AND the credit named in that citation.
  if (show.designation === 'Squeaker') {
    if (modelEstimated) {
      out.push(`commercial.json: "${showId}" is Squeaker on a model estimate (a Squeaker is reported: a cited recoupment that names the NY tax credit)`);
    }
    if (!/tax credit/i.test(String(show.recoupedSource || ''))) {
      out.push(`commercial.json: "${showId}" is Squeaker but recoupedSource does not cite the NY State tax credit's part in the recoupment`);
    }
  }
  // Wait & See (BRO-6499): closed without recouping, 50%+ back, later money may still recoup it.
  if (show.designation === WAIT_AND_SEE) {
    if (show.recouped !== false) {
      out.push(`commercial.json: "${showId}" is ${WAIT_AND_SEE} but recouped=${JSON.stringify(show.recouped)} (it counts as not recouped, so recouped must be false)`);
    }
    const own = ownReturnedEstimatePct(show);
    if (own === null || own < WAIT_AND_SEE_MIN_RETURNED_PCT || own >= 100) {
      out.push(`commercial.json: "${showId}" is ${WAIT_AND_SEE} but its own estimate of the share returned is ${own === null ? 'missing' : own + '%'} (needs a cited estimate of ${WAIT_AND_SEE_MIN_RETURNED_PCT}% to under 100%)`);
    }
    if (!Array.isArray(show.sources) || !show.sources.some((x) => x && /^https?:\/\//.test(String(x.url || '')))) {
      out.push(`commercial.json: "${showId}" is ${WAIT_AND_SEE} but cites no source for the share returned`);
    }
  }
  // capitalizationBasis (BRO-5660): what the figure is, on a capitalization.
  if (show.capitalizationBasis != null) {
    if (!CAPITALIZATION_BASES.includes(show.capitalizationBasis)) {
      out.push(`commercial.json: "${showId}" has invalid capitalizationBasis "${show.capitalizationBasis}". Valid values: ${CAPITALIZATION_BASES.join(', ')}`);
    } else if (show.capitalization == null) {
      out.push(`commercial.json: "${showId}" has capitalizationBasis but no capitalization`);
    }
  }
  // designationBasis (owner policy B, BRO-5020): what a loss label rests on.
  if (show.designationBasis != null && !VALID_DESIGNATION_BASES.includes(show.designationBasis)) {
    out.push(`commercial.json: "${showId}" has invalid designationBasis "${show.designationBasis}" (valid: ${VALID_DESIGNATION_BASES.join(', ')})`);
  }

  // Public text must read as a citation, not as research-pipeline notes.
  for (const field of PUBLIC_TEXT_FIELDS) {
    const wording = internalWordingIn(show[field]);
    if (wording) {
      out.push(`commercial.json: "${showId}" ${field} contains internal research wording ("${wording}"); /biz shows this field verbatim, so rewrite it as a public citation or set it to null`);
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
      const allowed = NP_VENUES[show.nonprofitOrg];
      if (allowed && !venueMatches(allowed, showRecord.venue)) {
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

  // weeklyRunningCostBasis (BRO-5093): a known value, on a cited cost.
  if (show.weeklyRunningCostBasis != null) {
    if (!COST_BASES.includes(show.weeklyRunningCostBasis)) {
      out.push(`commercial.json: "${showId}" has invalid weeklyRunningCostBasis "${show.weeklyRunningCostBasis}". Valid values: ${COST_BASES.join(', ')}`);
    } else if (!show.weeklyRunningCost || !show.weeklyRunningCostSource) {
      out.push(`commercial.json: "${showId}" has weeklyRunningCostBasis but no cited weeklyRunningCost (the basis is read from the source quote)`);
    }
  }
  // Validate costMethodology
  if (show.costMethodology && !VALID_COST_METHODOLOGIES.includes(show.costMethodology)) {
    out.push(`commercial.json: "${showId}" has invalid costMethodology "${show.costMethodology}". Valid values: ${VALID_COST_METHODOLOGIES.join(', ')}`);
  }

  // A cited weekly cost with no costMethodology reads as reported on the site
  // but as our own estimate in the cost model (BRO-6297, BRO-5632 parity).
  if (show.weeklyRunningCost > 0 && !show.costMethodology && String(show.weeklyRunningCostSource || '').trim()) {
    out.push(`commercial.json: "${showId}" has a cited weeklyRunningCost but no costMethodology (the site and the cost model disagree on whether it is reported; set one of ${VALID_COST_METHODOLOGIES.join(', ')})`);
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

const { addedPlaceholderSources } = require('./commercial-sources');
const { saysRecoupmentUnannounced, saysRecoupmentDateIsEstimate, publicSourceText, sourceOpensAsEstimate } = require('./public-source-text');

/**
 * Rules that depend on shows.json state as well as the record, plus new rules
 * landing advisory first (§19). validate-data.js reports these as warnings: a
 * status flip (update-show-status.js reopening a closed show) can create one
 * without any commercial.json write, and an error there would block the daily
 * status commit with nothing to clear it. The writers that DO write the record
 * (plan runner, add-commercial-entry, tips) treat them as errors for that record.
 */
function commercialRecordWarnings(showId, show, ctx = {}) {
  const out = [];
  // A loss designation is a final outcome ("closed without recouping"). On a
  // show that is still running it is a guess shown as a result (two-strangers
  // was a "Flop" while open, BRO-4623). Skipped without the shows.json record.
  const runStatus = ctx.showRecord && ctx.showRecord.status;
  if (isLossDesignation(show.designation) && runStatus && runStatus !== 'closed') {
    out.push(`commercial.json: "${showId}" has designation "${show.designation}" but the show's status is "${runStatus}" (loss designations are for closed runs; use "TBD" until it closes)`);
  }
  if (show.designation === WAIT_AND_SEE && runStatus && runStatus !== 'closed') {
    out.push(`commercial.json: "${showId}" has designation "${WAIT_AND_SEE}" but the show's status is "${runStatus}" (it is for closed runs)`);
  }
  // A label a person reviewed (humanReviewedDesignation) outranks this model
  // check: the model is an estimate, the reviewer had the source (BRO-6559).
  if (show.designation === 'Squeaker' && show.humanReviewedDesignation !== true) {
    const exCredit = modelPctWithoutCredit(show);
    if (exCredit !== null && exCredit >= 100) {
      out.push(`commercial.json: "${showId}" is Squeaker but our model has it past 100% even without the NY tax credit (${Math.round(exCredit)}%); check the citation`);
    }
  }
  // Every loss label says what it rests on (owner policy B, BRO-5020). Advisory (§19).
  if (isLossDesignation(show.designation) && show.designationBasis == null) {
    out.push(`commercial.json: "${showId}" has designation "${show.designation}" with no designationBasis (reported-loss, no-recoupment-announced, notes-stated or model-estimate)`);
  }
  // Fizzle is an estimated 30% or more returned, Flop under it, so a loss
  // label must agree with its estimate: the record's own, else our model's
  // when its inputs are decent (BRO-5602: suffs was a Fizzle beside "0-10%
  // returned"; BRO-5623). With no estimate the label is Did Not Recoup, and a
  // Did Not Recoup that gains one takes its size (owner 2026-10-18, BRO-5636).
  // Advisory (§19). A writer passing ctx.priorRecord counts it only when the
  // write changed the label or the estimate: a model figure that drifted
  // since must not block an unrelated edit to the record.
  const returnedPct = labelSizingPct(show);
  const prior = ctx.priorRecord;
  const sizeInputsChanged = !prior || prior.designation !== show.designation || labelSizingPct(prior) !== returnedPct;
  if (sizeInputsChanged && isLossDesignation(show.designation) && lossDesignationFor(returnedPct) !== show.designation) {
    if (returnedPct == null) {
      out.push(`commercial.json: "${showId}" is "${show.designation}" but has no estimate of how much came back (use "Did Not Recoup" until a source or a decent model gives one)`);
    } else {
      const whose = ownReturnedEstimatePct(show) != null ? 'its own estimate' : 'our model (decent inputs)';
      out.push(`commercial.json: "${showId}" is "${show.designation}" but ${whose} puts ${returnedPct}% returned (Fizzle is ${FIZZLE_MIN_RETURNED_PCT}% or more, Flop under)`);
    }
  }
  const modelEstimated = show.designationBasis === DESIGNATION_BASES.MODEL_ESTIMATE;
  const estimateTiers = ['Trickle', 'Windfall'];
  if (show.designationBasis != null && !isLossDesignation(show.designation)
    && !(modelEstimated && estimateTiers.includes(show.designation))) {
    out.push(`commercial.json: "${showId}" has designationBasis "${show.designationBasis}" on a non-loss designation "${show.designation || 'missing'}" (remove it)`);
  }
  // A dated "% returned" range below 100 on a show that later recouped
  // (BRO-5091): ground truth, the designation rule and the display guard read
  // the range first, so the stale share would outrank the recoupment.
  const est = show.estimatedRecoupmentPct;
  if (show.recouped === true && Array.isArray(est) && est.length === 2 && est.every((v) => typeof v === 'number') && Math.max(...est) < 100) {
    out.push(`commercial.json: "${showId}" is recouped but carries estimatedRecoupmentPct [${est.join(', ')}] (an earlier share returned; ground truth reads it before the recoupment, so remove it)`);
  }
  // A nonprofit run raises no investor money, so a Form D on it is almost
  // always another production's offering matched by name (BRO-5517: "Old
  // Friends Broadway LP" is Merrily We Roll Along's partnership, cited as the
  // Sondheim revue's $12M capitalization). Converted runs are not Nonprofit.
  if (show.designation === 'Nonprofit' && Array.isArray(show.sources) && show.sources.some((s) => /(?:^|\.)sec\.gov\//.test(String((s && s.url) || '').replace(/^https?:\/\//, '')))) {
    out.push(`commercial.json: "${showId}" is Nonprofit but cites an SEC filing (a nonprofit run has no investor offering; check the filing names this production, or drop it)`);
  }
  // A hard-sourced cost whose quote says all-in or breakeven, with no
  // explicit weeklyRunningCostBasis (BRO-5093): the costBasis model would
  // read the text guess instead of a checked tag.
  if (['trade-reported', 'sec-filing', 'producer-confirmed'].includes(show.costMethodology) && show.weeklyRunningCost && show.weeklyRunningCostBasis == null && BASIS_CUE_TEXT.test(String(show.weeklyRunningCostSource || '').replace(URL_RE, ' '))) {
    out.push(`commercial.json: "${showId}" has a ${show.costMethodology} weeklyRunningCost whose source mentions all-in or breakeven but no weeklyRunningCostBasis (tag it running, breakeven or all-in)`);
  }
  // A reported-methodology weekly cost with no weeklyRunningCostSource credits
  // a report the site cannot show (BRO-5838: 15 records, several with notes
  // that call the figure an estimate). Cite it, or label it an estimate.
  if (['trade-reported', 'sec-filing', 'producer-confirmed'].includes(show.costMethodology) && show.weeklyRunningCost && !String(show.weeklyRunningCostSource || '').trim()) {
    out.push(`commercial.json: "${showId}" has a ${show.costMethodology} weeklyRunningCost but no weeklyRunningCostSource (cite the report, or set costMethodology to industry-estimate or reddit-standard)`);
  }
  // A source that links a site's homepage, or this site, cites nothing
  // (BRO-5264: Hell's Kitchen's amNY and Broadway Journal entries, two bare
  // sec.gov links; bro-5006 cited broadwayscorecard.com for four stubs).
  // Wikipedia is a pointer to sources, not one (BRO-5268: 26 records cite it).
  // Advisory (§19). A writer passes ctx.priorRecord so only a link the write
  // adds counts: a tip or plan on an old record is not blocked by its old links.
  if (Array.isArray(show.sources)) {
    for (const { idx, kind, url } of addedPlaceholderSources(show.sources, ctx.priorRecord && ctx.priorRecord.sources)) {
      if (kind === 'own-site') {
        out.push(`commercial.json: "${showId}" sources[${idx}].url ${url} is this site, which cannot source its own figures`);
      } else if (kind === 'wikipedia') {
        out.push(`commercial.json: "${showId}" sources[${idx}].url ${url} is Wikipedia, not a source (link the article or filing it cites)`);
      } else {
        out.push(`commercial.json: "${showId}" sources[${idx}].url ${url} is a homepage, not an article or filing (link the page that states it)`);
      }
    }
    // The same link listed twice cites nothing new (BRO-5562: a plan appended
    // an article the record already cited). Advisory (§19); like the
    // placeholder links above, only a copy beyond what the record already
    // carried counts.
    // http/https, www., a trailing slash and utm_ tracking tags (research
    // tools add ?utm_source=chatgpt.com) do not make a new link. A port, a
    // #fragment (hash-routed pages, PDF pages) and a non-web link do: this
    // refuses a touched record, so it may only merge links that are the same.
    const sameLink = (url) => {
      const raw = String(url).trim();
      if (!/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
      try {
        const u = new URL(raw);
        for (const key of [...u.searchParams.keys()]) if (/^utm_/i.test(key)) u.searchParams.delete(key);
        const query = u.searchParams.toString();
        return `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}${u.hash}`;
      } catch {
        return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      }
    };
    const priorCount = new Map();
    for (const s of (ctx.priorRecord && Array.isArray(ctx.priorRecord.sources)) ? ctx.priorRecord.sources : []) {
      if (!s || !s.url) continue;
      const key = sameLink(s.url);
      priorCount.set(key, (priorCount.get(key) || 0) + 1);
    }
    const seen = new Map();
    show.sources.forEach((s, idx) => {
      if (!s || !s.url) return;
      const key = sameLink(s.url);
      const sofar = seen.get(key) || 0;
      if (sofar >= Math.max(1, priorCount.get(key) || 0)) out.push(`commercial.json: "${showId}" sources[${idx}].url ${s.url} is already listed (drop the repeat)`);
      seen.set(key, sofar + 1);
    });
  }
  // isEstimate.recouped makes the card say "Not publicly announced", so the
  // source must say why (BRO-5562: bro-5268-e quoted BroadwayWorld's report
  // that Sweeney Todd recouped in November 2023 and left the flag set).
  // Advisory (§19); only a write that sets the flag or changes the source counts.
  if (show.recouped === true && show.isEstimate && show.isEstimate.recouped === true && !saysRecoupmentUnannounced(show.recoupedSource)) {
    const prior = ctx.priorRecord;
    const flaggedBefore = !!(prior && prior.recouped === true && prior.isEstimate && prior.isEstimate.recouped === true);
    if (!flaggedBefore || prior.recoupedSource !== show.recoupedSource) {
      out.push(`commercial.json: "${showId}" isEstimate.recouped prints "Not publicly announced" but recoupedSource does not say it went unannounced (if it did, say "No recoupment was announced."; if the source reports the recoupment, clear the flag)`);
    }
  }
  // isEstimate.capitalization prints the figure with "~", so its source must
  // say it is an estimate (BRO-5647: bro-5647-b swapped CATS to The Hollywood
  // Reporter's reported $18M and left the flag, so the card still read
  // "~$18.0M"). Advisory (§19); only a write that sets the flag or changes the
  // source counts.
  if (show.isEstimate && show.isEstimate.capitalization === true && publicSourceText(show.capitalizationSource) && !sourceOpensAsEstimate(show.capitalizationSource)) {
    const prior = ctx.priorRecord;
    const flaggedBefore = !!(prior && prior.isEstimate && prior.isEstimate.capitalization === true);
    if (!flaggedBefore || prior.capitalizationSource !== show.capitalizationSource) {
      out.push(`commercial.json: "${showId}" isEstimate.capitalization prints "~" but capitalizationSource reads as a reported figure (if it is an estimate, open the source with "Estimate:" or "Estimated by ..."; if the source reports it, clear the flag)`);
    }
  }
  // isEstimate.recoupedDate prints the date with "~" and counts no weeks from it, so
  // it goes with a source that calls the date our estimate, and the reverse (BRO-5568:
  // Chicago "March 1997", Phantom 1989 printed as reported). Advisory (§19); only a
  // write that sets the flag or changes the source counts.
  if (show.recouped === true) {
    const prior = ctx.priorRecord;
    const flagged = !!(show.isEstimate && show.isEstimate.recoupedDate === true);
    const says = saysRecoupmentDateIsEstimate(show.recoupedSource);
    const priorFlagged = !!(prior && prior.isEstimate && prior.isEstimate.recoupedDate === true);
    const changed = !prior || prior.recoupedSource !== show.recoupedSource || priorFlagged !== flagged;
    if (changed && says && !flagged) {
      out.push(`commercial.json: "${showId}" recoupedSource says the recoupment date is an estimate but isEstimate.recoupedDate is not set (the card would print it as reported and /biz would count weeks from it)`);
    } else if (changed && flagged && !says) {
      out.push(`commercial.json: "${showId}" isEstimate.recoupedDate prints "~" but recoupedSource does not say the date is our estimate (if the date is reported, drop the flag)`);
    }
  }
  // The card prints these as written, so a title quoted inside a quote takes
  // single marks. Advisory (§19); a writer passes ctx.priorRecord so only text
  // the write changes counts, as with the placeholder links above.
  for (const field of [...PUBLIC_TEXT_FIELDS, 'weeklyRunningCostSource']) {
    if (ctx.priorRecord && ctx.priorRecord[field] === show[field]) continue;
    const doubled = typeof show[field] === 'string' && DOUBLED_QUOTE_RE.exec(show[field]);
    if (doubled) {
      out.push(`commercial.json: "${showId}" ${field} has doubled quotation marks (${doubled[0]}); quote a title inside a quote with single marks`);
    }
  }
  return out;
}

function eachRecord(data, showsList, rule) {
  const bySlug = new Map();
  for (const s of showsList || []) if (s && s.slug) bySlug.set(s.slug, s);
  const out = [];
  for (const [showId, show] of Object.entries((data && data.shows) || {})) {
    out.push(...rule(showId, show, { showRecord: bySlug.get(showId), allRecords: data.shows }));
  }
  return out;
}

/** All record errors for a parsed commercial.json, given shows.json's list. */
function commercialFileErrors(data, showsList) {
  return [...eachRecord(data, showsList, designationErrors), ...eachRecord(data, showsList, commercialRecordErrors)];
}

/**
 * Every stored record carries a canonical designation, TBD when the outcome is
 * unknown (BRO-5824: two claim-built records shipped with none, failing the
 * Test Suite on every run). Run on stored records (the whole file, or the
 * records a plan wrote), not inside commercialRecordErrors, which tip and
 * field-edit checks also call on partial records.
 */
function designationErrors(showId, show) {
  if (VALID_DESIGNATIONS.includes(show.designation)) return [];
  return [`commercial.json: "${showId}" has invalid designation "${show.designation ?? 'missing'}" (must be one of: ${VALID_DESIGNATIONS.join(', ')}; TBD when unknown)`];
}

/** All record warnings for a parsed commercial.json, given shows.json's list. */
function commercialFileWarnings(data, showsList) {
  return eachRecord(data, showsList, commercialRecordWarnings);
}

/**
 * Errors plus warnings for only the records a plan touched (the apply-time check in execute-approved-fix.js
 * runValidation, shared with preflight-review-fix-plan.js so a plan is checked before it lands, BRO-5528).
 * Warnings count as errors for a record a plan writes. `priorShows` is commercial.shows before the plan, so a
 * rule can tell a link the plan added from one already there. Returns the full list; callers truncate.
 */
function touchedRecordProblems(data, showsList, touchedKeys, priorShows) {
  const bySlug = new Map();
  for (const s of showsList || []) if (s && s.slug) bySlug.set(s.slug, s);
  const records = (data && data.shows) || {};
  return [...new Set(touchedKeys)]
    .filter((k) => records[k])
    .flatMap((k) => {
      const ctx = { showRecord: bySlug.get(k), allRecords: records, priorRecord: priorShows && priorShows[k] };
      return [...designationErrors(k, records[k]), ...commercialRecordErrors(k, records[k], ctx), ...commercialRecordWarnings(k, records[k], ctx)];
    });
}

// A sentence ends at . ; ! or ? followed by space and a non-lowercase start,
// except after an initial ("J. Smith") or a common abbreviation ("Jr.",
// "St. James", "approx. $2M"), which would otherwise cut a citation in half.
const SENTENCE_BREAK_RE = /(?<=[.;!?])(?<!\b[A-Z]\.)(?<!\b(?:Jr|Sr|Mr|Mrs|Ms|Dr|St|Mt|Inc|Co|Corp|Ltd|Bros|No|vs|ca|approx|Approx|est|Est|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.)\s+(?=[^a-z])/;

/**
 * Drops the research wording from a public text field and keeps the rest:
 * a bracketed aside that contains it goes ("Limited run (GPT summary)."
 * keeps "Limited run."), then any sentence that still contains it. Returns
 * null when nothing public is left. URLs are left alone (internalWordingIn).
 */
function stripInternalWording(text) {
  if (!internalWordingIn(text)) return text;
  const noLinks = text.replace(MARKDOWN_CITATION_RE, '');
  const noAsides = noLinks.replace(/\s*[([][^()[\]]*[)\]]/g, (aside) => (internalWordingIn(aside) ? '' : aside));
  const kept = noAsides.split(SENTENCE_BREAK_RE).filter((sentence) => !internalWordingIn(sentence));
  const out = kept.join(' ').replace(/\s+/g, ' ').replace(/[\s;,:]+$/, '').trim();
  return out && /[A-Za-z0-9]/.test(out) ? out : null;
}

/**
 * For writers that copy model output into commercial.json unreviewed: returns
 * a copy that passes the public-text rule and the run-status warning, so one
 * bad model answer cannot make validate-data abort the whole run. Research
 * wording is stripped from notes (stripInternalWording); a source field that
 * contains it is cleared (CITATION_FIELDS); a loss label on a show whose
 * status is known and not "closed" becomes "TBD". `changed` lists the fields
 * altered, for the caller's log.
 *
 * `holdReason` is set when cleaning would hide something a person must see,
 * and the caller must not write the entry (leave it pending instead):
 * a recoupment claim cited to research output (the page would show
 * "recouped" with no checked source), or a model answer that failed
 * batch-commercial-research.js's plausibility check.
 *
 * @param {object} entry
 * @param {object} [show] - the shows.json record whose slug is the
 *   commercial.json key the entry will be written under (status, closingDate).
 */
// `show` is the shows.json record (undefined when unknown). A bare status
// string is refused: it silently skipped the age rule below (BRO-5020).
function sanitizeForPublicRecord(entry, show, { ownerApproved = false, now = Date.now() } = {}) {
  if (typeof show === 'string') throw new TypeError('sanitizeForPublicRecord: pass the shows.json record, not its status');
  const showRecord = show || null;
  const showStatus = showRecord ? showRecord.status : undefined;
  const out = { ...entry };
  const changed = [];
  let holdReason = null;
  if (typeof out.notes === 'string' && /\bPLAUSIBILITY WARNING\b/i.test(out.notes)) {
    holdReason = 'model figures failed the plausibility check; a person must confirm them';
  } else if (out.recouped === true && internalWordingIn(out.recoupedSource)) {
    holdReason = 'recoupment claim is cited to research output; it needs a public source';
  }
  for (const field of CITATION_FIELDS) {
    if (typeof out[field] !== 'string' || !MARKDOWN_LINK_RE.test(out[field])) continue;
    out[field] = bareCitationUrls(out[field]);
    changed.push(field);
  }
  for (const field of PUBLIC_TEXT_FIELDS) {
    if (!internalWordingIn(out[field])) continue;
    out[field] = CITATION_FIELDS.includes(field) ? null : stripInternalWording(out[field]);
    changed.push(field);
  }
  if (isLossDesignation(out.designation) && showStatus && showStatus !== 'closed') {
    out.designation = 'TBD';
    delete out.designationBasis;
    changed.push('designation');
  }
  if (ownerApproved === true && showStatus === 'closed' && isLossDesignation(out.designation)) {
    out.humanReviewedDesignation = true;
  }
  return { entry: out, changed, holdReason };
}

module.exports = { commercialRecordErrors, commercialRecordWarnings, touchedRecordProblems, commercialFileErrors, commercialFileWarnings, sanitizeForPublicRecord, stripInternalWording, internalWordingIn, VALID_COST_METHODOLOGIES, VALID_PRODUCTION_TYPES, INTERNAL_TEXT_RE, PUBLIC_TEXT_FIELDS, CITATION_FIELDS };
