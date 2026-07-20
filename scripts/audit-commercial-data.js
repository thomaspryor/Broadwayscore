#!/usr/bin/env node
/**
 * audit-commercial-data.js
 *
 * Comprehensive audit of commercial.json data integrity.
 * Checks for mismatches, inconsistencies, missing fields, designation logic errors,
 * financial sanity, and coverage gaps.
 *
 * Output: data/audit/commercial-data-audit.json
 *
 * Usage: node scripts/audit-commercial-data.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const COMMERCIAL_FILE = path.join(DATA_DIR, 'commercial.json');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'audit', 'commercial-data-audit.json');
// S2-T1: rolling-history sibling file (mirrors check-seo-health.js's
// seo-performance-history.json pattern). Does NOT change OUTPUT_FILE's
// existing schema — a new file, written only when --write-history is passed
// (see "CLI reporting flags" below). Kept flag-gated rather than
// unconditional-on-every-run because audit-commercial-data.js's default
// (flagless) full-report path is also invoked from update-commercial.yml
// (manual-dispatch fallback); only commercial-weekly.yml's weekly cron is
// meant to advance the rolling history.
const HISTORY_FILE = path.join(DATA_DIR, 'audit', 'commercial-data-history.json');
const HISTORY_MAX_ENTRIES = 52;

// ============================================
// Constants
// ============================================

const VALID_DESIGNATIONS = [
  'Miracle', 'Windfall', 'Easy Winner', 'Trickle',
  'TBD', 'Fizzle', 'Flop', 'Nonprofit', 'Tour Stop',
];

const VALID_COST_METHODOLOGIES = [
  'reddit-standard', 'trade-reported', 'sec-filing',
  'producer-confirmed', 'deep-research', 'industry-estimate',
];

const VALID_SOURCE_TYPES = ['trade', 'reddit', 'sec', 'manual'];

// Designations that require recouped=true
const RECOUPED_DESIGNATIONS = ['Miracle', 'Windfall', 'Easy Winner', 'Trickle'];

// Designations that should have recouped=false
const NOT_RECOUPED_DESIGNATIONS = ['Fizzle', 'Flop'];

// Known nonprofit venues (partial matches)
// LCT = Lincoln Center Theater
// MTC = Manhattan Theatre Club
// Roundabout Theatre Company
// Second Stage Theater
const NONPROFIT_VENUE_PATTERNS = [
  { pattern: 'Vivian Beaumont', org: 'Lincoln Center Theater' },
  { pattern: 'Mitzi E. Newhouse', org: 'Lincoln Center Theater' },
  { pattern: 'Beaumont Theater', org: 'Lincoln Center Theater' },
  { pattern: 'American Airlines Theatre', org: 'Roundabout Theatre' },
  { pattern: 'Studio 54', org: 'Roundabout Theatre' },
  { pattern: 'Todd Haimes', org: 'Roundabout Theatre' },
  { pattern: 'Harold and Miriam Steinberg', org: 'Roundabout Theatre' },
  { pattern: 'Samuel J. Friedman', org: 'Manhattan Theatre Club' },
  { pattern: 'Helen Hayes Theater', org: 'Second Stage Theater' },
  { pattern: 'Tony Kiser', org: 'Second Stage Theater' },
];

// Financial sanity bounds
const FINANCIAL_BOUNDS = {
  minCapitalization: 500000,       // $500K minimum
  maxCapitalization: 100000000,    // $100M maximum
  minWeeklyRunningCost: 100000,    // $100K minimum
  maxWeeklyRunningCost: 5000000,   // $5M maximum
  // Cap should be at least N weeks of running cost for most shows
  minWeeksCapCoversRunCost: 3,     // Cap should cover at least 3 weeks
};

// ============================================
// Load data
// ============================================

let commercial, shows;

try {
  commercial = JSON.parse(fs.readFileSync(COMMERCIAL_FILE, 'utf8'));
} catch (e) {
  console.error('Failed to parse commercial.json:', e.message);
  process.exit(1);
}

try {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  shows = showsData.shows || showsData;
} catch (e) {
  console.error('Failed to parse shows.json:', e.message);
  process.exit(1);
}

// Build lookup maps
const showBySlug = {};
const showById = {};
for (const show of shows) {
  showBySlug[show.slug] = show;
  showById[show.id] = show;
}

const commercialEntries = Object.entries(commercial.shows);
const commercialKeys = new Set(Object.keys(commercial.shows));

// ============================================
// Shared predicates (canonical definitions -- reused by
// --list-unsourced-recouped, --list-chatgpt-sources, and --strict)
// ============================================

const BANNED_URL_SUBSTRINGS = ['chatgpt.com', 'openai.com', 'bard.google.com', 'claude.ai'];

// True when an entry claims recouped=true but has no independently
// checkable citation (recoupedSource must be a real URL, not just non-empty
// text — see scripts/lib/commercial-citation-guards.js for why).
const { isUnsourcedRecouped } = require('./lib/commercial-citation-guards');

// Returns the list of sources[] entries whose url points at a banned
// LLM-tool domain (ChatGPT/OpenAI/Bard/Claude), for a given entry.
function getBannedSources(data) {
  if (!Array.isArray(data.sources)) return [];
  return data.sources.filter(src =>
    src && typeof src.url === 'string' &&
    BANNED_URL_SUBSTRINGS.some(domain => src.url.includes(domain))
  );
}

// True when an entry has no capitalization figure. Checks ONLY
// data.capitalization itself (ship-check finding, 2026-07-19): an earlier
// version also suppressed on capitalizationSource being set, or on
// deepResearch.verifiedFields including 'capitalization' -- but neither
// guarantees a NUMBER was actually found (a source note or a "verified as
// not found" research pass could set either without capitalization ever
// being written), which would silently hide a show that still has a real
// gap. Currently 0 commercial.json entries hit that ambiguity, but the
// schema doesn't distinguish "confirmed absent" from "attempted," so
// checking capitalization directly is the only signal that can't lie.
// Stateless recompute from commercial.json every run -- no persisted
// "researched" list to drift out of sync with reality.
function needsManualResearch(data) {
  return !data.capitalization;
}

// ============================================
// CLI reporting flags (exit before the full audit runs)
// ============================================

const cliArgs = process.argv.slice(2);

if (cliArgs.includes('--list-unsourced-recouped')) {
  let count = 0;
  for (const [key, data] of commercialEntries) {
    if (!isUnsourcedRecouped(data, key)) continue;
    console.log(key);
    count++;
  }
  console.error(`${count} unsourced-recouped entries`);
  process.exit(0);
}

if (cliArgs.includes('--list-chatgpt-sources')) {
  let count = 0;
  for (const [key, data] of commercialEntries) {
    for (const src of getBannedSources(data)) {
      console.log(`${key}\t${src.url}`);
      count++;
    }
  }
  console.error(`${count} chatgpt-source entries`);
  process.exit(0);
}

if (cliArgs.includes('--list-unresearched')) {
  // Sorted by relevance: currently-open shows first (most reader-visible,
  // most actionable for the owner's next Deep Research pass), then shows
  // with an active weeklyRunningCost read (we're already tracking them
  // financially, a capitalization gap is more actionable than for a show
  // with no data at all), then alphabetically as a stable tiebreak.
  const rows = [];
  for (const [key, data] of commercialEntries) {
    if (!needsManualResearch(data)) continue;
    const show = showBySlug[key] || showById[key];
    rows.push({
      key,
      isOpen: show?.status === 'open',
      hasWeeklyCost: !!data.weeklyRunningCost,
    });
  }
  rows.sort((a, b) => {
    if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
    if (a.hasWeeklyCost !== b.hasWeeklyCost) return a.hasWeeklyCost ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
  for (const row of rows) console.log(row.key);
  console.error(`${rows.length} shows need manual research`);
  process.exit(0);
}

if (cliArgs.includes('--strict')) {
  let violationCount = 0;

  for (const [key, data] of commercialEntries) {
    if (isUnsourcedRecouped(data, key)) {
      console.error(`${key}: recouped=true with no recoupedSource and no sourced sources[].url`);
      violationCount++;
    }
    for (const src of getBannedSources(data)) {
      console.error(`${key}: sources[].url contains a banned LLM-tool domain: ${src.url}`);
      violationCount++;
    }
  }

  if (violationCount > 0) {
    console.error(`\n--strict FAILED: ${violationCount} violation(s) found.`);
    process.exit(1);
  }

  console.error('--strict PASSED: 0 violations.');
  process.exit(0);
}

// ============================================
// Issue collector
// ============================================

const issues = [];

function addIssue(type, severity, showId, detail) {
  issues.push({ type, severity, showId, detail });
}

// ============================================
// Helper: resolve show from commercial key
// ============================================

function resolveShow(key) {
  return showBySlug[key] || showById[key] || null;
}

// ============================================
// CHECK 1: Show ID mismatches / Orphan entries
// ============================================

function checkShowIdMismatches() {
  let orphanCount = 0;
  let idMatchCount = 0;
  let slugMatchCount = 0;

  for (const [key, data] of commercialEntries) {
    const bySlug = showBySlug[key];
    const byId = showById[key];

    if (bySlug) {
      slugMatchCount++;
    } else if (byId) {
      // Key matches show ID but not slug - this is the CLAUDE.md "slug matching pitfall"
      idMatchCount++;
      addIssue(
        'id-mismatch',
        'medium',
        key,
        `Commercial key "${key}" matches show ID but not slug. Show slug is "${byId.slug}". Consider renaming the key to match the slug.`
      );
    } else {
      orphanCount++;
      addIssue(
        'orphan-entry',
        'high',
        key,
        `Commercial key "${key}" not found in shows.json (neither as slug nor ID). Title in commercial: "${data.title || data.designation || 'unknown'}".`
      );
    }
  }

  return { orphanCount, idMatchCount, slugMatchCount };
}

// ============================================
// CHECK 2: Missing required fields
// ============================================

function checkMissingFields() {
  for (const [key, data] of commercialEntries) {
    // Designation is always required
    if (!data.designation) {
      addIssue('missing-field', 'high', key, 'Missing required field: designation');
    } else if (!VALID_DESIGNATIONS.includes(data.designation)) {
      addIssue('invalid-designation', 'high', key, `Invalid designation value: "${data.designation}". Valid values: ${VALID_DESIGNATIONS.join(', ')}`);
    }

    // Title is optional in commercial.json (it's in shows.json), but if present check it
    // No title check needed since commercial entries often don't have title field
  }
}

// ============================================
// CHECK 3: Designation logic
// ============================================

function checkDesignationLogic() {
  for (const [key, data] of commercialEntries) {
    if (!data.designation) continue;

    // Recouped=true but designation is Fizzle/Flop
    if (data.recouped === true && NOT_RECOUPED_DESIGNATIONS.includes(data.designation)) {
      addIssue(
        'designation-logic',
        'high',
        key,
        `recouped=true but designation is "${data.designation}". Fizzle/Flop designations should have recouped=false.`
      );
    }

    // Recouped=false but designation is Miracle/Windfall/Easy Winner/Trickle
    if (data.recouped === false && RECOUPED_DESIGNATIONS.includes(data.designation)) {
      addIssue(
        'designation-logic',
        'high',
        key,
        `recouped=false but designation is "${data.designation}". ${data.designation} implies the show recouped its investment.`
      );
    }

    // TBD designation but recouped=true (should be upgraded)
    if (data.recouped === true && data.designation === 'TBD') {
      addIssue(
        'designation-logic',
        'medium',
        key,
        `recouped=true but designation is still "TBD". Should be upgraded to Miracle/Windfall/Easy Winner/Trickle.`
      );
    }
  }
}

// ============================================
// CHECK 4: Recoupment rules
// ============================================

function checkRecoupmentRules() {
  for (const [key, data] of commercialEntries) {
    // recouped=true without recoupedDate
    if (data.recouped === true && !data.recoupedDate) {
      addIssue(
        'recoupment-rules',
        'high',
        key,
        'recouped=true but missing recoupedDate. Per CLAUDE.md, recouped=true requires recoupedDate for weeks calculation.'
      );
    }

    // recoupedDate present but recouped is not true
    if (data.recoupedDate && data.recouped !== true) {
      addIssue(
        'recoupment-rules',
        'medium',
        key,
        `recoupedDate is "${data.recoupedDate}" but recouped=${data.recouped}. If the show recouped, set recouped=true.`
      );
    }

    // Validate recoupedDate format (YYYY-MM or YYYY)
    if (data.recoupedDate) {
      const validFormat = /^\d{4}(-\d{2})?$/;
      if (!validFormat.test(data.recoupedDate)) {
        addIssue(
          'recoupment-rules',
          'high',
          key,
          `recoupedDate "${data.recoupedDate}" has invalid format. Must be YYYY-MM or YYYY.`
        );
      }
    }
  }
}

// ============================================
// CHECK 5: Source quality
// ============================================

function checkSourceQuality() {
  for (const [key, data] of commercialEntries) {
    // Skip nonprofits and tour stops - they often don't have sources
    if (data.designation === 'Nonprofit' || data.designation === 'Tour Stop') continue;

    // Check if sources array exists at all
    if (!data.sources || !Array.isArray(data.sources) || data.sources.length === 0) {
      // Only flag as low if they have substantial financial data
      if (data.capitalization || data.weeklyRunningCost) {
        addIssue(
          'source-quality',
          'low',
          key,
          'Has financial data (capitalization/weeklyRunningCost) but no structured sources array.'
        );
      }
      continue;
    }

    // Validate individual sources
    const sourceDateRegex = /^\d{4}-\d{2}-\d{2}$/;
    for (let i = 0; i < data.sources.length; i++) {
      const src = data.sources[i];

      if (!src.type) {
        addIssue('source-quality', 'medium', key, `sources[${i}] missing type field.`);
      } else if (!VALID_SOURCE_TYPES.includes(src.type)) {
        addIssue('source-quality', 'low', key, `sources[${i}].type "${src.type}" is not a recognized type (${VALID_SOURCE_TYPES.join(', ')}).`);
      }

      if (!src.url || typeof src.url !== 'string') {
        addIssue('source-quality', 'medium', key, `sources[${i}] missing or invalid url.`);
      }

      if (!src.date) {
        addIssue('source-quality', 'low', key, `sources[${i}] missing date.`);
      } else if (!sourceDateRegex.test(src.date)) {
        addIssue('source-quality', 'low', key, `sources[${i}].date "${src.date}" is not in YYYY-MM-DD format.`);
      }
    }
  }
}

// ============================================
// CHECK 6: Financial sanity
// ============================================

function checkFinancialSanity() {
  for (const [key, data] of commercialEntries) {
    // Skip nonprofits and tour stops
    if (data.designation === 'Nonprofit' || data.designation === 'Tour Stop') continue;

    const cap = data.capitalization;
    const weekly = data.weeklyRunningCost;

    // Capitalization bounds
    if (cap !== null && cap !== undefined) {
      if (typeof cap !== 'number') {
        addIssue('financial-sanity', 'high', key, `capitalization is type ${typeof cap}, expected number.`);
      } else {
        if (cap < 0) {
          addIssue('financial-sanity', 'high', key, `capitalization is negative: $${cap.toLocaleString()}.`);
        } else if (cap > 0 && cap < FINANCIAL_BOUNDS.minCapitalization) {
          addIssue('financial-sanity', 'medium', key, `capitalization $${cap.toLocaleString()} is unusually low for a Broadway show (minimum expected: $${FINANCIAL_BOUNDS.minCapitalization.toLocaleString()}).`);
        } else if (cap > FINANCIAL_BOUNDS.maxCapitalization) {
          addIssue('financial-sanity', 'medium', key, `capitalization $${cap.toLocaleString()} is unusually high (maximum expected: $${FINANCIAL_BOUNDS.maxCapitalization.toLocaleString()}).`);
        }
      }
    }

    // Weekly running cost bounds
    if (weekly !== null && weekly !== undefined) {
      if (typeof weekly !== 'number') {
        addIssue('financial-sanity', 'high', key, `weeklyRunningCost is type ${typeof weekly}, expected number.`);
      } else {
        if (weekly < 0) {
          addIssue('financial-sanity', 'high', key, `weeklyRunningCost is negative: $${weekly.toLocaleString()}.`);
        } else if (weekly > 0 && weekly < FINANCIAL_BOUNDS.minWeeklyRunningCost) {
          addIssue('financial-sanity', 'low', key, `weeklyRunningCost $${weekly.toLocaleString()} is unusually low (minimum expected: $${FINANCIAL_BOUNDS.minWeeklyRunningCost.toLocaleString()}).`);
        } else if (weekly > FINANCIAL_BOUNDS.maxWeeklyRunningCost) {
          addIssue('financial-sanity', 'medium', key, `weeklyRunningCost $${weekly.toLocaleString()} is unusually high (maximum expected: $${FINANCIAL_BOUNDS.maxWeeklyRunningCost.toLocaleString()}).`);
        }
      }
    }

    // Cap vs weekly running cost ratio
    if (cap && weekly && typeof cap === 'number' && typeof weekly === 'number' && cap > 0 && weekly > 0) {
      const weeksCapCovers = cap / weekly;
      if (weeksCapCovers < FINANCIAL_BOUNDS.minWeeksCapCoversRunCost) {
        addIssue(
          'financial-sanity',
          'high',
          key,
          `capitalization ($${cap.toLocaleString()}) covers only ${weeksCapCovers.toFixed(1)} weeks of running costs ($${weekly.toLocaleString()}/week). This seems impossibly low.`
        );
      }
    }

    // weeklyRunningCostRange validation
    if (data.weeklyRunningCostRange) {
      const range = data.weeklyRunningCostRange;
      if (typeof range !== 'object' || range === null) {
        addIssue('financial-sanity', 'low', key, 'weeklyRunningCostRange is not an object.');
      } else {
        if (range.min !== undefined && range.max !== undefined) {
          if (range.min > range.max) {
            addIssue('financial-sanity', 'medium', key, `weeklyRunningCostRange min ($${range.min}) > max ($${range.max}).`);
          }
          if (weekly && (weekly < range.min || weekly > range.max)) {
            addIssue('financial-sanity', 'low', key, `weeklyRunningCost ($${weekly}) is outside weeklyRunningCostRange [$${range.min}, $${range.max}].`);
          }
        }
      }
    }

    // profitMargin validation
    if (data.profitMargin !== undefined && data.profitMargin !== null) {
      if (typeof data.profitMargin !== 'number') {
        addIssue('financial-sanity', 'medium', key, `profitMargin is type ${typeof data.profitMargin}, expected number.`);
      }
    }

    // investorMultiple validation
    if (data.investorMultiple !== undefined && data.investorMultiple !== null) {
      if (typeof data.investorMultiple !== 'number') {
        addIssue('financial-sanity', 'medium', key, `investorMultiple is type ${typeof data.investorMultiple}, expected number.`);
      } else if (data.investorMultiple < 0) {
        addIssue('financial-sanity', 'high', key, `investorMultiple is negative: ${data.investorMultiple}.`);
      } else if (data.investorMultiple > 100) {
        addIssue('financial-sanity', 'low', key, `investorMultiple is ${data.investorMultiple}x. This is exceptionally high -- verify.`);
      }
    }
  }
}

// ============================================
// CHECK 7: Methodology consistency
// ============================================

function checkMethodologyConsistency() {
  for (const [key, data] of commercialEntries) {
    if (data.costMethodology) {
      if (!VALID_COST_METHODOLOGIES.includes(data.costMethodology)) {
        addIssue(
          'methodology',
          'medium',
          key,
          `Invalid costMethodology: "${data.costMethodology}". Valid: ${VALID_COST_METHODOLOGIES.join(', ')}.`
        );
      }
    }

    // If has deep research but methodology is low quality
    if (data.deepResearch && data.costMethodology === 'reddit-standard') {
      addIssue(
        'methodology',
        'low',
        key,
        'Has deepResearch verification but costMethodology is still "reddit-standard". Consider upgrading to "deep-research".'
      );
    }
  }
}

// ============================================
// CHECK 8: Stale data for open shows
// ============================================

function checkStaleData() {
  const now = new Date();
  const STALE_THRESHOLD_DAYS = 90; // 3 months

  for (const [key, data] of commercialEntries) {
    const show = resolveShow(key);
    if (!show || show.status !== 'open') continue;

    if (data.lastUpdated) {
      const lastUpdated = new Date(data.lastUpdated);
      if (isNaN(lastUpdated.getTime())) {
        addIssue('stale-data', 'low', key, `lastUpdated "${data.lastUpdated}" is not a valid date.`);
        continue;
      }

      const daysSince = Math.floor((now - lastUpdated) / (1000 * 60 * 60 * 24));
      if (daysSince > STALE_THRESHOLD_DAYS) {
        addIssue(
          'stale-data',
          'low',
          key,
          `Open show with stale data: lastUpdated is "${data.lastUpdated}" (${daysSince} days ago, threshold: ${STALE_THRESHOLD_DAYS} days).`
        );
      }
    }

    // Check estimatedRecoupmentDate staleness for TBD shows
    if (data.designation === 'TBD' && data.estimatedRecoupmentDate) {
      const estDate = new Date(data.estimatedRecoupmentDate);
      if (!isNaN(estDate.getTime())) {
        const daysSince = Math.floor((now - estDate) / (1000 * 60 * 60 * 24));
        if (daysSince > STALE_THRESHOLD_DAYS) {
          addIssue(
            'stale-data',
            'low',
            key,
            `TBD show with stale recoupment estimate: estimatedRecoupmentDate is "${data.estimatedRecoupmentDate}" (${daysSince} days ago).`
          );
        }
      }
    }
  }
}

// ============================================
// CHECK 9: Deep research integrity
// ============================================

function checkDeepResearchIntegrity() {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

  for (const [key, data] of commercialEntries) {
    if (!data.deepResearch) continue;

    const dr = data.deepResearch;

    // Empty verifiedFields array (CLAUDE.md says this is invalid)
    if (Array.isArray(dr.verifiedFields) && dr.verifiedFields.length === 0) {
      addIssue(
        'deep-research-integrity',
        'high',
        key,
        'deepResearch.verifiedFields is an empty array. Per CLAUDE.md, this is invalid -- omit the deepResearch block entirely if no fields are verified.'
      );
    }

    // verifiedFields not an array
    if (dr.verifiedFields !== undefined && !Array.isArray(dr.verifiedFields)) {
      addIssue(
        'deep-research-integrity',
        'high',
        key,
        `deepResearch.verifiedFields is type ${typeof dr.verifiedFields}, must be an array.`
      );
    }

    // Missing verifiedDate
    if (!dr.verifiedDate) {
      addIssue(
        'deep-research-integrity',
        'medium',
        key,
        'deepResearch block missing verifiedDate.'
      );
    } else if (!dateRegex.test(dr.verifiedDate)) {
      addIssue(
        'deep-research-integrity',
        'medium',
        key,
        `deepResearch.verifiedDate "${dr.verifiedDate}" is not in YYYY-MM-DD format.`
      );
    }

    // verifiedFields references fields that don't exist on the entry
    if (Array.isArray(dr.verifiedFields)) {
      const knownFields = new Set([
        'designation', 'capitalization', 'weeklyRunningCost', 'recouped',
        'recoupedDate', 'recoupedWeeks', 'estimatedRecoupmentPct',
        'profitMargin', 'investorMultiple', 'insiderProfitSharePct',
        'sources', 'notes', 'costMethodology',
      ]);
      for (const field of dr.verifiedFields) {
        if (typeof field !== 'string') {
          addIssue('deep-research-integrity', 'low', key, `deepResearch.verifiedFields contains non-string: ${JSON.stringify(field)}.`);
        }
        // Don't flag unknown field names -- they might be custom/future fields
      }
    }
  }
}

// ============================================
// CHECK 10: Closed show designation TBD
// ============================================

function checkClosedShowTBD() {
  for (const [key, data] of commercialEntries) {
    if (data.designation !== 'TBD') continue;

    const show = resolveShow(key);
    if (!show) continue;

    if (show.status === 'closed') {
      // How long ago did it close?
      let closedAgo = '';
      if (show.closingDate) {
        const closingDate = new Date(show.closingDate);
        const now = new Date();
        const daysSince = Math.floor((now - closingDate) / (1000 * 60 * 60 * 24));
        closedAgo = ` (closed ${daysSince} days ago on ${show.closingDate})`;
      }

      addIssue(
        'closed-show-tbd',
        'medium',
        key,
        `Show is closed${closedAgo} but still designated "TBD". Should be resolved to a final designation (Miracle/Windfall/Easy Winner/Trickle/Fizzle/Flop).`
      );
    }
  }
}

// ============================================
// CHECK 11: Nonprofit classification
// ============================================

function checkNonprofitClassification() {
  // Check shows at known nonprofit venues that aren't designated Nonprofit
  for (const [key, data] of commercialEntries) {
    const show = resolveShow(key);
    if (!show || !show.venue) continue;

    for (const { pattern, org } of NONPROFIT_VENUE_PATTERNS) {
      if (show.venue.includes(pattern)) {
        if (data.designation !== 'Nonprofit') {
          addIssue(
            'nonprofit-classification',
            'low',
            key,
            `Show is at "${show.venue}" (${org} venue) but designation is "${data.designation}" instead of "Nonprofit". This may be correct for commercial co-productions -- verify.`
          );
        }
        break;
      }
    }
  }

  // Also check: Nonprofit designation for shows NOT at nonprofit venues
  for (const [key, data] of commercialEntries) {
    if (data.designation !== 'Nonprofit') continue;

    const show = resolveShow(key);
    if (!show || !show.venue) continue;

    const isAtNonprofitVenue = NONPROFIT_VENUE_PATTERNS.some(({ pattern }) =>
      show.venue.includes(pattern)
    );

    if (!isAtNonprofitVenue) {
      addIssue(
        'nonprofit-classification',
        'low',
        key,
        `Designated "Nonprofit" but venue "${show.venue}" is not a recognized nonprofit venue. Verify this is correct.`
      );
    }
  }
}

// ============================================
// CHECK 12: estimatedRecoupmentPct sanity
// ============================================

function checkEstimatedRecoupmentPct() {
  for (const [key, data] of commercialEntries) {
    if (!data.estimatedRecoupmentPct) continue;

    if (!Array.isArray(data.estimatedRecoupmentPct) || data.estimatedRecoupmentPct.length !== 2) {
      addIssue(
        'recoupment-pct',
        'medium',
        key,
        `estimatedRecoupmentPct must be a [low, high] array, got: ${JSON.stringify(data.estimatedRecoupmentPct)}.`
      );
      continue;
    }

    const [low, high] = data.estimatedRecoupmentPct;

    if (typeof low !== 'number' || typeof high !== 'number') {
      addIssue('recoupment-pct', 'medium', key, `estimatedRecoupmentPct values must be numbers, got [${typeof low}, ${typeof high}].`);
      continue;
    }

    if (low < 0) {
      addIssue('recoupment-pct', 'high', key, `estimatedRecoupmentPct low value is negative: ${low}.`);
    }

    if (high > 200) {
      addIssue('recoupment-pct', 'medium', key, `estimatedRecoupmentPct high value is ${high}% -- unusually high. Verify.`);
    }

    if (low > high) {
      addIssue('recoupment-pct', 'high', key, `estimatedRecoupmentPct low (${low}) > high (${high}).`);
    }

    // Recouped shows shouldn't have estimatedRecoupmentPct < 100
    if (data.recouped === true && high < 100) {
      addIssue(
        'recoupment-pct',
        'medium',
        key,
        `recouped=true but estimatedRecoupmentPct high is only ${high}%. If recouped, pct should be >= 100.`
      );
    }

    // Not recouped but pct >= 100
    if (data.recouped === false && low >= 100) {
      addIssue(
        'recoupment-pct',
        'medium',
        key,
        `recouped=false but estimatedRecoupmentPct low is ${low}%. If pct >= 100, the show should have recouped.`
      );
    }

    // Fizzle should be ~30-99%, Flop should be ~0-29%
    if (data.designation === 'Fizzle' && high < 20) {
      addIssue(
        'recoupment-pct',
        'low',
        key,
        `Designation is "Fizzle" but estimatedRecoupmentPct is [${low}, ${high}]%. Fizzle typically implies 30%+ recovery. Consider "Flop" if <30%.`
      );
    }

    if (data.designation === 'Flop' && low > 40) {
      addIssue(
        'recoupment-pct',
        'low',
        key,
        `Designation is "Flop" but estimatedRecoupmentPct is [${low}, ${high}]%. Flop typically implies <30% recovery. Consider "Fizzle" if 30%+.`
      );
    }
  }
}

// ============================================
// CHECK 13: Open show coverage
// ============================================

function checkOpenShowCoverage() {
  const openShows = shows.filter(s => s.status === 'open' || s.status === 'previews');
  const withCommercial = [];
  const withoutCommercial = [];

  for (const show of openShows) {
    if (commercialKeys.has(show.slug)) {
      withCommercial.push(show);
    } else {
      withoutCommercial.push(show);
    }
  }

  // Report each missing open show
  for (const show of withoutCommercial) {
    addIssue(
      'coverage-gap',
      'low',
      show.slug,
      `Open/previews show "${show.title}" at ${show.venue || 'unknown venue'} has no commercial data entry.`
    );
  }

  return { total: openShows.length, covered: withCommercial.length, missing: withoutCommercial.length };
}

// ============================================
// CHECK 14: Tour Stop cross-validation
// ============================================

function checkTourStopConsistency() {
  for (const [key, data] of commercialEntries) {
    if (data.designation === 'Tour Stop') {
      if (data.productionType && data.productionType !== 'tour-stop' && data.productionType !== 'return-engagement') {
        addIssue(
          'tour-stop',
          'medium',
          key,
          `Designation is "Tour Stop" but productionType is "${data.productionType}". Should be "tour-stop" or "return-engagement".`
        );
      }
      if (!data.productionType) {
        addIssue(
          'tour-stop',
          'low',
          key,
          'Designation is "Tour Stop" but missing productionType field (should be "tour-stop" or "return-engagement").'
        );
      }
      if (data.originalProductionId && !commercial.shows[data.originalProductionId]) {
        addIssue(
          'tour-stop',
          'medium',
          key,
          `originalProductionId "${data.originalProductionId}" does not exist in commercial.json.`
        );
      }
    }

    // Reverse: productionType is tour-stop but designation is not Tour Stop
    if (data.productionType === 'tour-stop' && data.designation !== 'Tour Stop') {
      addIssue(
        'tour-stop',
        'medium',
        key,
        `productionType is "tour-stop" but designation is "${data.designation}". Should be "Tour Stop".`
      );
    }
  }
}

// ============================================
// CHECK 15: Deprecated field warnings
// ============================================

function checkDeprecatedFields() {
  for (const [key, data] of commercialEntries) {
    // recoupedWeeks is deprecated per _meta.notes
    if (data.recoupedWeeks !== undefined && data.recoupedWeeks !== null) {
      addIssue(
        'deprecated-field',
        'low',
        key,
        `Has deprecated "recoupedWeeks" field (value: ${data.recoupedWeeks}). This is now calculated dynamically from openingDate + recoupedDate.`
      );
    }
  }
}

// ============================================
// CHECK 16: Recoupment trade press citation
// ============================================

function checkRecoupmentCitations() {
  for (const [key, data] of commercialEntries) {
    if (data.recouped !== true) continue;

    // Per CLAUDE.md: "Never mark recouped: true without trade press citation"
    const hasRecoupedSource = !!data.recoupedSource;
    const hasTradeSource = data.sources && Array.isArray(data.sources) &&
      data.sources.some(s => s.type === 'trade' || s.type === 'sec');
    const hasDeepResearch = data.deepResearch && Array.isArray(data.deepResearch.verifiedFields) &&
      data.deepResearch.verifiedFields.includes('recouped');

    if (!hasRecoupedSource && !hasTradeSource && !hasDeepResearch) {
      addIssue(
        'recoupment-citation',
        'medium',
        key,
        'recouped=true but no trade press citation found (no recoupedSource, no trade/sec sources, and deepResearch does not verify "recouped").'
      );
    }
  }
}

// ============================================
// CHECK: Model false-negatives vs announced recoupment (regression metric)
// ============================================
// Producer announcements are ground truth (owner decision 2026-07-13, task #140).
// Every recouped=true show where modelRecouped=false is a model false-negative:
// the render layer suppresses the model on that show's card, and the same
// failure mode degrades estimates on shows with no announcement. Baseline is
// 2 known disagreements (our-town, leopoldstadt-2022, as of 2026-07-13);
// anything above that flags HIGH so growth surfaces loudly in the digest.

const MODEL_FALSE_NEGATIVE_BASELINE = 2;

function checkModelFalseNegatives() {
  const disagreements = commercialEntries.filter(([, d]) =>
    d.recouped === true && d.modelRecouped === false);
  const severity = disagreements.length > MODEL_FALSE_NEGATIVE_BASELINE ? 'high' : 'low';
  for (const [key, d] of disagreements) {
    const range = Array.isArray(d.modelRecoupmentPct) ? d.modelRecoupmentPct.join('–') + '%' : 'n/a';
    addIssue(
      'model-false-negative',
      severity,
      key,
      `Announced recouped (${d.recoupedDate || 'no date'}) but modelRecouped=false (range ${range}). ` +
      `Count ${disagreements.length} vs baseline ${MODEL_FALSE_NEGATIVE_BASELINE} — diagnose model inputs if this grows.`
    );
  }
  return {
    count: disagreements.length,
    baseline: MODEL_FALSE_NEGATIVE_BASELINE,
    shows: disagreements.map(([key]) => key),
  };
}

// ============================================
// Rolling history (S2-T1)
// ============================================
// Mirrors scripts/check-seo-health.js's loadHistory()/saveSnapshot() pattern:
// history.push({...}) then cap at HISTORY_MAX_ENTRIES, oldest dropped first.

function loadCommercialHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

// modelDesignationFlag is a free-text contradiction note (set by
// merge-model-recoupment.js) when the recoupment model's implied % disagrees
// with the human-set designation, e.g. "Model: 364% vs designation: Trickle".
function computeModelDesignationFlags() {
  const flagged = commercialEntries
    .filter(([, data]) => !!data.modelDesignationFlag)
    .map(([key, data]) => ({ show: key, flag: data.modelDesignationFlag }));
  return { count: flagged.length, entries: flagged };
}

function computeModelMethodBreakdown() {
  const breakdown = {};
  for (const [, data] of commercialEntries) {
    const method = data.modelMethod || 'missing';
    breakdown[method] = (breakdown[method] || 0) + 1;
  }
  return breakdown;
}

function computeAiEstimatedShows() {
  return commercialEntries
    .filter(([, data]) => data.modelMethod === 'ai-estimated')
    .map(([key]) => key)
    .sort();
}

function saveCommercialHistory() {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const history = loadCommercialHistory();
  const priorEntry = history.length > 0 ? history[history.length - 1] : null;
  const priorAiEstimated = new Set(priorEntry?.aiEstimatedShows || []);

  const modelDesignationFlags = computeModelDesignationFlags();
  const modelMethodBreakdown = computeModelMethodBreakdown();
  const aiEstimatedShows = computeAiEstimatedShows();
  const currentAiEstimated = new Set(aiEstimatedShows);

  // Week-over-week ai-estimated tier churn: shows that newly appeared in
  // (entered) or left (exited) the ai-estimated tier vs the previous entry.
  const aiEstimatedEntered = aiEstimatedShows.filter(s => !priorAiEstimated.has(s));
  const aiEstimatedExited = [...priorAiEstimated].filter(s => !currentAiEstimated.has(s)).sort();

  history.push({
    date: new Date().toISOString(),
    modelDesignationFlagCount: modelDesignationFlags.count,
    modelDesignationFlags: modelDesignationFlags.entries,
    modelMethodBreakdown,
    aiEstimatedCount: aiEstimatedShows.length,
    aiEstimatedShows,
    aiEstimatedEntered,
    aiEstimatedExited,
  });
  while (history.length > HISTORY_MAX_ENTRIES) history.shift();

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n');
  console.log(`Saved commercial model history (${history.length} entries) to ${HISTORY_FILE}`);
  return history;
}

// ============================================
// RUN ALL CHECKS
// ============================================

console.log('Running commercial data audit...\n');

const matchStats = checkShowIdMismatches();
checkMissingFields();
checkDesignationLogic();
checkRecoupmentRules();
checkSourceQuality();
checkFinancialSanity();
checkMethodologyConsistency();
checkStaleData();
checkDeepResearchIntegrity();
checkClosedShowTBD();
checkNonprofitClassification();
checkEstimatedRecoupmentPct();
const coverageStats = checkOpenShowCoverage();
checkTourStopConsistency();
checkDeprecatedFields();
checkRecoupmentCitations();
const modelFnStats = checkModelFalseNegatives();

// ============================================
// Build summary
// ============================================

const designationDistribution = {};
for (const [, data] of commercialEntries) {
  const d = data.designation || 'MISSING';
  designationDistribution[d] = (designationDistribution[d] || 0) + 1;
}

const issuesBySeverity = { high: 0, medium: 0, low: 0 };
const issuesByType = {};
for (const issue of issues) {
  issuesBySeverity[issue.severity]++;
  issuesByType[issue.type] = (issuesByType[issue.type] || 0) + 1;
}

const recoupedCount = commercialEntries.filter(([, d]) => d.recouped === true).length;
const notRecoupedCount = commercialEntries.filter(([, d]) => d.recouped === false).length;
const recoupedNullCount = commercialEntries.filter(([, d]) => d.recouped === null || d.recouped === undefined).length;
const hasDeepResearch = commercialEntries.filter(([, d]) => d.deepResearch).length;
const hasCapitalization = commercialEntries.filter(([, d]) => d.capitalization && typeof d.capitalization === 'number' && d.capitalization > 0).length;
const hasWeeklyRunningCost = commercialEntries.filter(([, d]) => d.weeklyRunningCost && typeof d.weeklyRunningCost === 'number' && d.weeklyRunningCost > 0).length;
const hasSources = commercialEntries.filter(([, d]) => d.sources && Array.isArray(d.sources) && d.sources.length > 0).length;
const hasCostMethodology = commercialEntries.filter(([, d]) => d.costMethodology).length;

const report = {
  _meta: {
    description: 'Commercial data audit report',
    generatedAt: new Date().toISOString(),
    scriptVersion: '1.0.0',
  },
  summary: {
    totalEntries: commercialEntries.length,
    totalShowsInShowsJson: shows.length,
    matchStats: {
      matchedBySlug: matchStats.slugMatchCount,
      matchedById: matchStats.idMatchCount,
      orphaned: matchStats.orphanCount,
    },
    designationDistribution,
    recoupmentStats: {
      recouped: recoupedCount,
      notRecouped: notRecoupedCount,
      nullOrMissing: recoupedNullCount,
    },
    modelFalseNegatives: modelFnStats,
    dataCompleteness: {
      hasCapitalization,
      hasWeeklyRunningCost,
      hasCostMethodology,
      hasSources,
      hasDeepResearch,
    },
    openShowCoverage: {
      totalOpenPreviewsShows: coverageStats.total,
      withCommercialData: coverageStats.covered,
      withoutCommercialData: coverageStats.missing,
      coveragePct: coverageStats.total > 0
        ? Math.round((coverageStats.covered / coverageStats.total) * 100)
        : 0,
    },
    issuesSummary: {
      total: issues.length,
      bySeverity: issuesBySeverity,
      byType: issuesByType,
    },
  },
  issues,
};

// ============================================
// Write output
// ============================================

const auditDir = path.dirname(OUTPUT_FILE);
if (!fs.existsSync(auditDir)) {
  fs.mkdirSync(auditDir, { recursive: true });
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2) + '\n');

// S2-T1/S2-T2: rolling history — only advanced when explicitly requested
// (commercial-weekly.yml's weekly cron), so ad hoc/manual full-report runs
// elsewhere (e.g. update-commercial.yml's dispatch fallback) don't pollute
// the weekly cadence. See HISTORY_FILE comment above for why this is
// flag-gated rather than unconditional.
if (cliArgs.includes('--write-history')) {
  saveCommercialHistory();
}

// ============================================
// Print summary
// ============================================

console.log('='.repeat(60));
console.log('COMMERCIAL DATA AUDIT REPORT');
console.log('='.repeat(60));
console.log('');
console.log(`Total commercial entries: ${commercialEntries.length}`);
console.log(`Total shows in shows.json: ${shows.length}`);
console.log('');

console.log('--- Match Stats ---');
console.log(`  Matched by slug: ${matchStats.slugMatchCount}`);
console.log(`  Matched by ID (slug mismatch): ${matchStats.idMatchCount}`);
console.log(`  Orphaned (not in shows.json): ${matchStats.orphanCount}`);
console.log('');

console.log('--- Designation Distribution ---');
for (const [d, count] of Object.entries(designationDistribution).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${d}: ${count}`);
}
console.log('');

console.log('--- Recoupment Stats ---');
console.log(`  Recouped: ${recoupedCount}`);
console.log(`  Not recouped: ${notRecoupedCount}`);
console.log(`  Null/missing: ${recoupedNullCount}`);
console.log('');

console.log('--- Data Completeness ---');
console.log(`  With capitalization: ${hasCapitalization}/${commercialEntries.length}`);
console.log(`  With weekly running cost: ${hasWeeklyRunningCost}/${commercialEntries.length}`);
console.log(`  With cost methodology: ${hasCostMethodology}/${commercialEntries.length}`);
console.log(`  With structured sources: ${hasSources}/${commercialEntries.length}`);
console.log(`  With deep research: ${hasDeepResearch}/${commercialEntries.length}`);
console.log('');

console.log('--- Open Show Coverage ---');
console.log(`  Open/previews shows: ${coverageStats.total}`);
console.log(`  With commercial data: ${coverageStats.covered} (${report.summary.openShowCoverage.coveragePct}%)`);
console.log(`  Missing commercial data: ${coverageStats.missing}`);
console.log('');

console.log('--- Model vs Announced Recoupment ---');
console.log(`  Model false negatives (recouped=true, modelRecouped=false): ${modelFnStats.count} (baseline ${modelFnStats.baseline})`);
if (modelFnStats.shows.length > 0) {
  console.log(`  Shows: ${modelFnStats.shows.join(', ')}`);
}
console.log('');

console.log('--- Issues ---');
console.log(`  Total: ${issues.length}`);
console.log(`  HIGH: ${issuesBySeverity.high}`);
console.log(`  MEDIUM: ${issuesBySeverity.medium}`);
console.log(`  LOW: ${issuesBySeverity.low}`);
console.log('');

if (issuesBySeverity.high > 0) {
  console.log('--- HIGH SEVERITY ISSUES ---');
  for (const issue of issues.filter(i => i.severity === 'high')) {
    console.log(`  [${issue.type}] ${issue.showId}: ${issue.detail}`);
  }
  console.log('');
}

if (issuesBySeverity.medium > 0) {
  console.log('--- MEDIUM SEVERITY ISSUES ---');
  for (const issue of issues.filter(i => i.severity === 'medium')) {
    console.log(`  [${issue.type}] ${issue.showId}: ${issue.detail}`);
  }
  console.log('');
}

console.log(`Report written to: ${OUTPUT_FILE}`);
