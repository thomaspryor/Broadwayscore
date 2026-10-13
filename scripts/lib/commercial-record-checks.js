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
const LOSS_DESIGNATIONS = ['Flop', 'Fizzle'];
const { VALID_DESIGNATION_BASES, DESIGNATION_BASES, LOSS_LABEL_MIN_DAYS, isPrematureSilenceLabel } = require('./commercial-designations');
const { COST_BASES, BASIS_CUE_TEXT } = require('./cost-split');

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
  if (WIN_DESIGNATIONS.includes(show.designation) && show.recouped !== true) {
    out.push(`commercial.json: "${showId}" has designation "${show.designation}" but recouped=${JSON.stringify(show.recouped)} (policy: win-designations require recouped=true with hard citation, see memory/feedback_enhancement_deal_designation_policy.md)`);
  }
  if (LOSS_DESIGNATIONS.includes(show.designation) && show.recouped !== false) {
    out.push(`commercial.json: "${showId}" has designation "${show.designation}" but recouped=${JSON.stringify(show.recouped)} (policy: loss-designations require recouped=false with hard citation; demote to "Nonprofit" or "TBD" if outcome unknown)`);
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

// Scheme and host with at most a slash: no path, query or fragment.
const HOMEPAGE_URL = /^https?:\/\/[^/?#\s]+\/?$/i;
const OWN_SITE_URL = /^https?:\/\/(?:www\.)?broadwayscorecard\.com(?:[/?#]|$)/i;

/**
 * Rules that depend on shows.json state as well as the record. validate-data.js
 * reports these as warnings: a status flip (update-show-status.js reopening a
 * closed show) can create one without any commercial.json write, and an error
 * there would block the daily status commit with nothing to clear it. The
 * writers that DO write the record (plan runner, add-commercial-entry) treat
 * them as errors for that record.
 */
function commercialRecordWarnings(showId, show, ctx = {}) {
  const out = [];
  // A loss designation is a final outcome ("closed without recouping"). On a
  // show that is still running it is a guess shown as a result (two-strangers
  // was a "Flop" while open, BRO-4623). Skipped without the shows.json record.
  const runStatus = ctx.showRecord && ctx.showRecord.status;
  if (LOSS_DESIGNATIONS.includes(show.designation) && runStatus && runStatus !== 'closed') {
    out.push(`commercial.json: "${showId}" has designation "${show.designation}" but the show's status is "${runStatus}" (loss designations are for closed runs; use "TBD" until it closes)`);
  }
  // Owner policy B (BRO-5020): every loss label says what it rests on, and a
  // label resting on silence waits ~6 months after closing. Advisory (§19).
  if (LOSS_DESIGNATIONS.includes(show.designation) && show.designationBasis == null) {
    out.push(`commercial.json: "${showId}" has designation "${show.designation}" with no designationBasis (reported-loss, no-recoupment-announced or notes-stated)`);
  }
  if (show.designationBasis != null && !LOSS_DESIGNATIONS.includes(show.designation)) {
    out.push(`commercial.json: "${showId}" has designationBasis "${show.designationBasis}" on a non-loss designation "${show.designation || 'missing'}" (remove it)`);
  }
  // A dated "% returned" range below 100 on a show that later recouped
  // (BRO-5091): ground truth, the designation rule and the display guard read
  // the range first, so the stale share would outrank the recoupment.
  const est = show.estimatedRecoupmentPct;
  if (show.recouped === true && Array.isArray(est) && est.length === 2 && est.every((v) => typeof v === 'number') && Math.max(...est) < 100) {
    out.push(`commercial.json: "${showId}" is recouped but carries estimatedRecoupmentPct [${est.join(', ')}] (an earlier share returned; ground truth reads it before the recoupment, so remove it)`);
  }
  // A hard-sourced cost whose quote says all-in or breakeven, with no
  // explicit weeklyRunningCostBasis (BRO-5093): the costBasis model would
  // read the text guess instead of a checked tag.
  if (['trade-reported', 'sec-filing', 'producer-confirmed'].includes(show.costMethodology) && show.weeklyRunningCost && show.weeklyRunningCostBasis == null && BASIS_CUE_TEXT.test(String(show.weeklyRunningCostSource || '').replace(URL_RE, ' '))) {
    out.push(`commercial.json: "${showId}" has a ${show.costMethodology} weeklyRunningCost whose source mentions all-in or breakeven but no weeklyRunningCostBasis (tag it running, breakeven or all-in)`);
  }
  // A source that links a site's homepage, or this site, cites nothing
  // (BRO-5264: Hell's Kitchen's amNY and Broadway Journal entries, two bare
  // sec.gov links; bro-5006 cited broadwayscorecard.com for four stubs).
  // Advisory (§19). A writer passes ctx.priorRecord so only a link the write
  // adds counts: a tip or plan on an old record is not blocked by its old links.
  if (Array.isArray(show.sources)) {
    const prior = new Set(((ctx.priorRecord && ctx.priorRecord.sources) || []).map((s) => s && s.url));
    show.sources.forEach((src, idx) => {
      if (!src || typeof src.url !== 'string' || prior.has(src.url)) return;
      const url = src.url.trim();
      if (OWN_SITE_URL.test(url)) {
        out.push(`commercial.json: "${showId}" sources[${idx}].url ${src.url} is this site, which cannot source its own figures`);
      } else if (HOMEPAGE_URL.test(url)) {
        out.push(`commercial.json: "${showId}" sources[${idx}].url ${src.url} is a homepage, not an article or filing (link the page that states it)`);
      }
    });
  }
  if (isPrematureSilenceLabel(show, ctx.showRecord)) {
    out.push(`commercial.json: "${showId}" is "${show.designation}" on no recoupment announced but closed under ${LOSS_LABEL_MIN_DAYS} days ago (keep TBD + needsLossEvidence until it ages in)`);
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
  return eachRecord(data, showsList, commercialRecordErrors);
}

/** All record warnings for a parsed commercial.json, given shows.json's list. */
function commercialFileWarnings(data, showsList) {
  return eachRecord(data, showsList, commercialRecordWarnings);
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
function sanitizeForPublicRecord(entry, show) {
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
  if (LOSS_DESIGNATIONS.includes(out.designation) && showStatus && showStatus !== 'closed') {
    out.designation = 'TBD';
    delete out.designationBasis;
    changed.push('designation');
  }
  // Policy B (BRO-5020): a loss label resting on silence waits
  // LOSS_LABEL_MIN_DAYS after closing. Every new-record writer passes through
  // here with the show record, so a researched or released row cannot publish
  // one early (beaches, 2026-10-11). An owner-locked label is left alone, as
  // the classifier leaves it (the record checks still warn on it).
  if (out.humanReviewedDesignation !== true && isPrematureSilenceLabel(out, showRecord)) {
    out.designation = 'TBD';
    delete out.designationBasis;
    if (out.recouped === false) out.recouped = null;
    out.needsLossEvidence = true;
    changed.push('designation');
  }
  return { entry: out, changed, holdReason };
}

module.exports = { commercialRecordErrors, commercialRecordWarnings, commercialFileErrors, commercialFileWarnings, sanitizeForPublicRecord, stripInternalWording, internalWordingIn, VALID_COST_METHODOLOGIES, VALID_PRODUCTION_TYPES, INTERNAL_TEXT_RE, PUBLIC_TEXT_FIELDS, CITATION_FIELDS, LOSS_DESIGNATIONS };
