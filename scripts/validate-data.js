#!/usr/bin/env node
/**
 * validate-data.js
 *
 * Comprehensive data validation for Broadway Scorecard.
 * Runs automatically in CI to catch issues before they reach production.
 *
 * Checks:
 * 1. JSON is valid and parseable
 * 2. No duplicate shows (using deduplication module)
 * 3. Required fields present on all shows
 * 4. Data format validation (dates, slugs, URLs)
 * 5. Logical consistency (status vs dates)
 * 6. Catastrophic change detection
 *
 * Usage: node scripts/validate-data.js [--strict]
 * Exit codes: 0 = OK, 1 = Errors found
 */

const fs = require('fs');
const path = require('path');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

// Canonical "would rebuild include this review-text file?" predicate, shared
// with scripts/check-review-count-drift.js so both stay in sync. isIncludable
// ForRebuild is the flag/context filter; hasValidScore is the score-presence
// half. (Sprint 1 unification — the the deleted scoreable-mirror mirror is deleted.)
const { isIncludableForRebuild, hasValidScore } = require('./lib/review-guards');

// Canonical valid-tier list — propagates when TIER_WEIGHTS changes.
const { VALID_TIERS } = require('./lib/outlet-tiers');
const { buildOutletMaps } = require('./lib/outlet-region-map');
const { previewsAfterOpening, excessivePreviewGap, inheritedDateFromSibling, suspiciousInheritedYear, normTitle } = require('./lib/show-date-integrity');

// Canonical Broadway-category predicate. Treats null category as Broadway
// per historical-import convention; use this instead of raw string compare.
const { isBroadwayCategory } = require('./lib/venue-classification');
const { classifyReverseCrossMarket, classifyUsOnWeCrossMarket } = require('./lib/cross-market-guard');
const { earliestShowDate, evaluatePreWindowInclusion } = require('./lib/date-guard');
const { listShowDirs } = require('./lib/list-show-dirs');
const { detectRefusalPattern } = require('./lib/synopsis-validation');
const { openingDateSourceHint } = require('./lib/opening-date-sources');
const { isNonTheatricalGenre } = require('./lib/genre-classification');
const { looksLikeUrlCriticName } = require('./lib/byline-normalization');
const { hasUndecodedHtmlEntities, hasJsonLdArtifact } = require('./lib/text-cleaning');

// Notion 362637c5-416f-8174 — sentinel file consumed by .github/actions/push-core-data
// to refuse pushing when validation failed. The composite action used `if: always()`
// across 64 workflows, which meant validate-data.js exit-1 didn't prevent corrupt rows
// from reaching the private repo. The sentinel lets every caller opt-in to gated pushes
// without per-workflow edits: any workflow that runs validate-data.js before push-core-data
// is now automatically protected. Workflows that don't validate are unaffected.
//
// Path: prefer RUNNER_TEMP (GitHub Actions per-runner temp, isolated between jobs);
// fall back to /tmp for local dev. Composite action mirrors this fallback logic.
const PUSH_REFUSAL_SENTINEL = path.join(
  process.env.RUNNER_TEMP || '/tmp',
  '.skip-push-core-data'
);
function writePushRefusalSentinel(reason) {
  try {
    fs.writeFileSync(PUSH_REFUSAL_SENTINEL,
      `validate-data.js refused push at ${new Date().toISOString()}\nreason: ${reason}\n`);
  } catch (e) {
    // Non-fatal: if temp dir isn't writable we can't gate, but the script still exits 1.
    console.error(`Could not write push refusal sentinel at ${PUSH_REFUSAL_SENTINEL}: ${e.message}`);
  }
}
function clearPushRefusalSentinel() {
  try {
    if (fs.existsSync(PUSH_REFUSAL_SENTINEL)) fs.unlinkSync(PUSH_REFUSAL_SENTINEL);
  } catch (_) { /* non-fatal */ }
}
// Single exit-with-error path so every error site reaches the sentinel — not just the
// late "summary errors" path. Codex found 2 early process.exit(1) sites that bypassed
// the sentinel (missing shows.json + parse error). Route them through this.
function exitWithError(reason) {
  writePushRefusalSentinel(reason);
  process.exit(1);
}
// Also catch unexpected crashes — uncaughtException doesn't fire on process.exit, but it
// does fire on throws. Belt-and-suspenders against future code paths that throw without
// reaching the summary block.
process.on('uncaughtException', (err) => {
  writePushRefusalSentinel(`uncaughtException: ${err.message}`);
  console.error(err);
  process.exit(1);
});

// Stuck-vs-fresh classification for pending-score gap records.
// Extracted + unit-tested in tests/unit/pending-gap-classification.test.mjs.
const { classifyPendingGapsByAge, DEFAULT_STUCK_PENDING_DAYS } = require('./lib/pending-gap-classification');

// Import deduplication module for duplicate detection
const { isLondonMarket, isWestEndVenue, isOffWestEndVenue } = require('./lib/venue-classification');
const { VENUE_ADDRESSES } = require('./lib/venue-addresses');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `validate-data.js — Comprehensive data validation for Broadway Scorecard.

Usage:
  node scripts/validate-data.js [options]
  node scripts/validate-data.js --help, -h    print this usage and exit
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
let checkForDuplicate;
try {
  const dedup = require('./lib/deduplication');
  checkForDuplicate = dedup.checkForDuplicate;
} catch (e) {
  console.warn('Deduplication module not found, using basic duplicate check');
  checkForDuplicate = null;
}

// Import review normalization for critic-outlet validation
let normalizeCritic, normalizeOutlet, validateCriticOutlet;
try {
  const normalization = require('./lib/review-normalization');
  normalizeCritic = normalization.normalizeCritic;
  normalizeOutlet = normalization.normalizeOutlet;
  validateCriticOutlet = normalization.validateCriticOutlet;
} catch (e) {
  console.warn('Review normalization module not found, skipping critic-outlet validation');
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const GROSSES_FILE = path.join(DATA_DIR, 'grosses.json');
const SCHEDULES_FILE = path.join(DATA_DIR, 'show-schedules.json');
const COMMERCIAL_FILE = path.join(DATA_DIR, 'commercial.json');
const BASELINE_FILE = path.join(DATA_DIR, 'audit', 'validation-baseline.json');

const strictMode = process.argv.includes('--strict');

// Hardcoded fallback thresholds (used only if baseline file doesn't exist)
const FALLBACK_THRESHOLDS = {
  MIN_TOTAL_SHOWS: 30,
  MIN_OPEN_SHOWS: 15,
};

// Maximum allowed decline from baseline before flagging as error
const MAX_DECLINE_PCT = 0.25;  // 25% for shows
const MAX_REVIEW_DECLINE_PCT = 0.10;  // 10% for reviews

// Load previous baseline if available
let baseline = null;
try {
  if (fs.existsSync(BASELINE_FILE)) {
    baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  }
} catch (e) {
  // Baseline file corrupt or unreadable, use fallback
}

// Safety thresholds
const THRESHOLDS = {
  MAX_DELETED_SHOWS: 0,
  REQUIRED_FIELDS: ['id', 'title', 'slug', 'status'],
  REQUIRED_FIELDS_OPEN: ['id', 'title', 'slug', 'status', 'venue'],
};

let errors = [];
let warnings = [];

function error(msg) {
  errors.push(msg);
  console.error(`❌ ERROR: ${msg}`);
}

function warn(msg) {
  warnings.push(msg);
  console.warn(`⚠️  WARNING: ${msg}`);
}

function ok(msg) {
  console.log(`✅ ${msg}`);
}

function info(msg) {
  console.log(`ℹ️  ${msg}`);
}

// ===========================================
// DUPLICATE DETECTION
// ===========================================

function validateNoDuplicates(shows) {
  info('Checking for duplicate shows...');

  // Exclude _devOnly test shows — they intentionally share IDs/slugs/titles with
  // real shows for Express E2E pipeline testing and must not fail production validation.
  shows = shows.filter(s => !s._devOnly);

  // Check duplicate IDs
  const ids = shows.map(s => s.id);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupIds.length > 0) {
    error(`Duplicate show IDs: ${[...new Set(dupIds)].join(', ')}`);
  } else {
    ok('No duplicate IDs');
  }

  // Check duplicate slugs
  const slugs = shows.map(s => s.slug);
  const dupSlugs = slugs.filter((slug, i) => slugs.indexOf(slug) !== i);
  if (dupSlugs.length > 0) {
    error(`Duplicate slugs: ${[...new Set(dupSlugs)].join(', ')}`);
  } else {
    ok('No duplicate slugs');
  }

  // Regional→Broadway transfer pairs: transferOf (on the Broadway show) and
  // transferredTo (on the regional tryout) must reference existing shows AND
  // point back at each other — a dangling or one-way link renders a dead
  // cross-link chip on the show page.
  {
    const byId = new Map(shows.map(s => [s.id, s]));
    let transferIssues = 0;
    for (const s of shows) {
      for (const [field, reciprocal] of [['transferOf', 'transferredTo'], ['transferredTo', 'transferOf']]) {
        const ref = s[field];
        if (ref === undefined || ref === null) continue;
        const target = byId.get(ref);
        if (!target) {
          error(`Show "${s.id}" ${field} "${ref}" does not reference an existing show`);
          transferIssues++;
        } else if (ref === s.id) {
          error(`Show "${s.id}" ${field} points at itself`);
          transferIssues++;
        } else if (target[reciprocal] !== s.id) {
          error(`Show "${s.id}" ${field} "${ref}" is not reciprocated — "${ref}" must set ${reciprocal}: "${s.id}"`);
          transferIssues++;
        } else if (field === 'transferOf' && target.category !== 'regional') {
          error(`Show "${s.id}" transferOf "${ref}" must point at a category:'regional' show (got "${target.category}")`);
          transferIssues++;
        } else if (field === 'transferredTo' && s.category !== 'regional') {
          error(`Show "${s.id}" has transferredTo but is category "${s.category}" — only regional tryouts carry transferredTo`);
          transferIssues++;
        }
      }
    }
    if (transferIssues === 0) ok('All transfer pairs (transferOf/transferredTo) reciprocal');
  }

  // Check duplicate ibdbUrl — each IBDB production maps to exactly one show entry.
  // Two shows sharing an ibdbUrl means a revival was cloned from the original
  // production's IBDB page and silently inherited its opening/preview dates (and
  // sometimes status). This is exactly how the 2026 Other Desert Cities / Evita /
  // Dreamgirls revivals landed in the "currently on Broadway" section with their
  // 2011/1979/1981 opening dates and a bogus "14+ years on Broadway" label.
  // Fix: null the stale ibdbUrl on the newer entry (or set the correct production URL).
  const ibdbGroups = new Map();
  for (const s of shows) {
    if (!s.ibdbUrl) continue;
    if (!ibdbGroups.has(s.ibdbUrl)) ibdbGroups.set(s.ibdbUrl, []);
    ibdbGroups.get(s.ibdbUrl).push(s.id);
  }
  const dupIbdb = [...ibdbGroups.entries()].filter(([, idsArr]) => idsArr.length > 1);
  if (dupIbdb.length > 0) {
    for (const [url, idsArr] of dupIbdb) {
      error(`Shared ibdbUrl ${url} across ${idsArr.length} shows: ${idsArr.join(', ')} — each IBDB production maps to one show; null the stale url on the revival entry so it can't inherit the original production's dates`);
    }
  } else {
    ok('No shared ibdbUrls across shows');
  }

  // Market-specific slug validation
  const weShowsMissing = shows.filter(s => s.category === 'west-end' && !s.slug.includes('west-end'));
  const oweShowsMissing = shows.filter(s => s.category === 'off-west-end' && !s.slug.includes('off-west-end'));
  if (oweShowsMissing.length > 0) {
    warn(`${oweShowsMissing.length} Off-West End shows missing "off-west-end" in slug: ${oweShowsMissing.slice(0, 3).map(s => s.slug).join(', ')}${oweShowsMissing.length > 3 ? '...' : ''}`);
  } else {
    ok('All Off-West End slugs contain "off-west-end"');
  }
  const obShowsMissing = shows.filter(s => s.category === 'off-broadway' && !s.slug.includes('off-broadway'));
  if (weShowsMissing.length > 0) {
    warn(`${weShowsMissing.length} West End shows missing "west-end" in slug: ${weShowsMissing.slice(0, 3).map(s => s.slug).join(', ')}${weShowsMissing.length > 3 ? '...' : ''}`);
  } else {
    ok('All West End slugs contain "west-end"');
  }
  if (obShowsMissing.length > 0) {
    warn(`${obShowsMissing.length} Off-Broadway shows missing "off-broadway" in slug: ${obShowsMissing.slice(0, 3).map(s => s.slug).join(', ')}${obShowsMissing.length > 3 ? '...' : ''}`);
  } else {
    ok('All Off-Broadway slugs contain "off-broadway"');
  }

  // Use deduplication module for comprehensive title matching
  if (checkForDuplicate) {
    info('Running comprehensive duplicate detection...');
    const duplicatesFound = [];

    // Fast-path: Set-based O(1) lookup to skip shows already caught as exact ID/slug dupes
    const dupIdSet = new Set(dupIds);
    const dupSlugSet = new Set(dupSlugs);

    for (let i = 1; i < shows.length; i++) {
      const show = shows[i];
      if (dupIdSet.has(show.id) || dupSlugSet.has(show.slug)) continue;

      const check = checkForDuplicate(show, shows.slice(0, i));

      if (check.isDuplicate) {
        duplicatesFound.push({
          show: show.title,
          showId: show.id,
          existingShow: check.existingShow?.title,
          existingId: check.existingShow?.id,
          reason: check.reason,
        });
      }
    }

    if (duplicatesFound.length > 0) {
      for (const dup of duplicatesFound) {
        error(`Duplicate: "${dup.show}" (${dup.showId}) matches "${dup.existingShow}" (${dup.existingId}) - ${dup.reason}`);
      }
    } else {
      ok('No duplicate titles detected by deduplication module');
    }
  }
}

// ===========================================
// FIELD VALIDATION
// ===========================================

function validateRequiredFields(shows) {
  info('Checking required fields...');
  let missingCount = 0;

  for (const show of shows) {
    const fields = show.status === 'open' ? THRESHOLDS.REQUIRED_FIELDS_OPEN : THRESHOLDS.REQUIRED_FIELDS;

    for (const field of fields) {
      if (!show[field]) {
        if (field === 'venue' && show.status === 'open') {
          warn(`Open show "${show.title}" (${show.id}) missing venue`);
        } else {
          error(`Show "${show.title || show.id}" missing required field: ${field}`);
        }
        missingCount++;
      }
    }
  }

  if (missingCount === 0) {
    ok('All shows have required fields');
  }
}

function validateStatus(shows) {
  info('Checking status values...');
  const validStatuses = ['open', 'closed', 'previews', 'upcoming', 'announced'];
  const validCategories = ['broadway', 'off-broadway', 'west-end', 'off-west-end', 'regional'];
  let invalid = 0;

  for (const show of shows) {
    if (!validStatuses.includes(show.status)) {
      error(`Show "${show.title}" has invalid status: "${show.status}"`);
      invalid++;
    }
    // Active shows MUST have explicit category AND market — implicit default to 'broadway'
    // causes silent failures in market filtering (opening night orchestrator, poller).
    // Open shows = hard fail: Cats/Giant/Schmig/Balusters all shipped opening night with
    // status='open' + category=null (or market=null), making the orchestrator fall back
    // to broadway with warnings. Balusters postmortem CLASS 5 (2026-04-21).
    // See memory/feedback_shows_json_category_at_schedule.md.
    if (show.status === 'open' && !show.category) {
      error(`Open show "${show.title}" (${show.id}) missing category — opening-night pipeline will misroute. Set category to 'broadway' or 'west-end'.`);
      invalid++;
    } else if (['previews', 'upcoming'].includes(show.status) && !show.category) {
      // Upgraded from warn→error 2026-04-22: previews-state shows ship to
      // production and flip to status=open on opening day. By the time the
      // 'open' check errors, the bug is already live. Catch at discovery.
      error(`Active show "${show.title}" (${show.id}) missing category — discover-new-shows.js must set category+market on create. Fix the creator, not the data.`);
      invalid++;
    } else if (show.status === 'announced' && !show.category) {
      // Added 2026-07-14: 8 announced shows (incl. dolly-an-original-musical-2026)
      // sat with null category for months — invisible on every category-scoped
      // browse page (getBroadwayShows() filters on category), and when Check 2e
      // in update-show-status.js promotes them to 'upcoming' they'd hit the
      // error above anyway. Catch at the announced stage, same rationale as
      // the previews/upcoming upgrade: fail at discovery, not at open.
      error(`Announced show "${show.title}" (${show.id}) missing category — it is invisible on all browse pages and will fail validation on promotion. Set category+market at create.`);
      invalid++;
    } else if (show.status === 'closed' && !show.category) {
      // Extended to closed shows 2026-05-16 (Notion 362637c5-416f-81ee follow-up):
      // historical bulk inserts ship as status='closed' and slipped past the open/
      // previews/upcoming gate. Found only 1 offender (she-loves-me-1994, fixed in
      // d2 separately) before tightening. Closed shows with null category still
      // surface in UI filters (browse pages, search, market routing on archive
      // pages), and they're a leading indicator of a discover-historical-shows.js
      // regression.
      error(`Closed show "${show.title}" (${show.id}) missing category — historical insert path regressed; check scripts/discover-historical-shows.js + lib/classify-show.js wiring.`);
      invalid++;
    }
    if (['open', 'previews', 'upcoming', 'closed', 'announced'].includes(show.status) && show.category && !show.market) {
      error(`Show "${show.title}" (${show.id}, status=${show.status}) has category="${show.category}" but market=null — scripts/backfill-market.js can fill this from category, but also fix the creator that dropped it.`);
      invalid++;
    }
    if (show.category && !validCategories.includes(show.category)) {
      error(`Show "${show.title}" has invalid category: "${show.category}"`);
      invalid++;
    }
    // Market must be consistent with category when both present
    const expectedMarket = show.category === 'off-broadway' ? 'broadway'
      : show.category === 'off-west-end' ? 'west-end'
      : show.category || null;
    if (show.market && show.category && show.market !== expectedMarket) {
      error(`Show "${show.title}" (${show.id}) has market="${show.market}" inconsistent with category="${show.category}" (expected market="${expectedMarket}").`);
      invalid++;
    }
  }

  if (invalid === 0) {
    ok('All status values are valid');
  }
}

function validateDates(shows) {
  info('Checking date formats and logic...');
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date().toISOString().split('T')[0];
  let issues = 0;
  let staleStatusFixes = 0;

  // Same-title groups for the inherited-date check (distinct productions of one title).
  const sameTitleGroups = new Map();
  for (const s of shows) {
    const k = normTitle(s.title);
    if (!k) continue;
    if (!sameTitleGroups.has(k)) sameTitleGroups.set(k, []);
    sameTitleGroups.get(k).push(s);
  }

  for (const show of shows) {
    // Format + validity check (catches "TBD", "2026-13-45", non-ISO strings)
    const isValidDate = (d) => dateRegex.test(d) && !isNaN(new Date(d).getTime());
    if (show.openingDate && !isValidDate(show.openingDate)) {
      error(`Show "${show.title}" has invalid openingDate: "${show.openingDate}"`);
      issues++;
    }
    if (show.closingDate && !isValidDate(show.closingDate)) {
      error(`Show "${show.title}" has invalid closingDate: "${show.closingDate}"`);
      issues++;
    }
    if (show.previewsStartDate && !isValidDate(show.previewsStartDate)) {
      error(`Show "${show.title}" has invalid previewsStartDate: "${show.previewsStartDate}"`);
      issues++;
    }

    // Logic checks
    if (show.status === 'closed' && show.closingDate && show.closingDate > today) {
      error(`Show "${show.title}" marked closed but closingDate is future: ${show.closingDate}`);
      issues++;
    }

    if (show.status === 'open' && show.closingDate && show.closingDate < today) {
      warn(`Show "${show.title}" still open but closingDate has passed: ${show.closingDate}`);
    }

    if (show.status === 'previews' && show.openingDate && show.openingDate < today) {
      show.status = 'open';
      staleStatusFixes++;
      info(`Auto-fixed "${show.title}": previews → open (openingDate ${show.openingDate} has passed)`);
    }

    // Status drift class: a show stuck in 'upcoming' after its openingDate has
    // passed will be excluded from the opening-night orchestrator's filter
    // (orchestrator gates on status open|upcoming|previews + openingDate>=cutoff
    // AND <=lookAhead). Indian Princesses sat in 'upcoming' with null openingDate
    // for >1 week post-opening, blocking all review discovery for that show.
    // Treat as auto-fix (same as previews→open) when the openingDate is in the
    // past, since 'upcoming' is only legitimate before opening.
    if (show.status === 'upcoming' && show.openingDate && show.openingDate < today) {
      show.status = 'open';
      staleStatusFixes++;
      info(`Auto-fixed "${show.title}": upcoming → open (openingDate ${show.openingDate} has passed)`);
    }

    // Missing-images surfacing: manual stubs (Broken Snow, Bedlam Othello, IP
    // on 2026-05-27) bypass the discover-new-shows → fetch-show-images auto-
    // trigger chain in update-show-status.yml (which only fires on previews→
    // open transitions). Such stubs render image-less on the site until the
    // twice-weekly Mon/Thu fetch-all-image-formats cron runs. Surface as warn
    // so the human sees the gap; force with:
    //   gh workflow run "Fetch Show Images" -f show_id=<id> -f only_missing=false
    if (['open', 'previews', 'upcoming'].includes(show.status)) {
      // A local /images/ path only counts if the file exists — the-gin-game-2026
      // went live with phantom add-time paths that satisfied a truthiness check
      // while the site rendered the placeholder (never caught by this warn).
      const imageLive = (p) => p && (!p.startsWith('/images/') || fs.existsSync(path.join(__dirname, '..', 'public', p)));
      const hasImage = show.images && (imageLive(show.images.poster) || imageLive(show.images.thumbnail) || imageLive(show.images.hero));
      if (!hasImage) {
        warn(`Show "${show.title}" (${show.id}, status=${show.status}) has no images (or paths with no file behind them) — Mon/Thu fetch-show-images cron will pick it up; force now: gh workflow run "Fetch Show Images" -f show_id=${show.id} -f only_missing=false`);
      }
    }

    // Soft check: status='upcoming' with null openingDate is a stuck-state
    // anti-pattern. Indian Princesses sat in 'upcoming' for >1 week post-
    // opening (Notion 36d637c5-416f-81d4-9ead-e8b69574a25b), blocking the
    // orchestrator from ever picking it up. We warn loudly so the daily
    // audit-aggregator-gap workflow can prioritize Playbill cross-check.
    // Not a hard error (yet) because ~27 legitimate future-announced shows
    // are in this state — auto-fix requires per-show Playbill verification
    // which the validate-show-venue.js audit handles separately.
    if (show.status === 'upcoming' && !show.openingDate && !show.provisional) {
      const discoveredAt = show.discoveredAt ? new Date(show.discoveredAt) : null;
      const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000);
      const stale = discoveredAt && discoveredAt < ninetyDaysAgo;
      warn(`Show "${show.title}" (${show.id}) is status:upcoming with null openingDate${stale ? ' AND stale discoveredAt (>90d)' : ''} — orchestrator/gather will never fire for it. Backfill openingDate from Playbill or mark closed/announced.`);
    }

    // Soft check: status='open' with null openingDate is a stranded state — the
    // show's "Opened {date}" line renders blank and opening-night-reviews.yml
    // (keyed on an openingDate lookback) can't discover its reviews. Surfaced by
    // the Check-2d review-driven flip, which intentionally leaves openingDate null
    // rather than fabricate one when every review is dateless. Market-aware: the
    // fill source differs (IBDB is Broadway-only; OB/WE/OWE each have their own
    // enricher). Suggestion-only — like the opening-date audit, we never auto-write
    // an opening date without a confirming signal.
    // NOTE: unlike the upcoming sibling above, we do NOT exempt provisional shows.
    // `provisional` is a discovery-confidence flag, not opening-date completeness;
    // an *open* (live, scored) show with no opening date is the stranded state we
    // want regardless of how it was discovered — doubly so if also provisional.
    if (show.status === 'open' && !show.openingDate) {
      warn(`Show "${show.title}" (${show.id}, ${show.category || 'no-category'}) is status:open with null openingDate — score shows but "Opened …" is blank and opening-night review discovery can't anchor. Backfill from ${openingDateSourceHint(show.category)}.`);
    }

    // Previews with no opening date AND old previewsStartDate = likely stale/bogus entry
    if (show.status === 'previews' && !show.openingDate && show.previewsStartDate) {
      const previewYear = new Date(show.previewsStartDate).getFullYear();
      const currentYear = new Date().getFullYear();
      if (currentYear - previewYear > 1) {
        warn(`Show "${show.title}" (${show.id}) has status "previews" with no openingDate and stale previewsStartDate ${show.previewsStartDate} — likely a duplicate or stale entry`);
      }
    }

    // Closing before opening = data error (or COVID show that never opened — should null openingDate)
    if (show.openingDate && show.closingDate && show.closingDate < show.openingDate) {
      warn(`Show "${show.title}" has closingDate (${show.closingDate}) before openingDate (${show.openingDate}). If it never opened, set openingDate to null.`);
    }

    // Previews after opening — unambiguous data error (previews always precede opening).
    // Hard error as of 2026-06-28: three-houses-off-broadway-2026 shipped with previews
    // 2024-12-04 after its 2024-05-22 opening because this was only a warning.
    if (previewsAfterOpening(show)) {
      error(`Show "${show.title}" (${show.id}) has previewsStartDate (${show.previewsStartDate}) AFTER openingDate (${show.openingDate}) — previews precede opening.`);
    }

    // Previews implausibly far BEFORE opening = wrong-production previews date (cross-source
    // backstop for the sunset-baby class: previews 2013-12-17 on a 2024 revival). COVID-delayed
    // shows are exempt. The primary OB enricher already vetoes >60d shifts; this catches the
    // diffuse/older writers that bypass it.
    else if (excessivePreviewGap(show)) {
      error(`Show "${show.title}" (${show.id}) has previewsStartDate (${show.previewsStartDate}) implausibly far before openingDate (${show.openingDate}) — likely a wrong-production previews date.`);
    }

    // Collapsed press night: West End openingDate === previewsStartDate with a
    // todaytix source. TodayTix's "first performance" is the first PREVIEW, not
    // press night — discover-new-shows.js now leaves openingDate null for WE
    // unless ShowScore supplies a real "Opens" date, but legacy entries stored
    // the preview date as both. enrich-west-end-dates.js --fix-unconfirmed
    // backfills these from review-date clustering (Phase 4). Warn so new ones
    // don't slip through silently before the cron corrects them. (West End /
    // Off-West End only — Broadway cold-opens legitimately have previews ===
    // opening.)
    if (
      (show.category === 'west-end' || show.category === 'off-west-end') &&
      show.openingDate &&
      show.openingDate === show.previewsStartDate &&
      show.openingDateSource === 'todaytix'
    ) {
      warn(`Show "${show.title}" (${show.id}) has openingDate === previewsStartDate (${show.openingDate}) with source "todaytix" — likely the first-preview date stored as press night. Run: node scripts/enrich-west-end-dates.js --fix-unconfirmed (Phase 4 infers press night from review dates).`);
    }

    // (Non-theatrical genre on a west-end-category show is auto-fixed to
    // off-west-end in the venue/category cross-check below — genre overrides
    // venue. See that block for the §6 reversion fix.)

    // Inherited namesake date: this show's opening/previews date is byte-identical to a
    // DIFFERENT same-title production's — the date cloned from the namesake (a-few-good-men-2026
    // carried a-few-good-men-1989's 1989-11-15, 2026-06-28). An exact OPENING-night match is
    // airtight (distinct productions never open the same night) → hard ERROR. A previews-only
    // match is lower-confidence (placeholder/announced previews can coincide) → WARNING.
    const sameTitleSibs = (sameTitleGroups.get(normTitle(show.title)) || []).filter(o => o.id !== show.id);
    const inherited = inheritedDateFromSibling(show, sameTitleSibs);
    if (inherited && inherited.field === 'openingDate') {
      error(`Show "${show.title}" (${show.id}) has openingDate identical to same-title sibling ${inherited.siblingId} — date was cloned from the wrong production. Set this production's real dates.`);
    } else if (inherited) {
      warn(`Show "${show.title}" (${show.id}) has ${inherited.field} identical to same-title sibling ${inherited.siblingId} — possible cloned date; verify.`);
    }

    // Inherited-year heuristic (SOFT/warn): recent {title}-{YYYY} id with a decades-older
    // opening while still pre-open, when the namesake isn't a separate DB entry (so the hard
    // check above can't catch it, e.g. awake-and-sing-2026 / 1935). Warns only — a legit
    // long-runner imported with a recent id-year (book-of-mormon-west-end-2024 / 2013) trips
    // it too, and that's acceptable noise, not a build blocker.
    else if (suspiciousInheritedYear(show, new Date().getFullYear())) {
      warn(`Show "${show.title}" (${show.id}) is status:${show.status} with openingDate ${show.openingDate} — id year implies a recent production but opening is decades earlier. Verify it isn't a namesake's date cloned onto a new revival.`);
    }
  }

  if (staleStatusFixes > 0) {
    const showsPath = path.join(DATA_DIR, 'shows.json');
    const showsData = loadShows();
    for (const show of shows) {
      const match = showsData.shows.find(s => s.id === show.id);
      if (match) match.status = show.status;
    }
    saveShows(showsData);
    ok(`Auto-fixed ${staleStatusFixes} stale previews → open`);
  }

  if (issues === 0 && staleStatusFixes === 0) {
    ok('All dates are valid');
  }
}

function validateSlugs(shows) {
  info('Checking slug formats...');
  const slugRegex = /^[a-z0-9-]+$/;
  let invalid = 0;
  let autoFixed = 0;

  // Track each fix keyed by the ORIGINAL id — the slug fix can also rename
  // show.id (below), so we must match the on-disk record by the id it had
  // BEFORE mutation, not the new one.
  const slugFixes = [];
  for (const show of shows) {
    if (show.slug && !slugRegex.test(show.slug)) {
      const originalId = show.id;
      const fixed = show.slug.replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
      warn(`Show "${show.title}" had invalid slug "${show.slug}" — auto-fixed to "${fixed}"`);
      show.slug = fixed;
      // Also fix the id if it contains the same invalid characters
      if (show.id && !slugRegex.test(show.id.replace(/-\d{4}$/, ''))) {
        const fixedId = show.id.replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
        show.id = fixedId;
      }
      slugFixes.push({ originalId, slug: show.slug, id: show.id });
      autoFixed++;
    }
  }

  if (autoFixed > 0) {
    warn(`Auto-fixed ${autoFixed} invalid slug(s) — saving corrected shows.json`);
    // shows.json is { shows: [...] } — read the wrapper and index into .shows.
    // (Previously did JSON.parse(...).find(), treating the wrapper object as a
    // bare array → TypeError if this ever fired; and matched by non-unique
    // title. Match by the original id captured above.)
    const showsData = loadShows();
    for (const fix of slugFixes) {
      const match = showsData.shows.find(s => s.id === fix.originalId);
      if (match) {
        match.slug = fix.slug;
        match.id = fix.id;
      }
    }
    saveShows(showsData);
  }

  if (autoFixed === 0) {
    ok('All slugs are URL-safe');
  }
}

function validateLastUpdatedFormats() {
  info('Checking lastUpdated timestamp formats in data files...');
  // Full ISO 8601 with time component (e.g. 2026-03-29T01:23:45.678Z)
  const isoDatetimeRegex = /^\d{4}-\d{2}-\d{2}T/;
  // Date-only (e.g. 2026-03-29) — lossy, no intra-day resolution
  const dateOnlyRegex = /^\d{4}-\d{2}-\d{2}$/;
  let dateOnlyCount = 0;
  let isoCount = 0;

  let files;
  try {
    files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  } catch (e) {
    warn(`Could not read data directory: ${e.message}`);
    return;
  }

  for (const filename of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), 'utf8'));
      const candidates = [
        data._meta?.lastUpdated,
        data.lastUpdated,
        data._meta?.updatedAt,
        data.updatedAt,
      ].filter(Boolean);
      for (const val of candidates) {
        if (dateOnlyRegex.test(val) && !isoDatetimeRegex.test(val)) {
          warn(`${filename}: timestamp is date-only "${val}" — run the generating script to update to full ISO 8601`);
          dateOnlyCount++;
        } else if (isoDatetimeRegex.test(val)) {
          isoCount++;
        }
      }
    } catch (e) { /* skip unreadable files */ }
  }

  if (dateOnlyCount === 0) {
    ok(`All ${isoCount} data file timestamps use full ISO 8601 format`);
  } else {
    // Warn only — existing files have date-only values; they update naturally on next script run
    warn(`${dateOnlyCount} data file(s) still using date-only timestamps (${isoCount} already use full ISO 8601)`);
  }
}

function validateImageUrls(shows) {
  info('Checking image URLs...');
  // Accept both external URLs (https://) and local paths (/images/)
  const urlRegex = /^(https?:\/\/.+|\/images\/.+)/;
  let invalid = 0;

  // Known "Coming Soon" placeholder asset IDs from TodayTix/Contentful.
  // Keep in sync with COMING_SOON_ASSET_IDS in fetch-show-images-auto.js.
  const COMING_SOON_ASSET_IDS = new Set([
    '74xXALpVG4Bdn59x8L9OYN', '42EOxYmUHQE0Xuza0dUlJm', '1Ya0iMOMWjrOvnZPMv9y8k',
    '6W6O3eG33mXg3uJes4DBQ2', 'Y2lDO0gaKjUKp333ZG3zW', '3khjL5U7k9860pnRWY6wxe',
    '3kXlmb7NIDQUq2fEi8FK8C', '2NXMbF8ZGgylEVESpiUIlf', '4dVF8DYwWDn4B5OFSi3x3c',
  ]);
  const getAssetId = (url) => { const m = url && url.match(/ctfassets\.net\/[^/]+\/([^/]+)/); return m ? m[1] : null; };
  let placeholders = 0;

  for (const show of shows) {
    if (show.images) {
      for (const [key, url] of Object.entries(show.images)) {
        if (url && typeof url === 'string' && !urlRegex.test(url)) {
          error(`Show "${show.title}" has invalid ${key} URL: "${url}"`);
          invalid++;
        }
        // Check for known placeholder images that slipped through
        if (url && typeof url === 'string') {
          const aid = getAssetId(url);
          if (aid && COMING_SOON_ASSET_IDS.has(aid)) {
            error(`Show "${show.title}" (${show.id}) has "Coming Soon" placeholder ${key} image — needs re-fetch`);
            placeholders++;
          }
        }
      }
    }
  }

  if (invalid === 0 && placeholders === 0) {
    ok('All image URLs are valid (no placeholders)');
  }
}

// ===========================================
// VENUE vs CATEGORY CROSS-CHECK
// ===========================================

function validateVenueCategory(shows) {
  info('Cross-checking venue against category...');
  let mismatches = 0;
  let autoFixed = 0;

  for (const show of shows) {
    // GENRE OVERRIDES VENUE. A non-theatrical show (dance/magic/comedy/cabaret/
    // concert/circus) belongs on the Off-West End hub even when it plays a West
    // End venue (e.g. dance at Sadler's Wells). Without this, the venue→category
    // auto-fix below silently reverted these to west-end every CI run — the §6
    // "category reverts" bug. Handle both directions: force off-west-end, and
    // exempt them from the off-west-end→west-end venue flip.
    if (isNonTheatricalGenre(show.genre)) {
      if (show.category === 'west-end') {
        show.category = 'off-west-end';
        autoFixed++;
        info(`Auto-fixed "${show.title}" (${show.id}): west-end → off-west-end (genre: ${show.genre} overrides venue)`);
      }
      continue;
    }

    if (!show.venue || show.venue === 'TBA' || !isLondonMarket(show.category)) continue;

    if (show.category === 'off-west-end' && isWestEndVenue(show.venue)) {
      show.category = 'west-end';
      autoFixed++;
      info(`Auto-fixed "${show.title}" (${show.id}): off-west-end → west-end (venue: "${show.venue}")`);
    } else if (show.category === 'west-end' && isOffWestEndVenue(show.venue)) {
      show.category = 'off-west-end';
      autoFixed++;
      info(`Auto-fixed "${show.title}" (${show.id}): west-end → off-west-end (venue: "${show.venue}")`);
    }
  }

  if (autoFixed > 0) {
    // Write back the fixes
    const showsPath = path.join(DATA_DIR, 'shows.json');
    const showsData = loadShows();
    for (const show of shows) {
      const match = showsData.shows.find(s => s.id === show.id);
      if (match) match.category = show.category;
    }
    saveShows(showsData);
    ok(`Auto-fixed ${autoFixed} venue/category mismatches`);
  } else {
    ok('All London show venues match their category');
  }
}

// ===========================================
// VENUE / THEATER ADDRESS CONSISTENCY
// ===========================================
// Reddit 2026-05-26: Liberation showed Lena Horne Theatre's address (256 W 47th)
// while venue field correctly said James Earl Jones Theatre (138 W 48th).
// scripts/lib/venue-addresses.js is the canonical registry — autofix mismatches
// from it and warn when a Broadway venue lacks any address.
function validateTheaterAddress(shows) {
  info('Cross-checking theaterAddress against venue registry...');
  // Hard cap: if more than 5 shows mismatch, refuse to autofix and fail loud.
  // A stale entry in venue-addresses.js would otherwise silently rewrite every
  // matching show on the next CI run with no diff alarm.
  const AUTOFIX_CAP = 5;
  let mismatches = 0;
  const mismatchExamples = [];

  for (const show of shows) {
    if (!show.venue || show.venue === 'TBA') continue;
    // Only autofix Broadway shows. Same-name venues exist in London (Palace
    // Theatre, Lyceum) and would otherwise get a NYC address forced onto them.
    if (!isBroadwayCategory(show)) continue;
    const canonical = VENUE_ADDRESSES[show.venue];
    if (!canonical) continue; // venue not in Broadway registry
    if (show.theaterAddress && show.theaterAddress !== canonical) {
      if (mismatchExamples.length < 10) {
        mismatchExamples.push(`"${show.title}" (${show.id}): venue="${show.venue}" but theaterAddress="${show.theaterAddress}" — canonical "${canonical}"`);
      }
      show.theaterAddress = canonical;
      mismatches++;
    }
  }

  if (mismatches > AUTOFIX_CAP) {
    mismatchExamples.forEach(m => err('  ' + m));
    err(`${mismatches} theaterAddress/venue mismatches exceed cap ${AUTOFIX_CAP} — refusing to autofix. A wrong entry in scripts/lib/venue-addresses.js could be silently rewriting correct data; investigate before continuing.`);
    return;
  }

  if (mismatches > 0) {
    const showsPath = path.join(DATA_DIR, 'shows.json');
    const showsData = loadShows();
    for (const show of shows) {
      const match = showsData.shows.find(s => s.id === show.id);
      if (match && match.theaterAddress !== show.theaterAddress) {
        match.theaterAddress = show.theaterAddress;
      }
    }
    saveShows(showsData);
    mismatchExamples.forEach(m => info('  ' + m));
    ok(`Auto-fixed ${mismatches} theaterAddress/venue mismatches from registry`);
  } else {
    ok('All Broadway theaterAddress fields match venue registry');
  }
}

// ===========================================
// IMAGE FILE EXISTENCE CHECK
// ===========================================

function validateImageFiles(shows) {
  info('Checking local image files exist on disk...');
  const IMAGES_DIR = path.join(__dirname, '..', 'public');
  let missing = 0;
  let upgradeable = 0;

  for (const show of shows) {
    if (!show.images) continue;
    for (const [key, url] of Object.entries(show.images)) {
      if (!url || typeof url !== 'string' || !url.startsWith('/images/')) continue;
      const filePath = path.join(IMAGES_DIR, url);
      if (!fs.existsSync(filePath)) {
        // Check if a .webp version exists when .jpg is referenced
        if (url.endsWith('.jpg')) {
          const webpPath = path.join(IMAGES_DIR, url.replace(/\.jpg$/, '.webp'));
          if (fs.existsSync(webpPath)) {
            warn(`"${show.title}" (${show.id}) ${key} points to missing .jpg but .webp exists — should upgrade`);
            upgradeable++;
            continue;
          }
        }
        warn(`"${show.title}" (${show.id}) ${key} references missing file: ${url}`);
        missing++;
      }
    }
  }

  if (missing === 0 && upgradeable === 0) {
    ok('All local image paths resolve to files on disk');
  }
}

// ===========================================
// PLACEHOLDER IMAGE FILE HASH SCAN
// ===========================================

function validatePlaceholderImageHashes(shows) {
  info("Scanning local image files for placeholder hashes...");
  // Keep in sync with PLACEHOLDER_FILE_HASHES in scripts/fetch-show-images-auto.js
  const PLACEHOLDER_FILE_HASHES = new Set([
    "b4d7d1bdb443e0a94e69ac8a5abd6f40", // poster.webp (19,118 bytes) — variant 1 (round-rect glow)
    "ac3ea27f64c633474ad93fd826f614e7", // thumbnail.webp (11,664 bytes) — variant 1
    "4aed489bb69c5c49be3315e3f85b342f", // hero.webp (28,998 bytes) — variant 1 (round-rect glow)
    "52968e9f240e2db8d7523ac053d019fb", // hero.webp (28,808 bytes) — variant 2 (oval glow)
    "da0408f33ffaff9c63baf108b53b1128", // hero.webp (25,372 bytes) — variant 3 (1440x580 landscape)
    "9d1b34a4045d176b1856ab38a852d47b", // thumbnail.webp (32,372 bytes) — variant 2 (square format)
  ]);

  const IMAGES_DIR = path.join(__dirname, "..", "public", "images", "shows");
  const openStatuses = new Set(["open", "previews"]);
  const showStatusMap = new Map(shows.map(s => [s.id, s.status]));

  let knownPlaceholders = 0;

  if (!fs.existsSync(IMAGES_DIR)) {
    ok("No local images directory (skip)");
    return;
  }

  for (const showDir of listShowDirs(IMAGES_DIR)) {
    const dirPath = path.join(IMAGES_DIR, showDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    const status = showStatusMap.get(showDir);
    if (!status) continue; // orphan dir — not in shows.json, skip

    for (const file of fs.readdirSync(dirPath)) {
      if (!/\.(webp|jpg|png)$/.test(file)) continue;
      const filePath = path.join(dirPath, file);
      let buf;
      try { buf = fs.readFileSync(filePath); } catch { continue; }
      const hash = require("crypto").createHash("md5").update(buf).digest("hex");

      if (PLACEHOLDER_FILE_HASHES.has(hash)) {
        if (openStatuses.has(status)) {
          error(`"${showDir}" (${status}) has placeholder image ${file} — needs re-fetch`);
        } else {
          warn(`"${showDir}" (${status}) has placeholder ${file} — expected for upcoming shows`);
        }
        knownPlaceholders++;
      }
    }
  }

  if (knownPlaceholders === 0) {
    ok("No placeholder images found in open/preview shows");
  }
}

// ===========================================
// SHOW TYPE VALIDATION
// ===========================================

function validateShowTypes(shows) {
  info('Checking show types...');
  const validTypes = ['musical', 'play', 'special', 'opera'];
  let issues = 0;

  for (const show of shows) {
    if (show.type === 'revival') {
      error(`Show "${show.title}" (${show.id}) has type "revival" - use isRevival flag instead`);
      issues++;
    } else if (show.type && !validTypes.includes(show.type)) {
      error(`Show "${show.title}" (${show.id}) has invalid type "${show.type}" (must be one of: ${validTypes.join(', ')})`);
      issues++;
    }

    if (show.isRevival !== undefined && typeof show.isRevival !== 'boolean') {
      warn(`Show "${show.title}" (${show.id}) has isRevival of type ${typeof show.isRevival}, expected boolean`);
    }
  }

  if (issues === 0) {
    ok('All show types are valid');
  }
}

// ===========================================
// SYNOPSIS QUALITY VALIDATION
// ===========================================

function validateSynopsisQuality(shows) {
  info('Checking synopsis quality...');
  let issues = 0;

  const accessibilityPattern = /\bwheelchair\b|\bhearing assist\b|\belevator access\b|\baccessible seating\b|\bada seating\b|\brestrooms\b|\bclosed captioning\b|\bassistive listening\b/i;

  for (const show of shows) {
    if (!show.synopsis) continue;

    if (accessibilityPattern.test(show.synopsis)) {
      warn(`Show "${show.title}" (${show.id}) synopsis contains accessibility text`);
      issues++;
    }

    if (show.synopsis.length < 30) {
      warn(`Show "${show.title}" (${show.id}) synopsis is very short (${show.synopsis.length} chars)`);
      issues++;
    }

    if (/,\s*$/.test(show.synopsis)) {
      warn(`Show "${show.title}" (${show.id}) synopsis ends mid-sentence (trailing comma)`);
      issues++;
    }

    // Wiki markup remnants
    if (/\{\{|\}\}|\[\[|\]\]|\|\s*\w+\s*=/.test(show.synopsis)) {
      warn(`Show "${show.title}" (${show.id}) synopsis contains wiki markup`);
      issues++;
    }

    // Wikipedia disambiguation page content
    if (/may refer to:/i.test(show.synopsis.substring(0, 200))) {
      warn(`Show "${show.title}" (${show.id}) synopsis is a disambiguation page`);
      issues++;
    }

    // LLM refusal text instead of a synopsis ("I'm afraid I don't have enough
    // information about..."). 16 of these shipped to prod pages + JSON-LD
    // before the 2026-07-14 sweep. Uses the canonical detector shared with
    // auto-fix-show-data.js / pre-deploy-check.js — do NOT inline a second
    // regex here (its FP history lives in scripts/lib/synopsis-validation.js).
    // ERROR not warn: a refusal is never a valid synopsis.
    if (detectRefusalPattern(show.synopsis)) {
      error(`Show "${show.title}" (${show.id}) synopsis is an LLM refusal, not a synopsis — delete it or write a real one`);
      issues++;
    }

    // Film description instead of stage show
    if (/^.{0,30}is a \d{4} American .* film/i.test(show.synopsis)) {
      warn(`Show "${show.title}" (${show.id}) synopsis describes a film, not a stage show`);
      issues++;
    }

    // Song list instead of plot
    if (/^Act [12I]/i.test(show.synopsis) && /[""\u201C\u201D][^"""\u201C\u201D]+[""\u201C\u201D]\s*[-–—]\s*/.test(show.synopsis)) {
      warn(`Show "${show.title}" (${show.id}) synopsis is a song list, not a plot summary`);
      issues++;
    }
  }

  if (issues === 0) {
    ok('All synopses pass quality checks');
  }
}

// ===========================================
// CREATIVE TEAM QUALITY VALIDATION
// ===========================================

function validateCreativeTeamQuality(shows) {
  info('Checking creative team quality...');
  let issues = 0;

  for (const show of shows) {
    if (!show.creativeTeam || !Array.isArray(show.creativeTeam)) continue;

    const seenNameRoles = new Set();

    for (const member of show.creativeTeam) {
      if (!member.name) continue;

      if (member.name.length > 100) {
        error(`Show "${show.title}" (${show.id}) creative team member name too long (${member.name.length} chars): "${member.name.substring(0, 50)}..."`);
        issues++;
      } else if (member.name.length > 80) {
        warn(`Show "${show.title}" (${show.id}) creative team member name is suspiciously long (${member.name.length} chars): "${member.name.substring(0, 50)}..."`);
        issues++;
      }

      if (/\s{2,}/.test(member.name)) {
        warn(`Show "${show.title}" (${show.id}) creative team member "${member.name}" has excessive whitespace`);
        issues++;
      }

      if (/^(The |A |An )/.test(member.name)) {
        warn(`Show "${show.title}" (${show.id}) creative team member "${member.name}" starts with an article`);
        issues++;
      }

      // Check for duplicate name+role combinations
      const key = `${member.name.toLowerCase().trim()}::${(member.role || '').toLowerCase().trim()}`;
      if (seenNameRoles.has(key)) {
        warn(`Show "${show.title}" (${show.id}) has duplicate creative team entry: "${member.name}" as "${member.role}"`);
        issues++;
      }
      seenNameRoles.add(key);
    }
  }

  if (issues === 0) {
    ok('All creative team entries pass quality checks');
  }
}

// ===========================================
// CREATIVE TEAM STRUCTURAL COMPLETENESS
// ===========================================
//
// Catches the class of bug where IBDB scraping misses principal credits
// (composers, lyricists, playwrights, book writers). This is a STRUCTURAL
// check — "does this musical have a composer?" — not a data-quality check.
//
// Three layers:
//   1. Every musical must have at least one songwriter role (Music/Lyrics/combo)
//   2. Every play must have at least one writer role (Playwright/Book/Author)
//   3. Asymmetry detection: Music without Lyrics or vice versa
//
// Known exceptions are explicitly listed with explanations so they don't
// generate noise, but new shows with the same gap will be flagged.

function validateCreativeTeamCompleteness(shows) {
  info('Checking creative team structural completeness...');
  let issues = 0;

  // --- Role detection helpers ---
  function rolesOf(team) {
    return (team || []).map(m => (m.role || '').toLowerCase());
  }
  function hasAny(roles, ...patterns) {
    return roles.some(r => patterns.some(p => r.includes(p)));
  }
  function hasMusic(roles) {
    return hasAny(roles, 'music', 'composer', 'original score', 'original music');
  }
  function hasLyrics(roles) {
    return hasAny(roles, 'lyrics', 'lyricist');
  }
  function hasAnySongwriter(roles) {
    return hasMusic(roles) || hasLyrics(roles);
  }
  function hasBook(roles) {
    return hasAny(roles, 'book');
  }
  // IBDB often lists musical librettists as "Playwright" instead of "Book"
  function hasBookOrPlaywright(roles) {
    return hasAny(roles, 'book', 'playwright');
  }
  function hasWriter(roles) {
    return hasAny(roles, 'playwright', 'author', 'co-writer', 'adaptation',
      'translator', 'written by', 'book', 'writer');
  }
  function hasDirector(roles) {
    return hasAny(roles, 'director');
  }

  // --- Known exceptions (verified correct — won't generate warnings) ---
  // Each entry: show ID + reason it's legitimately missing the role
  const KNOWN_MUSICAL_NO_SONGWRITER = new Set([
    'burn-the-floor-2009',       // Dance extravaganza, no original songs
    'contact-2000',              // Dance show with recorded music, no original songs
    'tango-argentino-1985', 'tango-argentino-1999', // Traditional tango, no single songwriter
    'flamenco-puro-1986',        // Flamenco dance, traditional music
    'canciones-de-mi-padre-1988', // Linda Ronstadt folk concert
    'andre-hellers-wonderhouse-1991', // Spectacle/variety
    'it-aint-nothin-but-the-blues-1999', // Blues catalog, no single songwriter
    'pacific-paradise-1972',     // Polynesian variety show, sparse IBDB data
    'a-party-with-betty-comden-and-adolph-green-1977', // Concert, sparse IBDB data
    'the-three-sisters-1996',    // Chekhov play with incidental music (likely misclassified)
  ]);

  const KNOWN_MUSICAL_NO_BOOK = new Set([
    // Sung-through musicals / operas (no spoken dialogue = no book)
    'cats-1982', 'cats-2016', 'cats-the-jellicle-ball-2026',
    'les-miserables-1987',
    'the-phantom-of-the-opera-1988',
    'evita-2012',
    'jesus-christ-superstar-2012', 'jesus-christ-superstar-1971', 'jesus-christ-superstar-1977', 'jesus-christ-superstar-2000',
    'miss-saigon-2017',
    'godspell-2011', 'godspell-1976',
    'the-gershwins-porgy-and-bess-2012', 'porgy-and-bess-1976',
    'pirates-the-penzance-musical-2025',
    'joseph-and-the-amazing-technicolor-dreamcoat-1993',
    'amahl-and-the-night-visitors-1970', 'help-help-the-globolinks-1970', // Menotti operas
    'amour-2002',                      // Legrand sung-through
    'aspects-of-love-1990',            // ALW sung-through
    'chess-2003',                      // Sung-through (ABBA)
    'inner-city-1971',                 // Sung-through (Eve Merriam)
    'la-boheme-2002',                  // Puccini opera
    'la-tragedie-de-carmen-1983',      // Bizet opera adaptation
    'song-and-dance-1985',             // ALW sung-through + dance
    'starlight-express-1987',          // ALW sung-through
    'the-human-comedy-1984',           // Sung-through
    'treemonisha-1975',                // Joplin opera
    'boccaccio-1975',                  // Operetta
    'the-desert-song-1973',            // Operetta
    'the-mikado-1976', 'the-mikado-1987', // G&S operettas
    'the-three-sisters-1996',          // Chekhov adaptation with music
    'here-lies-love-2023',             // Immersive concept album musical
    'the-pirate-queen-2007',
    // Revues / concert shows / jukebox compilations (no narrative book)
    'after-midnight-2013',
    'rain-2010',
    'sondheim-on-sondheim-2010',
    'stephen-sondheims-old-friends-2025',
    'bob-fosses-dancin-2023', 'dancin-1978',
    'burn-the-floor-2009',
    'cirque-du-soleil-paramour-2016',
    'cirque-dreams-2008',
    'chita-rivera-the-dancers-life-2005',
    'ring-of-fire-2006',
    'the-times-they-are-achangin-2006',
    'all-about-me-2010',
    'aint-misbehavin-1978', 'aint-misbehavin-1988',
    'an-evening-with-jerry-herman-1998',
    'beatlemania-1977',
    'black-and-blue-1989',
    'broadway-follies-1981',
    'dream-1997',
    'eubie-1978',
    'fosse-1999',
    'jerrys-girls-1985',
    'me-and-bessie-1975',
    'oh-coward-1986',
    'oh-calcutta-1976',
    'putting-it-together-1999',
    'riverdance-on-broadway-2000',
    'rock-n-roll-the-first-5000-years-1982',
    'rodgers-and-hart-1975',
    'shakespeares-cabaret-1981',
    'side-by-side-by-sondheim-1977',
    'smokey-joes-cafe-1995',
    'sophisticated-ladies-1981',
    'stardust-1987',
    'swing-1999',
    'thats-entertainment-1972',
    'the-gershwins-fascinating-rhythm-1999',
    'the-look-of-love-2003',
    'the-night-that-made-america-famous-1975',
    'tintypes-1980',
    'truly-blessed-1990',
    'your-arms-too-short-to-box-with-god-1980', 'your-arms-too-short-to-box-with-god-1982',
    'jerome-robbins-broadway-1989',
    'it-aint-nothin-but-the-blues-1999',
    'movin-out-2002',                  // Billy Joel jukebox/dance
    'five-guys-named-moe-1992',        // Louis Jordan jukebox
    'marilyn-1983',                    // Biographical compilation
    'street-corner-symphony-1997',     // Doo-wop revue
    'jacques-brel-is-alive-and-well-and-living-in-paris-1972',
    // Dance / performance shows (no narrative book)
    'swan-lake-1998',
    'tango-argentino-1985', 'tango-argentino-1999',
    'tango-pasion-1993',
    'oba-oba-1988', 'oba-oba-93-1992',
    'andre-hellers-wonderhouse-1991',
    'flamenco-puro-1986',
    'canciones-de-mi-padre-1988',      // Linda Ronstadt folk concert
    'from-israel-with-love-1972',
    'pacific-paradise-1972',
    // Revivals where IBDB didn't scrape Book (Playwright-as-Book handled by hasBookOrPlaywright)
    '42nd-street-1980', 'carousel-1994', 'oklahoma-1979', 'oklahoma-2002',
    'over-here-1974', 'peter-pan-1998', 'peter-pan-1999',
    'show-boat-1983', 'the-king-and-i-1977', 'the-king-and-i-1985', 'the-king-and-i-1996',
    'wind-in-the-willows-1985', 'platinum-1978', 'reggae-1980',
    // Misc — sparse IBDB data or format exceptions
    'hard-job-being-god-1972',
    'the-news-1985',
    'a-party-with-betty-comden-and-adolph-green-1977',
  ]);

  const KNOWN_MUSICAL_NO_DIRECTOR = new Set([
    'rain-2010',                 // Concert show, no traditional director credit
    // Dance/concert shows — no traditional director
    'oba-oba-1988', 'oba-oba-93-1992',
    'tango-pasion-1993',
    'a-kurt-weill-cabaret-1979',
    'a-party-with-betty-comden-and-adolph-green-1977',
    // IBDB scraping gaps — shows definitely had directors but credit wasn't captured
    'a-broadway-musical-1978', 'big-river-1985', 'chu-chem-1989',
    'dude-1972', 'fiddler-on-the-roof-1990', 'late-nite-comic-1987',
    'man-of-la-mancha-1992', 'my-one-and-only-1983', 'once-on-this-island-2002',
    'peter-pan-1979', 'prince-of-central-park-1989', 'somethings-afoot-1976',
    'soon-1971', 'street-corner-symphony-1997', 'wind-in-the-willows-1985',
  ]);

  const KNOWN_PLAY_NO_WRITER = new Set([
    'mark-twain-tonight-2005',       // One-man show (Hal Holbrook as Mark Twain)
    'mark-twain-tonight-1977',       // One-man show (Hal Holbrook)
    'is-this-a-room-2021',           // Verbatim theatre — transcript, no traditional playwright
    'the-encounter-2016',            // Devised piece by Complicite/Simon McBurney
    'primo-2005',                    // Solo show adapted from Primo Levi's memoir
    'latinologues-2005',             // Comedy sketch show
    'here-are-ladies-1973',          // Solo performance show
    'ian-mckellen-acting-shakespeare-1984', // Solo Shakespeare performance
    'jack-a-night-on-the-town-with-john-barrymore-1996', // Solo show
    'sid-caesar-and-company-1989',   // Sketch/variety show
    'heartaches-of-a-pussycat-1980', // Variety/sketch show
    'short-talks-on-the-universe-2002', // Experimental (Annie Dorsen / Anne Carson)
    'quick-change-1980',             // Variety/magic show
    'summer-brave-1975',             // Adaptation — IBDB missing playwright
    'medea-and-jason-1974',          // Classic adaptation — IBDB missing
    'ulysses-in-nighttown-1974',     // Joyce adaptation — IBDB missing
  ]);

  const KNOWN_MUSIC_NO_LYRICS = new Set([
    // Jukebox musicals where "Music" credit is catalog/compilation, lyrics from various songs
    'bullets-over-broadway-2014',
    'the-cher-show-2018',
    'priscilla-queen-of-the-desert-2011',
    'bob-fosses-dancin-2023',
    'everyday-rapture-2010',
    'buena-vista-social-club-2025',  // Cuban catalog music, no single songwriter
    'titanique-2026',                // Céline Dion catalog parody
    // Instrumental / dance shows (no singing = no lyrics)
    'swan-lake-1998',
    'oba-oba-1988', 'oba-oba-93-1992',
    'tango-pasion-1993',
    'from-israel-with-love-1972',
    // Compilation / cabaret — multiple lyricists, no single credit
    'a-kurt-weill-cabaret-1979',
    'a-musical-jubilee-1975',
    'band-in-berlin-1999',
    'beatlemania-1977',
    'got-tu-go-disco-1979',
    'oh-calcutta-1976',
    'only-fools-are-sad-1971',
    'shakespeares-cabaret-1981',
    // Opera/operetta — libretto combined with score
    'la-boheme-2002',
    'chronicle-of-a-death-foretold-1995',
    // IBDB scraping gaps — Lyrics credit exists but wasn't captured (R&H revivals etc.)
    'carousel-1994',
    'oklahoma-1979', 'oklahoma-2002',
    'the-king-and-i-1977', 'the-king-and-i-1985', 'the-king-and-i-1996',
    'music-is-1976',
    'platinum-1978',
    'reggae-1980',
  ]);

  for (const show of shows) {
    const team = show.creativeTeam || [];
    if (team.length === 0) continue; // Empty teams handled elsewhere
    const roles = rolesOf(team);

    if (show.type === 'musical') {
      // Check 1: Musical must have at least one songwriter
      if (!hasAnySongwriter(roles) && !KNOWN_MUSICAL_NO_SONGWRITER.has(show.id)) {
        warn(`[creative-completeness] Musical "${show.title}" (${show.id}) has NO Music or Lyrics credit — likely missing songwriter data from IBDB`);
        issues++;
      }

      // Check 2: Musical should have a Book credit (IBDB often uses "Playwright" for librettist)
      if (!hasBookOrPlaywright(roles) && !KNOWN_MUSICAL_NO_BOOK.has(show.id)) {
        warn(`[creative-completeness] Musical "${show.title}" (${show.id}) has no Book credit — verify if sung-through/revue (add to exceptions) or genuinely missing`);
        issues++;
      }

      // Check 3: Musical should have a Director
      if (!hasDirector(roles) && !KNOWN_MUSICAL_NO_DIRECTOR.has(show.id)) {
        warn(`[creative-completeness] Musical "${show.title}" (${show.id}) has no Director credit`);
        issues++;
      }

      // Check 4: Asymmetry — Music without Lyrics suggests incomplete scrape
      if (hasMusic(roles) && !hasLyrics(roles) && !KNOWN_MUSIC_NO_LYRICS.has(show.id)) {
        warn(`[creative-completeness] Musical "${show.title}" (${show.id}) has Music but no Lyrics credit — likely incomplete`);
        issues++;
      }
    } else {
      // Play
      // Check 5: Play must have a playwright/writer
      if (!hasWriter(roles) && !KNOWN_PLAY_NO_WRITER.has(show.id)) {
        warn(`[creative-completeness] Play "${show.title}" (${show.id}) has no Playwright or Writer credit`);
        issues++;
      }
    }
  }

  if (issues === 0) {
    ok('All shows pass creative team completeness checks');
  } else {
    info(`Creative team completeness: ${issues} warning(s) — review and fix data or add to known exceptions`);
  }
}

// ===========================================
// SAFETY CHECKS
// ===========================================

function validateMinimumCounts(shows) {
  info('Checking minimum counts...');

  const openShows = shows.filter(s => s.status === 'open');

  if (baseline) {
    // Dynamic thresholds from baseline
    const minTotal = Math.floor(baseline.totalShows * (1 - MAX_DECLINE_PCT));
    const minOpen = Math.floor(baseline.openShows * (1 - MAX_DECLINE_PCT));

    if (shows.length < minTotal) {
      error(`Only ${shows.length} shows (baseline: ${baseline.totalShows}, min allowed: ${minTotal} = -${Math.round(MAX_DECLINE_PCT * 100)}%)`);
    } else {
      ok(`Total shows: ${shows.length} (baseline: ${baseline.totalShows}, min: ${minTotal})`);
    }

    if (openShows.length < minOpen) {
      error(`Only ${openShows.length} open shows (baseline: ${baseline.openShows}, min allowed: ${minOpen} = -${Math.round(MAX_DECLINE_PCT * 100)}%)`);
    } else {
      ok(`Open shows: ${openShows.length} (baseline: ${baseline.openShows}, min: ${minOpen})`);
    }
  } else {
    // First run: use hardcoded fallback
    info('No baseline file found, using fallback thresholds');
    if (shows.length < FALLBACK_THRESHOLDS.MIN_TOTAL_SHOWS) {
      error(`Only ${shows.length} shows (fallback minimum: ${FALLBACK_THRESHOLDS.MIN_TOTAL_SHOWS})`);
    } else {
      ok(`Total shows: ${shows.length} (fallback minimum: ${FALLBACK_THRESHOLDS.MIN_TOTAL_SHOWS})`);
    }

    if (openShows.length < FALLBACK_THRESHOLDS.MIN_OPEN_SHOWS) {
      error(`Only ${openShows.length} open shows (fallback minimum: ${FALLBACK_THRESHOLDS.MIN_OPEN_SHOWS})`);
    } else {
      ok(`Open shows: ${openShows.length} (fallback minimum: ${FALLBACK_THRESHOLDS.MIN_OPEN_SHOWS})`);
    }
  }
}

function checkForCatastrophicChanges() {
  info('Checking for suspicious changes...');

  try {
    const { execSync } = require('child_process');
    const diff = execSync('git diff --numstat data/shows.json 2>/dev/null || echo ""', { encoding: 'utf8' });

    if (diff.trim()) {
      const [additions, deletions] = diff.trim().split('\t');
      const adds = parseInt(additions) || 0;
      const dels = parseInt(deletions) || 0;

      if (dels > 500 && dels > adds * 2) {
        error(`Suspicious deletion: ${dels} lines deleted vs ${adds} added`);
      } else {
        ok(`Changes look reasonable: +${adds} -${dels} lines`);
      }
    } else {
      ok('No pending changes to shows.json');
    }
  } catch (e) {
    ok('Skipped git diff check');
  }
}

// ===========================================
// GROSSES VALIDATION
// ===========================================

function validateGrossesJson() {
  info('Checking grosses.json...');

  if (!fs.existsSync(GROSSES_FILE)) {
    warn('grosses.json does not exist (optional)');
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(GROSSES_FILE, 'utf8'));
    ok('grosses.json is valid JSON');

    if (!data.shows || typeof data.shows !== 'object') {
      warn('grosses.json missing "shows" object');
    } else {
      ok(`Grosses data for ${Object.keys(data.shows).length} shows`);
    }
  } catch (e) {
    error(`grosses.json parse error: ${e.message}`);
  }
}

function validateSchedulesJson(shows) {
  info('Checking show-schedules.json multi-week coverage...');

  if (!fs.existsSync(SCHEDULES_FILE)) {
    info('show-schedules.json does not exist, skipping');
    return;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
  } catch (e) {
    error(`show-schedules.json parse error: ${e.message}`);
    return;
  }
  if (!data.shows || typeof data.shows !== 'object') {
    warn('show-schedules.json missing "shows" object');
    return;
  }

  // Shows that should have multi-week data: Broadway, open-status only (bwayrush is Broadway-only).
  const broadwayOpen = shows.filter(s => s.status === 'open' && (!s.category || s.category === 'broadway'));
  const openIds = new Set(broadwayOpen.map(s => s.id));

  let multiWeek = 0;
  let singleWeek = 0;
  const singleWeekIds = [];
  for (const [showId, entry] of Object.entries(data.shows)) {
    if (!openIds.has(showId)) continue;
    const weekCount = entry.weeks ? Object.keys(entry.weeks).length : 0;
    if (weekCount >= 2) multiWeek++;
    else {
      singleWeek++;
      singleWeekIds.push(`${showId} (${weekCount})`);
    }
  }

  const totalCovered = multiWeek + singleWeek;
  if (totalCovered === 0) {
    warn('No open Broadway shows found in show-schedules.json (fresh scrape pending?)');
    return;
  }

  // Fail if the majority of open shows have only 1 week — matches the week-nav bug's symptom.
  // Threshold: >50% of open shows must have multi-week data.
  const ratio = multiWeek / totalCovered;
  if (ratio < 0.5) {
    error(`show-schedules.json has only ${multiWeek}/${totalCovered} open Broadway shows with multi-week data ` +
          `(bwayrush /api/calendar likely blocked). Week-nav arrows on Showtimes card will be disabled.`);
    if (singleWeekIds.length <= 10) {
      error(`Single-week shows: ${singleWeekIds.join(', ')}`);
    } else {
      error(`Single-week shows (first 10 of ${singleWeekIds.length}): ${singleWeekIds.slice(0, 10).join(', ')}`);
    }
  } else if (singleWeek > 0) {
    warn(`show-schedules.json: ${singleWeek}/${totalCovered} open Broadway shows have only 1 week of data`);
  } else {
    ok(`show-schedules.json: all ${multiWeek} open Broadway shows have multi-week schedule data`);
  }
}

// ===========================================
// REVIEW DATA VALIDATION
// ===========================================

function validateReviewData(shows) {
  info('Checking review-texts directories...');
  const reviewTextsDir = path.join(DATA_DIR, 'review-texts');

  if (!fs.existsSync(reviewTextsDir)) {
    info('No review-texts directory found, skipping');
    return;
  }

  const showIds = new Set(shows.map(s => s.id));
  const reviewDirs = fs.readdirSync(reviewTextsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name);

  let orphaned = 0;
  for (const dir of reviewDirs) {
    if (!showIds.has(dir)) {
      warn(`Orphaned review directory: ${dir}`);
      orphaned++;
    }
  }

  if (orphaned === 0) {
    ok('All review directories match show IDs');
  }
}

function validateReviewsJson() {
  info('Checking reviews.json for duplicate outlet+critic combos...');
  const reviewsFile = path.join(DATA_DIR, 'reviews.json');

  if (!fs.existsSync(reviewsFile)) {
    info('reviews.json does not exist, skipping');
    return 0;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
  } catch (e) {
    error(`reviews.json parse error: ${e.message}`);
    return 0;
  }

  const reviews = data.reviews || [];
  ok(`Loaded ${reviews.length} reviews from reviews.json`);

  // Orphan review check: every showId in reviews.json must exist in shows.json
  const showsFile = path.join(DATA_DIR, 'shows.json');
  if (fs.existsSync(showsFile)) {
    try {
      const showsJson = JSON.parse(fs.readFileSync(showsFile, 'utf8'));
      const allShowIds = new Set((showsJson.shows || []).map(s => s.id));
      const reviewShowIds = new Set(reviews.map(r => r.showId));
      const orphanIds = [...reviewShowIds].filter(id => !allShowIds.has(id));
      if (orphanIds.length > 0) {
        error(`${orphanIds.length} orphan showIds in reviews.json (no matching show): ${orphanIds.slice(0, 10).join(', ')}${orphanIds.length > 10 ? '...' : ''}`);
      } else {
        ok('No orphan showIds in reviews.json');
      }
    } catch (e) {
      warn(`Could not check orphan reviews: ${e.message}`);
    }
  }

  // Review count delta check against baseline
  if (baseline && baseline.totalReviews) {
    const minReviews = Math.floor(baseline.totalReviews * (1 - MAX_REVIEW_DECLINE_PCT));
    if (reviews.length < minReviews) {
      error(`Review count dropped: ${reviews.length} reviews (baseline: ${baseline.totalReviews}, min allowed: ${minReviews} = -${Math.round(MAX_REVIEW_DECLINE_PCT * 100)}%)`);
    } else {
      ok(`Review count: ${reviews.length} (baseline: ${baseline.totalReviews}, min: ${minReviews})`);
    }
  }

  // Per-show review count regression check (catches cross-show contamination cleanup)
  if (baseline && baseline.perShowReviews) {
    const currentPerShow = {};
    for (const r of reviews) {
      const sid = r.showId || 'unknown';
      currentPerShow[sid] = (currentPerShow[sid] || 0) + 1;
    }
    const bigDrops = [];
    for (const [showId, prevCount] of Object.entries(baseline.perShowReviews)) {
      const currCount = currentPerShow[showId] || 0;
      if (prevCount >= 3 && currCount < prevCount * 0.5) {
        bigDrops.push({ showId, prev: prevCount, curr: currCount, pct: Math.round((1 - currCount / prevCount) * 100) });
      }
    }
    if (bigDrops.length > 0) {
      warn(`${bigDrops.length} show(s) lost >50% of reviews (may indicate contamination cleanup or scraper regression):`);
      for (const d of bigDrops.slice(0, 10)) {
        warn(`  ${d.showId}: ${d.prev} → ${d.curr} (-${d.pct}%)`);
      }
    } else {
      ok('Per-show review counts stable (no shows lost >50% of reviews)');
    }
  }

  // Check for duplicate outlet+critic per show
  const byShow = {};
  const duplicates = [];

  for (const r of reviews) {
    const showId = r.showId || 'unknown';
    const outletKey = (r.outlet || 'unknown').toLowerCase().trim();
    const criticKey = (r.criticName || 'unknown').toLowerCase().trim();
    const key = `${outletKey}|${criticKey}`;

    if (!byShow[showId]) {
      byShow[showId] = new Set();
    }

    if (byShow[showId].has(key)) {
      duplicates.push({ showId, outlet: r.outlet, critic: r.criticName });
    } else {
      byShow[showId].add(key);
    }
  }

  if (duplicates.length > 0) {
    error(`Found ${duplicates.length} duplicate outlet+critic combos in reviews.json:`);
    duplicates.slice(0, 10).forEach(d => {
      error(`  ${d.showId}: ${d.outlet} + ${d.critic}`);
    });
    if (duplicates.length > 10) {
      error(`  ...and ${duplicates.length - 10} more`);
    }
  } else {
    ok('No duplicate outlet+critic combos in reviews.json');
  }

  // Check for outletId inconsistencies (same display name → different outletIds)
  const outletIdByName = {};
  for (const r of reviews) {
    const name = (r.outlet || '').toLowerCase().trim();
    if (!name) continue;
    if (!outletIdByName[name]) outletIdByName[name] = new Set();
    outletIdByName[name].add(r.outletId);
  }
  const inconsistent = Object.entries(outletIdByName).filter(([, ids]) => ids.size > 1);
  if (inconsistent.length > 0) {
    error(`Found ${inconsistent.length} outlets with inconsistent outletIds in reviews.json:`);
    inconsistent.forEach(([name, ids]) => {
      error(`  "${name}": ${[...ids].join(', ')}`);
    });
  } else {
    ok('No outlet ID inconsistencies in reviews.json');
  }

  // Check for outlets not in outlet-registry.json (truly unknown outlets)
  try {
    const registryPath = path.join(DATA_DIR, 'outlet-registry.json');
    if (fs.existsSync(registryPath)) {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const outlets = registry.outlets || registry;
      const unknownOutlets = {};
      for (const r of reviews) {
        if (!r.outletId) continue;
        if (!outlets[r.outletId]) {
          if (!unknownOutlets[r.outletId]) unknownOutlets[r.outletId] = 0;
          unknownOutlets[r.outletId]++;
        }
      }
      const unknownCount = Object.keys(unknownOutlets).length;
      if (unknownCount > 0) {
        const sorted = Object.entries(unknownOutlets).sort((a, b) => b[1] - a[1]);
        const top10 = sorted.slice(0, 10).map(([id, n]) => `${id}(${n})`).join(', ');
        info(`${unknownCount} outlet IDs in reviews.json not in outlet-registry.json (top: ${top10})`);
      } else {
        ok('All review outlet IDs exist in outlet-registry.json');
      }
    }
  } catch (e) {
    info(`Skipped outlet registry check: ${e.message}`);
  }

  // Cross-outlet same-critic detection: flag when same critic appears at 2+ outlets for same show
  if (normalizeCritic && normalizeOutlet) {
    const byCriticShow = {};
    for (const r of reviews) {
      const critic = normalizeCritic(r.criticName || 'unknown');
      const outlet = normalizeOutlet(r.outlet || 'unknown');
      if (critic === 'unknown' || outlet === 'unknown') continue;

      const key = `${r.showId}:${critic}`;
      if (!byCriticShow[key]) byCriticShow[key] = new Set();
      byCriticShow[key].add(outlet);
    }

    const crossOutlet = Object.entries(byCriticShow)
      .filter(([, outlets]) => outlets.size > 1)
      .map(([key, outlets]) => {
        const [showId, critic] = key.split(':');
        return { showId, critic, outlets: [...outlets] };
      });

    if (crossOutlet.length > 0) {
      warn(`Found ${crossOutlet.length} cases where same critic appears at multiple outlets for same show:`);
      crossOutlet.slice(0, 10).forEach(c => {
        warn(`  ${c.showId}: ${c.critic} at ${c.outlets.join(', ')}`);
      });
      if (crossOutlet.length > 10) {
        warn(`  ...and ${crossOutlet.length - 10} more`);
      }
    } else {
      ok('No cross-outlet same-critic duplicates in reviews.json');
    }
  }

  // URL uniqueness check: same URL at same outlet for same show should not appear twice
  const urlDuplicates = [];
  const seenUrls = {};
  for (const r of reviews) {
    if (!r.url) continue;
    const key = `${r.showId}|${(r.outletId || r.outlet || '').toLowerCase()}|${r.url.toLowerCase().replace(/#.*$/, '').replace(/\/$/, '')}`;
    if (seenUrls[key]) {
      urlDuplicates.push({ showId: r.showId, outlet: r.outlet, url: r.url, critics: [seenUrls[key], r.criticName] });
    } else {
      seenUrls[key] = r.criticName;
    }
  }
  if (urlDuplicates.length > 0) {
    warn(`Found ${urlDuplicates.length} duplicate URLs within same show+outlet in reviews.json:`);
    urlDuplicates.slice(0, 10).forEach(d => {
      warn(`  ${d.showId}: ${d.outlet} | ${d.url} (${d.critics.join(', ')})`);
    });
  } else {
    ok('No duplicate URLs within same show+outlet in reviews.json');
  }

  // Schema validation: assignedScore must be null or a finite number.
  // Schmigadoon 2026 shipped with nypost assignedScore="2/4 stars" because the
  // range check below uses `< 0` which silently passes for strings (NaN < 0 = false).
  const badType = reviews.filter(r =>
    r.assignedScore !== null &&
    r.assignedScore !== undefined &&
    (typeof r.assignedScore !== 'number' || !Number.isFinite(r.assignedScore))
  );
  if (badType.length) {
    error(`${badType.length} reviews have non-numeric assignedScore (schema drift — must be null or finite number):`);
    badType.slice(0, 10).forEach(r => error(`  ${r.showId}/${r.outletId}/${r.criticName}: ${typeof r.assignedScore} ${JSON.stringify(r.assignedScore)}`));
  } else {
    ok('All assignedScore values are numeric or null (no schema drift)');
  }

  // Score range validation: assignedScore must be 0-100
  const outOfRange = reviews.filter(r =>
    typeof r.assignedScore === 'number' &&
    Number.isFinite(r.assignedScore) &&
    (r.assignedScore < 0 || r.assignedScore > 100)
  );
  if (outOfRange.length) {
    error(`${outOfRange.length} reviews have assignedScore outside 0-100 range`);
    outOfRange.slice(0, 5).forEach(r => error(`  ${r.showId}/${r.outletId}: ${r.assignedScore}`));
  } else {
    ok('All assignedScore values in 0-100 range');
  }

  // Content tier / scoring inconsistency: reviews with contentTier='invalid' that still have scores
  const invalidScored = reviews.filter(r => r.contentTier === 'invalid' && r.assignedScore != null);
  if (invalidScored.length) {
    warn(`${invalidScored.length} reviews have contentTier='invalid' but still have assignedScore:`);
    invalidScored.slice(0, 5).forEach(r => warn(`  ${r.showId}/${r.outletId}: score=${r.assignedScore}`));
  }

  // Field consistency: contentTier=complete but no fullText (source files)
  const completeNoText = reviews.filter(r => r.contentTier === 'complete' && (!r.fullText || !r.fullText.trim()));
  if (completeNoText.length) {
    warn(`${completeNoText.length} reviews have contentTier='complete' but no fullText`);
    completeNoText.slice(0, 5).forEach(r => warn(`  ${r.showId}/${r.outletId}`));
  }

  // needsReview tracking
  const needsReviewCount = reviews.filter(r => r.needsReview).length;
  if (needsReviewCount > 0) {
    info(`${needsReviewCount} reviews flagged needsReview`);
  }

  // publishDate format check: all non-null dates should be ISO 8601
  const nonIsoDates = reviews.filter(r => r.publishDate && !/^\d{4}-\d{2}-\d{2}$/.test(r.publishDate));
  if (nonIsoDates.length) {
    warn(`${nonIsoDates.length} reviews have non-ISO publishDate format:`);
    nonIsoDates.slice(0, 5).forEach(r => warn(`  ${r.showId}: "${r.publishDate}"`));
  } else {
    ok('All publishDate values are ISO 8601 format');
  }

  // Phase 1 quality flag validation: check that new flags exist on review-text files
  // and that rebuild-all-reviews.js passes them through correctly
  info('Checking Phase 1 quality flags in review-texts...');
  const reviewTextsDir2 = path.join(DATA_DIR, 'review-texts');
  let flagCounts = { showNotMentioned: 0, misattributedFullText: 0, duplicateTextOf: 0 };
  if (fs.existsSync(reviewTextsDir2)) {
    try {
      const showDirsForFlags = fs.readdirSync(reviewTextsDir2, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => d.name);

      for (const showDir of showDirsForFlags) {
        const dirPath = path.join(reviewTextsDir2, showDir);
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const fileData = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
            if (fileData.showNotMentioned === true) flagCounts.showNotMentioned++;
            if (fileData.misattributedFullText === true) flagCounts.misattributedFullText++;
            if (fileData.duplicateTextOf) flagCounts.duplicateTextOf++;

            // Validate flag data types
            if (fileData.showNotMentioned !== undefined && typeof fileData.showNotMentioned !== 'boolean') {
              warn(`${showDir}/${file}: showNotMentioned should be boolean, got ${typeof fileData.showNotMentioned}`);
            }
            if (fileData.misattributedFullText !== undefined && typeof fileData.misattributedFullText !== 'boolean') {
              warn(`${showDir}/${file}: misattributedFullText should be boolean, got ${typeof fileData.misattributedFullText}`);
            }
            if (fileData.misattributedFullText === true && !fileData.extractedByline) {
              warn(`${showDir}/${file}: misattributedFullText=true but missing extractedByline`);
            }
            if (fileData.duplicateTextOf !== undefined && typeof fileData.duplicateTextOf !== 'string') {
              warn(`${showDir}/${file}: duplicateTextOf should be string, got ${typeof fileData.duplicateTextOf}`);
            }
            // Validate that duplicateTextOf points to an existing file in the same dir.
            // Broken refs cause silent dedup failures (the duplicate slips through and
            // double-counts the same review under a misattributed critic).
            if (typeof fileData.duplicateTextOf === 'string') {
              const refPath = path.join(showDir, fileData.duplicateTextOf);
              if (!fs.existsSync(refPath)) {
                warn(`${showDir}/${file}: duplicateTextOf points to non-existent file "${fileData.duplicateTextOf}"`);
              }
            }
            // Validate human review score fields
            if (fileData.humanReviewScore !== undefined && (typeof fileData.humanReviewScore !== 'number' || fileData.humanReviewScore < 0 || fileData.humanReviewScore > 100)) {
              warn(`${showDir}/${file}: humanReviewScore should be number 0-100`);
            }
            // Note: assignedScore is an OUTPUT of rebuild — setting it manually has
            // no effect. To override a score, use humanReviewScore (P0b priority).
            // See rebuild-all-reviews.js header comment for the full priority chain.
          } catch (e) {
            // Skip unreadable files
          }
        }
      }
    } catch (e) {
      // Skip if can't read directory
    }

    const totalFlags = flagCounts.showNotMentioned + flagCounts.misattributedFullText + flagCounts.duplicateTextOf;
    if (totalFlags > 0) {
      info(`Quality flags: ${flagCounts.showNotMentioned} showNotMentioned, ${flagCounts.misattributedFullText} misattributed, ${flagCounts.duplicateTextOf} duplicateText`);
    } else {
      ok('No quality flags found (run backfill-review-flags.js to populate)');
    }
  }

  // Registry-based critic-outlet misattribution detection
  if (validateCriticOutlet) {
    const misattributed = [];
    for (const r of reviews) {
      const validation = validateCriticOutlet(r.criticName, r.outletId || r.outlet);
      if (validation.isSuspicious && (validation.confidence === 'high' || validation.confidence === 'medium')) {
        misattributed.push({
          showId: r.showId,
          outlet: r.outlet,
          critic: r.criticName,
          confidence: validation.confidence,
          reason: validation.reason,
        });
      }
    }

    if (misattributed.length > 0) {
      warn(`Found ${misattributed.length} suspected critic-outlet misattributions:`);
      misattributed.slice(0, 10).forEach(m => {
        warn(`  [${m.confidence}] ${m.showId}: ${m.critic} at ${m.outlet}`);
        if (m.reason) warn(`    ${m.reason}`);
      });
      if (misattributed.length > 10) {
        warn(`  ...and ${misattributed.length - 10} more`);
      }
    } else {
      ok('No critic-outlet misattributions detected (registry-based)');
    }
  } else {
    info('Skipping registry-based misattribution check (validateCriticOutlet not available)');
  }

  return reviews.length;
}

// ===========================================
// OUTLET FRAGMENTATION DETECTION
// ===========================================

/**
 * Detect outlet fragmentation: outlet_ids that SHOULD normalize to the same
 * canonical outlet but don't, because they're missing from OUTLET_ALIASES.
 * This catches the root cause of duplicate outlets before they accumulate.
 */
function validateOutletFragmentation() {
  if (!normalizeOutlet) {
    info('Skipping outlet fragmentation check (normalizeOutlet not available)');
    return;
  }

  info('Checking for outlet fragmentation...');
  const reviewsFile = path.join(DATA_DIR, 'reviews.json');
  if (!fs.existsSync(reviewsFile)) return;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
  } catch { return; }

  const reviews = data.reviews || [];

  // Group by outlet_id, tracking display name and review count
  const outletIndex = {};  // outlet_id -> { displayName, count }
  for (const r of reviews) {
    const oid = r.outletId || normalizeOutlet(r.outlet || 'unknown');
    if (!outletIndex[oid]) {
      outletIndex[oid] = { displayName: r.outlet || oid, count: 0 };
    }
    outletIndex[oid].count++;
  }

  // Known-bad outlets that are scraping artifacts (not real outlets)
  const KNOWN_BAD_OUTLETS = ['advertisement'];

  let fragIssues = 0;

  // Check 1: Known bad outlets still present
  for (const bad of KNOWN_BAD_OUTLETS) {
    if (outletIndex[bad]) {
      warn(`Scraping artifact outlet "${bad}" still has ${outletIndex[bad].count} reviews — these need outlet reassignment`);
      fragIssues++;
    }
  }

  // Check 2: Same display name, different outlet_id (exact match)
  const byDisplayName = {};
  for (const [oid, info] of Object.entries(outletIndex)) {
    const display = info.displayName.toLowerCase().trim();
    if (!byDisplayName[display]) byDisplayName[display] = [];
    byDisplayName[display].push({ oid, count: info.count });
  }

  for (const [display, entries] of Object.entries(byDisplayName)) {
    if (entries.length > 1) {
      const total = entries.reduce((sum, e) => sum + e.count, 0);
      const ids = entries.map(e => `${e.oid}(${e.count})`).join(', ');
      warn(`Outlet fragmentation: "${display}" split across ${entries.length} IDs: ${ids} (${total} total reviews)`);
      fragIssues++;
    }
  }

  // Check 3: outlet_id doesn't survive round-trip normalization
  // If normalizeOutlet(outlet_id) returns a DIFFERENT id, that means the
  // outlet_id was created before its alias was added
  for (const [oid, info] of Object.entries(outletIndex)) {
    const canonical = normalizeOutlet(oid);
    if (canonical !== oid && outletIndex[canonical]) {
      // This outlet_id normalizes to a different existing outlet
      warn(`Outlet "${oid}" (${info.count} reviews) normalizes to "${canonical}" (${outletIndex[canonical].count} reviews) — will merge on next rebuild`);
      fragIssues++;
    }
  }

  if (fragIssues === 0) {
    ok('No outlet fragmentation detected');
  } else {
    info(`${fragIssues} outlet fragmentation issue(s) found — run rebuild to resolve`);
  }
}

/**
 * Detect duplicate outlet entries in outlet-registry.json.
 * Each outlet should have ONE canonical entry. Duplicates cause:
 * - Inconsistent tier assignments (last entry wins)
 * - Duplicate reviews in reviews.json after rebuild
 * - Unreliable cross-market guard decisions
 */
function validateOutletRegistryDuplicates() {
  info('Checking outlet-registry.json for duplicate entries...');
  const registryFile = path.join(DATA_DIR, 'outlet-registry.json');
  if (!fs.existsSync(registryFile)) {
    info('outlet-registry.json does not exist, skipping');
    return;
  }

  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  const outlets = registry.outlets || registry;
  const aliasIndex = registry._aliasIndex || {};

  // Build a map of displayName → list of outlet IDs
  const byDisplayName = {};
  for (const [id, entry] of Object.entries(outlets)) {
    if (id === '_aliasIndex' || id === '_meta') continue;
    if (!entry || !entry.displayName) continue;
    const key = entry.displayName.toLowerCase().trim();
    if (!byDisplayName[key]) byDisplayName[key] = [];
    byDisplayName[key].push({ id, tier: entry.tier });
  }

  let dupeCount = 0;
  for (const [name, entries] of Object.entries(byDisplayName)) {
    if (entries.length > 1) {
      const ids = entries.map(e => `${e.id} (tier ${e.tier})`).join(', ');
      error(`[registry-duplicate] "${name}" has ${entries.length} entries: ${ids} — merge into one canonical`);
      dupeCount++;
    }
  }

  // Also check for outlet IDs that are aliases of each other
  for (const [id, entry] of Object.entries(outlets)) {
    if (id === '_aliasIndex' || id === '_meta') continue;
    if (!entry || !entry.aliases) continue;
    for (const alias of entry.aliases) {
      if (outlets[alias] && alias !== id) {
        error(`[registry-duplicate] "${id}" lists "${alias}" as alias, but "${alias}" also exists as a separate outlet entry — remove one`);
        dupeCount++;
      }
    }
  }

  if (dupeCount === 0) {
    ok('No duplicate outlet entries in outlet-registry.json');
  } else {
    error(`Found ${dupeCount} duplicate outlet entries in outlet-registry.json`);
  }
}

/**
 * Primary-domain collisions must be declared edition pairs.
 * Logic lives in scripts/lib/outlet-registry-domain-collisions.js (§15);
 * colocated test: tests/unit/outlet-registry-domain-collisions.test.mjs.
 */
function validateOutletRegistryDomainCollisions() {
  info('Checking outlet-registry.json for undeclared primary-domain collisions...');
  const registryFile = path.join(DATA_DIR, 'outlet-registry.json');
  if (!fs.existsSync(registryFile)) {
    info('outlet-registry.json does not exist, skipping');
    return;
  }
  const { findUndeclaredDomainCollisions } = require('./lib/outlet-registry-domain-collisions');
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  const collisions = findUndeclaredDomainCollisions(registry.outlets || registry);
  for (const c of collisions) {
    error(`[domain-collision] ${c.domain} is claimed by ${c.outletIds.length} outlets (${c.outletIds.join(', ')}) — URL resolution is ambiguous. Merge the duplicates, fix the domain, or declare the pair in EDITION_PAIRS (scripts/lib/outlet-registry-domain-collisions.js)`);
  }
  if (collisions.length === 0) {
    ok('No undeclared primary-domain collisions in outlet-registry.json');
  } else {
    error(`Found ${collisions.length} undeclared primary-domain collision(s) in outlet-registry.json`);
  }
}

/**
 * Validate outlet-registry.json field shapes:
 *  - starScale must be a number in {4, 5, 10, 100} when present
 *  - multiAuthor must be boolean (true or false) when present
 *
 * Without this, "5" (string) or 7 (unsupported) silently accept, and
 * shouldFillDefaultCritic / parseStarRating/extractor silently misbehave.
 * Ship-check (2026-05-22) caught the gap before any bad data shipped.
 */
function validateOutletRegistryFields() {
  info('Checking outlet-registry.json field shapes (starScale, multiAuthor)...');
  const registryFile = path.join(DATA_DIR, 'outlet-registry.json');
  if (!fs.existsSync(registryFile)) {
    info('outlet-registry.json does not exist, skipping');
    return;
  }
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  const outlets = registry.outlets || registry;

  const ALLOWED_STAR_SCALES = new Set([4, 5, 10, 100]);
  let badFields = 0;
  for (const [id, entry] of Object.entries(outlets)) {
    if (id === '_aliasIndex' || id === '_meta') continue;
    if (!entry || typeof entry !== 'object') continue;

    if (entry.starScale !== undefined) {
      if (typeof entry.starScale !== 'number' || !ALLOWED_STAR_SCALES.has(entry.starScale)) {
        error(`[registry-field] outlet "${id}": starScale=${JSON.stringify(entry.starScale)} is invalid — must be one of ${[...ALLOWED_STAR_SCALES].join(', ')}`);
        badFields++;
      }
    }
    if (entry.multiAuthor !== undefined) {
      if (typeof entry.multiAuthor !== 'boolean') {
        error(`[registry-field] outlet "${id}": multiAuthor=${JSON.stringify(entry.multiAuthor)} must be a boolean (true or false)`);
        badFields++;
      }
    }
  }
  if (badFields === 0) {
    ok('outlet-registry.json starScale + multiAuthor field shapes are valid');
  } else {
    error(`Found ${badFields} invalid starScale/multiAuthor fields in outlet-registry.json`);
  }
}

/**
 * Validate outlet alias integrity in outlet-registry.json.
 * Catches: cross-outlet alias collisions, _aliasIndex conflicts with aliases arrays.
 */
function validateOutletAliasIntegrity() {
  info('Checking outlet alias integrity...');
  const registryFile = path.join(DATA_DIR, 'outlet-registry.json');
  if (!fs.existsSync(registryFile)) {
    info('outlet-registry.json does not exist, skipping');
    return;
  }

  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  const outlets = registry.outlets || {};
  const aliasIndex = registry._aliasIndex || {};
  let issues = 0;

  // Build alias → outlet ID map from aliases arrays
  const aliasOwners = {}; // alias string → [outletId, outletId, ...]
  for (const [id, entry] of Object.entries(outlets)) {
    if (id === '_aliasIndex' || id === '_meta' || !entry) continue;
    for (const alias of (entry.aliases || [])) {
      const key = alias.toLowerCase().trim();
      if (!aliasOwners[key]) aliasOwners[key] = [];
      aliasOwners[key].push(id);
    }
  }

  // Check 1: Cross-outlet alias collision (same alias in 2+ DIFFERENT outlets)
  for (const [alias, owners] of Object.entries(aliasOwners)) {
    const unique = [...new Set(owners)];
    if (unique.length > 1) {
      error(`[alias-collision] "${alias}" claimed by ${unique.length} outlets: ${unique.join(', ')} — assign to one only`);
      issues++;
    }
  }

  // Check 2: _aliasIndex conflicts with aliases arrays
  for (const [alias, indexTarget] of Object.entries(aliasIndex)) {
    if (alias === '_note') continue;
    const key = alias.toLowerCase().trim();
    const arrayOwners = aliasOwners[key];
    if (arrayOwners && arrayOwners.length === 1 && arrayOwners[0] !== indexTarget) {
      error(`[alias-conflict] "${alias}" → "${indexTarget}" in _aliasIndex, but "${arrayOwners[0]}" claims it in aliases array`);
      issues++;
    }
  }

  if (issues === 0) {
    ok('No outlet alias integrity issues');
  } else {
    error(`Found ${issues} outlet alias integrity issue(s)`);
  }
}

/**
 * Validate sync between outlet mapping systems.
 * Post April 2026 refactor: OUTLET_TIERS is loaded from src/config/outlet-tiers.json
 * (both scoring.ts and scripts/lib/compute-critic-score.js import from this single file).
 * This check now verifies (a) the JSON is loadable and structurally valid, and
 * (b) every key in OUTLET_TIERS also exists in outlet-registry.json (so that long-tail
 * outlets resolved via the registry don't silently disagree — when they do, the JSON wins).
 */
function validateOutletMapperSync() {
  info('Checking OUTLET_TIERS ↔ registry sync...');

  const registryFile = path.join(DATA_DIR, 'outlet-registry.json');
  const outletTiersFile = path.join(__dirname, '..', 'src', 'config', 'outlet-tiers.json');

  if (!fs.existsSync(registryFile) || !fs.existsSync(outletTiersFile)) {
    info('Skipping OUTLET_TIERS sync check (files not found)');
    return;
  }

  let registry, tiers;
  try {
    registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    tiers = JSON.parse(fs.readFileSync(outletTiersFile, 'utf8'));
  } catch (e) {
    error(`[tier-sync] Failed to parse outlet-tiers.json or outlet-registry.json: ${e.message}`);
    return;
  }
  const registryOutlets = registry.outlets || registry;

  const tierKeys = Object.keys(tiers);

  // Structural sanity — each entry must have tier/name/scoreFormat
  let structuralIssues = 0;
  for (const [id, entry] of Object.entries(tiers)) {
    if (!VALID_TIERS.includes(entry.tier)) {
      warn(`[tier-sync] outlet-tiers.json: "${id}" has invalid tier ${entry.tier}`);
      structuralIssues++;
    }
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      warn(`[tier-sync] outlet-tiers.json: "${id}" missing name`);
      structuralIssues++;
    }
  }

  // Registry coverage — every override must also exist in the registry as a known outlet
  let missingFromRegistry = 0;
  const tierDisagreements = [];
  for (const [id, entry] of Object.entries(tiers)) {
    if (!registryOutlets[id]) {
      warn(`[tier-sync] outlet-tiers.json key "${id}" not found in outlet-registry.json — tier override is orphaned`);
      missingFromRegistry++;
    } else if (registryOutlets[id].tier !== undefined && registryOutlets[id].tier !== entry.tier) {
      // Not an error — outlet-tiers.json wins by design (layered in scripts/lib/outlet-tiers.js)
      // but we report disagreements so the user knows one side will override the other.
      tierDisagreements.push(`${id}: tiers=${entry.tier}, registry=${registryOutlets[id].tier}`);
    }
  }

  if (tierDisagreements.length > 0) {
    info(`[tier-sync] ${tierDisagreements.length} outlet(s) have different tiers in outlet-tiers.json vs outlet-registry.json — the JSON overrides the registry: ${tierDisagreements.join(', ')}`);
  }

  if (structuralIssues === 0 && missingFromRegistry === 0) {
    ok(`All ${tierKeys.length} outlet-tiers.json entries valid and present in registry`);
  }
}

/**
 * Validate that review outlet IDs resolve to known scoring tiers.
 * Catches: unresolvable outlets (silently default to Tier 3) and potential typo outlets.
 */
function validateReviewOutletTiers() {
  info('Checking review outlet tier resolution...');

  const reviewsFile = path.join(DATA_DIR, 'reviews.json');
  if (!fs.existsSync(reviewsFile)) return;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
  } catch { return; }

  const reviews = data.reviews || [];

  // Read OUTLET_TIERS keys directly from scoring.ts (now lowercase registry IDs)
  const scoringFile = path.join(__dirname, '..', 'src', 'config', 'scoring.ts');
  if (!fs.existsSync(scoringFile)) {
    info('scoring.ts not found, skipping');
    return;
  }

  const scoringSrc = fs.readFileSync(scoringFile, 'utf8');
  const tierKeys = new Set();
  const tierPattern = /['"]([\w-]+)['"]\s*:\s*\{\s*tier:\s*\d/g;
  let match;
  while ((match = tierPattern.exec(scoringSrc)) !== null) {
    tierKeys.add(match[1].toLowerCase());
  }

  // Count reviews per outlet and check tier resolution
  const outletCounts = {};
  for (const r of reviews) {
    const oid = (r.outletId || '').toLowerCase();
    if (!oid) continue;
    outletCounts[oid] = (outletCounts[oid] || 0) + 1;
  }

  const unresolvable = [];
  const lowCount = [];

  for (const [oid, count] of Object.entries(outletCounts)) {
    if (!tierKeys.has(oid)) {
      unresolvable.push({ oid, count });
    }
    // Flag outlets with very few reviews as potential typos
    if (count < 3) {
      lowCount.push({ oid, count });
    }
  }

  if (unresolvable.length > 0) {
    // Only warn about unresolvable outlets — many are legitimate Tier 3 blogs
    const total = unresolvable.reduce((s, o) => s + o.count, 0);
    info(`${unresolvable.length} outlet IDs in reviews.json don't resolve to known scoring tiers (${total} reviews, defaulting to Tier 3)`);
    // Show top 10 by review count
    unresolvable.sort((a, b) => b.count - a.count);
    for (const { oid, count } of unresolvable.slice(0, 10)) {
      info(`  ${oid}: ${count} reviews`);
    }
  } else {
    ok('All review outlet IDs resolve to known scoring tiers');
  }

  if (lowCount.length > 0) {
    info(`${lowCount.length} outlets have fewer than 3 reviews (potential typos — verify if new)`);
  }
}

// ===========================================
// P0 EXPLICIT SCORE COVERAGE
// ===========================================

/**
 * Monitor P0 (explicit score) coverage by outlet. Flags outlets with
 * dedicated score extractors but low P0 rates — indicates collection gap
 * (reviews collected via aggregators without HTML for extraction).
 */
function validateP0ScoreCoverage() {
  info('Checking P0 explicit score coverage by outlet...');

  const reviewsFile = path.join(DATA_DIR, 'reviews.json');
  if (!fs.existsSync(reviewsFile)) return;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
  } catch { return; }

  const reviews = data.reviews || [];

  // Outlets that have dedicated score extractors (not noScoreExtractor)
  // These SHOULD have high P0 rates when HTML is available
  const extractorOutlets = new Set([
    'timeout', 'ew', 'usatoday', 'guardian', 'standard', 'independent',
    'culturesauce', 'whatsonstage', 'telegraph', 'thestage', 'times-uk',
    'nysr', 'theater-pizzazz', 'theater-life', 'uk-theatre-web',
    'londontheatre', 'broadwayworld'
  ]);

  const stats = {};
  for (const r of reviews) {
    const oid = (r.outletId || '').toLowerCase();
    if (!extractorOutlets.has(oid)) continue;
    if (!stats[oid]) stats[oid] = { total: 0, p0: 0, llm: 0, other: 0 };
    stats[oid].total++;
    const src = r.scoreSource || '';
    if (src.startsWith('originalScore')) stats[oid].p0++;
    else if (src.startsWith('llm')) stats[oid].llm++;
    else stats[oid].other++;
  }

  let lowP0 = 0;
  const entries = Object.entries(stats).sort((a, b) => b[1].total - a[1].total);

  for (const [oid, s] of entries) {
    if (s.total < 5) continue; // Skip outlets with too few reviews
    const p0Rate = s.p0 / s.total;
    if (p0Rate < 0.5) {
      lowP0++;
      warn(`P0 coverage gap: ${oid} — ${s.p0}/${s.total} P0 (${(p0Rate * 100).toFixed(0)}%), ${s.llm} LLM-scored`);
    }
  }

  if (lowP0 === 0) {
    ok('All extractor outlets have >50% P0 coverage');
  } else {
    info(`${lowP0} extractor outlet(s) below 50% P0 — re-collection may help`);
  }

  // Summary stats
  const totalP0 = entries.reduce((s, [, v]) => s + v.p0, 0);
  const totalAll = entries.reduce((s, [, v]) => s + v.total, 0);
  info(`Extractor outlet P0 rate: ${totalP0}/${totalAll} (${totalAll > 0 ? (totalP0 / totalAll * 100).toFixed(0) : 0}%)`);
}

// ===========================================
// REVIEW-TEXT DUPLICATE DETECTION
// ===========================================

/**
 * Detect duplicate review-text files:
 * 1. Per-show: files with the same normalized outlet+critic (filename-based, no file reads)
 * 2. Cross-show: files sharing the same URL (requires reading file contents)
 *
 * Skips flagged files (wrongProduction, wrongShow, isRoundupArticle, etc.) for URL checks.
 */
/**
 * Detect unflagged tour/regional reviews attributed to Broadway productions.
 * Scans review-text source files for regional BWW URLs and local paper tour indicators
 * that don't have wrongProduction set. Warns if >30% of a show's reviews are regional.
 */
function validateTourReviewContamination() {
  info('Checking for unflagged tour/regional review contamination...');

  const reviewTextsDir = path.join(DATA_DIR, 'review-texts');
  if (!fs.existsSync(reviewTextsDir)) {
    info('review-texts directory not found, skipping');
    return;
  }

  let isLikelyTourReview;
  try {
    isLikelyTourReview = require('./lib/review-guards').isLikelyTourReview;
  } catch {
    info('review-guards.js not found, skipping tour contamination check');
    return;
  }

  const showDirs = fs.readdirSync(reviewTextsDir).filter(d => {
    try { return fs.statSync(path.join(reviewTextsDir, d)).isDirectory() && !d.startsWith('.'); }
    catch { return false; }
  });

  let totalUnflagged = 0;
  const contaminated = [];

  for (const showDir of showDirs) {
    const showPath = path.join(reviewTextsDir, showDir);
    const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json'));
    let tourCount = 0;
    let activeCount = 0;

    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showPath, f), 'utf8'));
        if (data.wrongProduction || data.wrongShow || data.isRoundupArticle) continue;
        activeCount++;
        if (isLikelyTourReview(data.url, showDir)) {
          tourCount++;
        }
      } catch { /* skip malformed */ }
    }

    if (tourCount > 0) {
      totalUnflagged += tourCount;
      const pct = activeCount > 0 ? Math.round((tourCount / activeCount) * 100) : 0;
      if (pct > 30 || tourCount >= 5) {
        contaminated.push({ show: showDir, tour: tourCount, active: activeCount, pct });
      }
    }
  }

  if (totalUnflagged === 0) {
    ok('No unflagged tour/regional reviews found');
  } else if (contaminated.length > 0) {
    for (const c of contaminated) {
      warn(`Tour contamination: "${c.show}" has ${c.tour}/${c.active} unflagged tour reviews (${c.pct}%)`);
    }
  } else {
    info(`${totalUnflagged} minor tour reviews detected (below warning thresholds)`);
  }
}

/**
 * Detect review files where aggregator star ratings leaked into originalScore.
 * These should be stored as aggregatorStars metadata only.
 */
function validateAggregatorScoreContamination() {
  info('Checking for aggregator scores stored as originalScore...');

  const reviewTextsDir = path.join(DATA_DIR, 'review-texts');
  if (!fs.existsSync(reviewTextsDir)) return;

  const { AGGREGATOR_SCORE_SOURCES } = require('./lib/review-normalization');

  const showDirs = fs.readdirSync(reviewTextsDir).filter(d => {
    try { return fs.statSync(path.join(reviewTextsDir, d)).isDirectory() && !d.startsWith('.') && d !== 'aggregator-archive'; }
    catch { return false; }
  });

  let contaminated = 0;
  const examples = [];

  for (const showDir of showDirs) {
    const showPath = path.join(reviewTextsDir, showDir);
    const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showPath, f), 'utf8'));
        if (data.scoreSource && AGGREGATOR_SCORE_SOURCES.has(data.scoreSource) && data.originalScore != null) {
          contaminated++;
          if (examples.length < 5) examples.push(`${showDir}/${f}`);
        }
      } catch { /* skip */ }
    }
  }

  if (contaminated === 0) {
    ok('No aggregator scores stored as originalScore');
  } else {
    error(`${contaminated} review files have aggregator scores as originalScore (should be aggregatorStars). Examples: ${examples.join(', ')}`);
  }
}

/**
 * Detect Broadway/US reviews incorrectly in West End show directories.
 * Catches: NYC outlet URLs, "broadway" in URL path, known US-only outlets.
 * Only checks unflagged files (wrongProduction/wrongShow not set).
 */
function validateCrossMarketSourceFiles() {
  info('Checking review source files for cross-market contamination (Broadway in WE)...');

  const reviewTextsDir = path.join(DATA_DIR, 'review-texts');
  if (!fs.existsSync(reviewTextsDir)) return;

  // Use shared patterns from venue-classification.js (single source of truth)
  const { isBroadwayUrl } = require('./lib/venue-classification');

  const showDirs = fs.readdirSync(reviewTextsDir).filter(d => {
    try { return d.includes('west-end') && fs.statSync(path.join(reviewTextsDir, d)).isDirectory(); }
    catch { return false; }
  });

  const problems = [];

  for (const showDir of showDirs) {
    const showPath = path.join(reviewTextsDir, showDir);
    const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json'));

    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showPath, f), 'utf8'));
        if (data.wrongProduction || data.wrongShow || data.fabricatedEntry) continue;

        const reason = isBroadwayUrl(data.url, data.outletId);
        if (reason) {
          problems.push({ show: showDir, file: f, reason });
        }
      } catch { /* skip malformed */ }
    }
  }

  if (problems.length === 0) {
    ok('No cross-market contamination found (Broadway reviews in WE shows)');
  } else {
    for (const p of problems) {
      warn(`Cross-market: "${p.show}/${p.file}" — ${p.reason}`);
    }
    warn(`${problems.length} unflagged Broadway/US reviews in WE show directories`);
  }
}

function validateReviewTextDuplicates(shows) {
  info('Checking for duplicate review-text files...');

  const reviewTextsDir = path.join(DATA_DIR, 'review-texts');
  if (!fs.existsSync(reviewTextsDir)) {
    info('No review-texts directory');
    return;
  }

  // Aggregator sources legitimately share URLs across shows (roundup pages)
  const AGGREGATOR_SOURCES = new Set([
    'bww-roundup', 'bww-reviews', 'playbill-verdict', 'dtli',
    'show-score', 'show-score-playwright', 'nyc-theatre-roundup'
  ]);

  let filesScanned = 0;
  let dupeGroups = 0;
  const urlMap = new Map(); // normalizedUrl -> [{showId, file, isAggregator}]

  const showDirs = fs.readdirSync(reviewTextsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));

  // Detect non-canonical directories (slug-named dirs that should have been merged into ID dirs)
  const slugOnlyDirs = showDirs.filter(d => {
    return shows.some(s => s.slug === d.name && s.id !== d.name);
  });
  if (slugOnlyDirs.length > 0) {
    warn(`${slugOnlyDirs.length} non-canonical (slug-named) review-text directories found: ${slugOnlyDirs.slice(0, 5).map(d => d.name).join(', ')}. Run: node scripts/merge-slug-directories.js`);
  }

  for (const dir of showDirs) {
    const showDir = path.join(reviewTextsDir, dir.name);
    let files;
    try {
      files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch { continue; }

    // Per-show: group by normalized outlet+critic from filename
    const keyGroups = new Map();
    for (const file of files) {
      filesScanned++;
      const match = file.match(/^(.+?)--(.+)\.json$/);
      if (!match) continue;
      const [, outletId, criticSlug] = match;
      // Normalize the outlet ID through canonical to catch variant IDs
      // (e.g., ny-daily-news vs nydailynews, bloomberg vs bloomberg-news)
      const canonicalOutlet = normalizeOutlet ? normalizeOutlet(outletId) : outletId;
      const key = `${canonicalOutlet}|${criticSlug}`;
      if (!keyGroups.has(key)) keyGroups.set(key, []);
      keyGroups.get(key).push(file);
    }

    for (const [, group] of keyGroups) {
      if (group.length > 1) {
        dupeGroups++;
      }
    }

    // Cross-show URL check: read each file, extract URL, check global map
    for (const file of files) {
      const filePath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // Skip flagged files — these are intentional duplicates or known-bad entries
        if (data.wrongProduction || data.wrongShow || data.isRoundupArticle ||
            data.isCombinedReview || data.duplicateOf || data.fabricatedEntry) continue;
        if (!data.url) continue;
        // URL normalization: strip protocol, www, trailing slash, query/fragment, lowercase
        const normUrl = data.url.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
        if (!normUrl) continue;
        // Check if all sources are aggregator-based
        const allSources = new Set();
        if (data.source) allSources.add(data.source);
        if (data.sources) data.sources.forEach(s => allSources.add(s));
        const isAggregator = allSources.size > 0 && [...allSources].some(s => AGGREGATOR_SOURCES.has(s));

        if (!urlMap.has(normUrl)) urlMap.set(normUrl, []);
        urlMap.get(normUrl).push({ showId: dir.name, file, isAggregator });
      } catch { continue; }
    }
  }

  // Report cross-show URL dupes, separating aggregator-only from non-aggregator
  let crossShowDupesAgg = 0;
  let crossShowDupesNonAgg = 0;
  for (const [, entries] of urlMap) {
    const uniqueShows = new Set(entries.map(e => e.showId));
    if (uniqueShows.size <= 1) continue;
    const allAggregator = entries.every(e => e.isAggregator);
    if (allAggregator) crossShowDupesAgg++;
    else crossShowDupesNonAgg++;
  }

  // Thresholds — non-aggregator cross-show dupes are the real concern.
  // Baseline ~144 after multi-critic URL dedup fix (Apr 2026) — previously ~53 when
  // aggressive URL dedup masked cross-show duplicates by dropping multi-critic reviews.
  // Remaining are revival pairs and cross-market shows needing manual review.
  if (crossShowDupesNonAgg > 180) {
    error(`${crossShowDupesNonAgg} non-aggregator cross-show URL duplicates (baseline ~144, spike suggests data issue)`);
  } else if (crossShowDupesNonAgg > 160) {
    warn(`${crossShowDupesNonAgg} non-aggregator cross-show URL duplicate(s) found (baseline ~144)`);
  }
  // Baseline ~0 after consolidation (Feb 2026). New dupes come from collection scripts using non-canonical outlet IDs.
  if (dupeGroups > 50) {
    error(`${dupeGroups} per-show outlet+critic duplicate groups (baseline ~0, spike suggests normalizer bug)`);
  } else if (dupeGroups > 20) {
    warn(`${dupeGroups} per-show outlet+critic duplicate groups (baseline ~0)`);
  }

  ok(`Review-text duplicates: ${filesScanned} files, ${dupeGroups} intra-show dupe groups, ${crossShowDupesNonAgg} non-agg cross-show URL dupes (${crossShowDupesAgg} aggregator)`);
}

// ===========================================
// COMMERCIAL DATA VALIDATION
// ===========================================

// Valid costMethodology values for commercial data
const VALID_COST_METHODOLOGIES = [
  'reddit-standard',
  'trade-reported',
  'sec-filing',
  'producer-confirmed',
  'deep-research',
  'industry-estimate'
];

function validateCommercialJson() {
  info('Checking commercial.json...');

  if (!fs.existsSync(COMMERCIAL_FILE)) {
    warn('commercial.json does not exist (optional)');
    return;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(COMMERCIAL_FILE, 'utf8'));
    ok('commercial.json is valid JSON');
  } catch (e) {
    error(`commercial.json parse error: ${e.message}`);
    return;
  }

  // Load shows.json for venue/nonprofitOrg cross-validation. Optional —
  // if shows.json is missing we skip the venue check rather than fail.
  let showsData = null;
  try {
    showsData = loadShows();
  } catch {
    // skip venue/org cross-check
  }

  // Validate _meta.designations exists
  if (!data._meta || !data._meta.designations || typeof data._meta.designations !== 'object') {
    error('commercial.json missing _meta.designations object');
  } else {
    ok('commercial.json has _meta.designations');
  }

  if (!data.shows || typeof data.shows !== 'object') {
    warn('commercial.json missing "shows" object');
    return;
  }

  // 'enhancement' = nonprofit-shell + commercial-co-producer deals (LCT, MTC,
  // Roundabout, Second Stage, Public). These productions look "Nonprofit" by
  // designation but have a commercial capital stack that DOES recoup. Ragtime
  // 2025 was the canonical case — caught 2026-05-24 misclassified as pure
  // Nonprofit even though Playbill explicitly reported recoupment.
  const validProductionTypes = ['original', 'tour-stop', 'return-engagement', 'international-transfer', 'International Transfer', 'enhancement'];
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  const showKeys = Object.keys(data.shows);
  let issues = 0;

  for (const showId of showKeys) {
    const show = data.shows[showId];

    // Validate productionType
    if (show.productionType !== undefined) {
      if (!validProductionTypes.includes(show.productionType)) {
        error(`commercial.json: "${showId}" has invalid productionType: "${show.productionType}" (must be one of: ${validProductionTypes.join(', ')})`);
        issues++;
      }
    }

    // Validate estimatedRecoupmentPct
    if (show.estimatedRecoupmentPct != null) {
      if (!Array.isArray(show.estimatedRecoupmentPct) || show.estimatedRecoupmentPct.length !== 2) {
        error(`commercial.json: "${showId}" estimatedRecoupmentPct must be a 2-element array [low, high]`);
        issues++;
      } else {
        const [low, high] = show.estimatedRecoupmentPct;
        if (typeof low !== 'number' || typeof high !== 'number') {
          error(`commercial.json: "${showId}" estimatedRecoupmentPct values must be numbers`);
          issues++;
        } else if (low < 0 || high > 100 || low > high) {
          error(`commercial.json: "${showId}" estimatedRecoupmentPct must satisfy 0 <= low <= high <= 100, got [${low}, ${high}]`);
          issues++;
        }
      }
    }

    // Validate originalProductionId references an existing show
    if (show.originalProductionId !== undefined) {
      if (!data.shows[show.originalProductionId]) {
        error(`commercial.json: "${showId}" originalProductionId "${show.originalProductionId}" does not reference an existing show in commercial.json`);
        issues++;
      }
    }

    // Validate isEstimate is an object with boolean values
    if (show.isEstimate !== undefined) {
      if (typeof show.isEstimate !== 'object' || Array.isArray(show.isEstimate) || show.isEstimate === null) {
        error(`commercial.json: "${showId}" isEstimate must be an object`);
        issues++;
      } else {
        for (const [key, val] of Object.entries(show.isEstimate)) {
          if (typeof val !== 'boolean') {
            error(`commercial.json: "${showId}" isEstimate.${key} must be a boolean, got ${typeof val}`);
            issues++;
          }
        }
      }
    }

    // Validate estimatedRecoupmentDate format
    if (show.estimatedRecoupmentDate !== undefined) {
      if (!dateRegex.test(show.estimatedRecoupmentDate)) {
        error(`commercial.json: "${showId}" estimatedRecoupmentDate must be YYYY-MM-DD format, got "${show.estimatedRecoupmentDate}"`);
        issues++;
      }
    }

    // Cross-validation: Tour Stop designation must have tour-stop or return-engagement productionType
    if (show.designation === 'Tour Stop') {
      if (show.productionType !== 'tour-stop' && show.productionType !== 'return-engagement') {
        error(`commercial.json: "${showId}" has designation "Tour Stop" but productionType is "${show.productionType || 'missing'}" (must be "tour-stop" or "return-engagement")`);
        issues++;
      }
    }

    // Cross-validation: tour-stop productionType must have Tour Stop designation
    if (show.productionType === 'tour-stop') {
      if (show.designation !== 'Tour Stop') {
        error(`commercial.json: "${showId}" has productionType "tour-stop" but designation is "${show.designation || 'missing'}" (must be "Tour Stop")`);
        issues++;
      }
    }

    // CRITICAL: Recouped shows MUST have recoupedDate (used to calculate weeks)
    if (show.recouped === true && !show.recoupedDate) {
      error(`commercial.json: "${showId}" has recouped=true but missing recoupedDate (REQUIRED for weeks calculation)`);
      issues++;
    }

    // Outcome-driven designation policy (memory/feedback_enhancement_deal_designation_policy.md):
    // Easy Winner / Windfall / Miracle imply the production recouped — require recouped=true.
    // Flop / Fizzle imply it did not — require recouped=false (null means we don't know).
    // Catches the purpose-2025 / floyd-collins-2025 class of inconsistency.
    const WIN_DESIGNATIONS = ['Easy Winner', 'Windfall', 'Miracle'];
    const LOSS_DESIGNATIONS = ['Flop', 'Fizzle'];
    if (WIN_DESIGNATIONS.includes(show.designation) && show.recouped !== true) {
      error(`commercial.json: "${showId}" has designation "${show.designation}" but recouped=${JSON.stringify(show.recouped)} (policy: win-designations require recouped=true with hard citation, see memory/feedback_enhancement_deal_designation_policy.md)`);
      issues++;
    }
    if (LOSS_DESIGNATIONS.includes(show.designation) && show.recouped !== false) {
      error(`commercial.json: "${showId}" has designation "${show.designation}" but recouped=${JSON.stringify(show.recouped)} (policy: loss-designations require recouped=false with hard citation; demote to "Nonprofit" or "TBD" if outcome unknown)`);
      issues++;
    }

    // nonprofitOrg must match the show's venue. Catches the inverse of the
    // purpose-2025/job-2024 trap: tagging Liberation as Roundabout when the
    // venue was actually James Earl Jones (ATG commercial). Does NOT catch
    // commercial-rentals-at-correct-venue — that needs season-membership
    // verification, see memory/feedback_nonprofit_venue_vs_production.md.
    if (show.nonprofitOrg) {
      const showRecord = showsData?.shows?.find?.(s => s.slug === showId);
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
          error(`commercial.json: "${showId}" has nonprofitOrg="${show.nonprofitOrg}" but venue is "${showRecord.venue}" (expected one of: ${allowed.join(', ')}). Likely a stale tag — was this a commercial production at a non-nonprofit venue?`);
          issues++;
        }
      }
    }

    // Validate recoupedDate format if present (YYYY-MM or YYYY)
    if (show.recoupedDate) {
      const validRecoupDateFormat = /^\d{4}(-\d{2})?$/;
      if (!validRecoupDateFormat.test(show.recoupedDate)) {
        error(`commercial.json: "${showId}" recoupedDate must be YYYY-MM or YYYY format, got "${show.recoupedDate}"`);
        issues++;
      }
    }

    // Validate profitMargin (if present, must be a number)
    if (show.profitMargin !== undefined && show.profitMargin !== null && typeof show.profitMargin !== 'number') {
      error(`commercial.json: "${showId}" profitMargin must be a number, got ${typeof show.profitMargin}`);
      issues++;
    }

    // Validate investorMultiple (if present, must be a number >= 0)
    if (show.investorMultiple !== undefined && show.investorMultiple !== null) {
      if (typeof show.investorMultiple !== 'number') {
        error(`commercial.json: "${showId}" investorMultiple must be a number, got ${typeof show.investorMultiple}`);
        issues++;
      } else if (show.investorMultiple < 0) {
        error(`commercial.json: "${showId}" investorMultiple must be >= 0, got ${show.investorMultiple}`);
        issues++;
      }
    }

    // Validate insiderProfitSharePct (if present, must be a number 0-100)
    if (show.insiderProfitSharePct !== undefined && show.insiderProfitSharePct !== null) {
      if (typeof show.insiderProfitSharePct !== 'number') {
        error(`commercial.json: "${showId}" insiderProfitSharePct must be a number, got ${typeof show.insiderProfitSharePct}`);
        issues++;
      } else if (show.insiderProfitSharePct < 0 || show.insiderProfitSharePct > 100) {
        error(`commercial.json: "${showId}" insiderProfitSharePct must be 0-100, got ${show.insiderProfitSharePct}`);
        issues++;
      }
    }

    // Validate sources array (if present)
    if (show.sources !== undefined && show.sources !== null) {
      if (!Array.isArray(show.sources)) {
        error(`commercial.json: "${showId}" sources must be an array`);
        issues++;
      } else {
        const validSourceTypes = ['trade', 'reddit', 'sec', 'manual'];
        const sourceDateRegex = /^\d{4}-\d{2}-\d{2}$/;
        show.sources.forEach((src, idx) => {
          if (!src.type || !validSourceTypes.includes(src.type)) {
            error(`commercial.json: "${showId}" sources[${idx}].type must be one of: ${validSourceTypes.join(', ')}`);
            issues++;
          }
          if (!src.url || typeof src.url !== 'string') {
            error(`commercial.json: "${showId}" sources[${idx}].url must be a string`);
            issues++;
          }
          // Date is optional (null/undefined allowed) — many venue/aggregator URLs lack a publish date.
          // But if present, it must match YYYY-MM-DD.
          if (src.date != null && (typeof src.date !== 'string' || !sourceDateRegex.test(src.date))) {
            error(`commercial.json: "${showId}" sources[${idx}].date must be in YYYY-MM-DD format (or null)`);
            issues++;
          }
        });
      }
    }

    // Validate costMethodology
    if (show.costMethodology && !VALID_COST_METHODOLOGIES.includes(show.costMethodology)) {
      error(`commercial.json: "${showId}" has invalid costMethodology "${show.costMethodology}". Valid values: ${VALID_COST_METHODOLOGIES.join(', ')}`);
      issues++;
    }

    // Validate deepResearch object if present
    if (show.deepResearch) {
      const dr = show.deepResearch;

      // verifiedFields must be an array of strings
      if (!Array.isArray(dr.verifiedFields)) {
        error(`commercial.json: "${showId}" deepResearch.verifiedFields must be an array`);
        issues++;
      } else if (dr.verifiedFields.length === 0) {
        error(`commercial.json: "${showId}" deepResearch.verifiedFields cannot be empty`);
        issues++;
      } else if (!dr.verifiedFields.every(f => typeof f === 'string')) {
        error(`commercial.json: "${showId}" deepResearch.verifiedFields must contain only strings`);
        issues++;
      }

      // verifiedDate must be an ISO date string (YYYY-MM-DD)
      if (!dr.verifiedDate) {
        error(`commercial.json: "${showId}" deepResearch.verifiedDate is required`);
        issues++;
      } else if (!dateRegex.test(dr.verifiedDate)) {
        error(`commercial.json: "${showId}" deepResearch.verifiedDate must be in YYYY-MM-DD format`);
        issues++;
      }

      // verifiedBy is optional but must be string if present
      if (dr.verifiedBy !== undefined && typeof dr.verifiedBy !== 'string') {
        error(`commercial.json: "${showId}" deepResearch.verifiedBy must be a string`);
        issues++;
      }

      // notes is optional but must be string if present
      if (dr.notes !== undefined && typeof dr.notes !== 'string') {
        error(`commercial.json: "${showId}" deepResearch.notes must be a string`);
        issues++;
      }
    }
  }

  if (issues === 0) {
    ok(`Commercial data valid for ${showKeys.length} shows`);
  }
}

// ===========================================
// BLOG REVIEW VALIDATION
// ===========================================

function validateBlogReviews() {
  info('Checking blog review markdown files...');
  const blogDir = path.join(__dirname, '..', 'content', 'reviews');

  if (!fs.existsSync(blogDir)) {
    info('No content/reviews/ directory found, skipping blog validation');
    return;
  }

  const files = fs.readdirSync(blogDir).filter(f => f.endsWith('.md') && !f.startsWith('_'));
  if (files.length === 0) {
    info('No blog reviews found');
    return;
  }

  let grayMatter;
  try {
    grayMatter = require('gray-matter');
  } catch (e) {
    info('gray-matter not installed, skipping blog validation');
    return;
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  const slugs = new Set();
  let issues = 0;

  // Load shows.json for showSlug validation
  let showSlugs = new Set();
  try {
    const showsData = loadShows();
    const shows = showsData.shows || showsData;
    showSlugs = new Set(shows.map(s => s.slug || s.id));
  } catch (e) {
    // Can't validate showSlug without shows.json
  }

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');

    // Check for duplicate slugs (filenames)
    if (slugs.has(slug)) {
      error(`Blog: duplicate slug "${slug}" (multiple files with same name)`);
      issues++;
    }
    slugs.add(slug);

    try {
      const raw = fs.readFileSync(path.join(blogDir, file), 'utf8');
      const { data } = grayMatter(raw);

      // Required fields
      if (!data.title || typeof data.title !== 'string') {
        error(`Blog ${file}: missing or invalid "title"`);
        issues++;
      }
      if (!data.show || typeof data.show !== 'string') {
        error(`Blog ${file}: missing or invalid "show"`);
        issues++;
      }
      if (!data.venue || typeof data.venue !== 'string') {
        error(`Blog ${file}: missing or invalid "venue"`);
        issues++;
      }
      if (data.score === undefined || data.score === null) {
        error(`Blog ${file}: missing "score"`);
        issues++;
      } else {
        const score = Number(data.score);
        if (isNaN(score) || score < 0 || score > 100) {
          error(`Blog ${file}: score must be 0-100, got ${data.score}`);
          issues++;
        }
      }
      if (!data.publishDate) {
        error(`Blog ${file}: missing "publishDate"`);
        issues++;
      } else if (!dateRegex.test(data.publishDate)) {
        error(`Blog ${file}: publishDate must be YYYY-MM-DD, got "${data.publishDate}"`);
        issues++;
      }
      if (data.dateAttended && !dateRegex.test(data.dateAttended)) {
        error(`Blog ${file}: dateAttended must be YYYY-MM-DD, got "${data.dateAttended}"`);
        issues++;
      }

      // Optional field validation
      if (data.showSlug && showSlugs.size > 0 && !showSlugs.has(data.showSlug)) {
        warn(`Blog ${file}: showSlug "${data.showSlug}" not found in shows.json`);
      }
      if (data.heroImage && typeof data.heroImage === 'string' && data.heroImage.length > 0) {
        const imgPath = path.join(__dirname, '..', 'public', data.heroImage);
        if (!fs.existsSync(imgPath)) {
          warn(`Blog ${file}: heroImage "${data.heroImage}" not found in public/`);
        }
      }
    } catch (e) {
      error(`Blog ${file}: failed to parse frontmatter: ${e.message}`);
      issues++;
    }
  }

  if (issues === 0) {
    ok(`Blog reviews valid: ${files.length} file(s)`);
  }
}

// ===========================================
// REVIEW TEXT QUALITY CHECKS (Pre-Launch Audit Prevention)
// Catches garbage reviews, LLM artifacts, encoding issues
// ===========================================

/**
 * Find review-text files that WOULD be included by rebuild-all-reviews.js
 * (pass every skip filter) but have no score from any priority path.
 *
 * Such files are silent data-integrity gaps: the review text is present,
 * nothing has flagged it as wrong production / duplicate / non-review / roundup,
 * but the scorer either never ran on it, or ran and failed without leaving a
 * trace. The rebuild silently skips these via stats.skippedNoScore and the
 * affected outlet disappears from the show's composite score with no warning.
 *
 * Discovered 2026-04-11 during a ship-check audit of death-of-a-salesman-2026
 * when I saw People magazine in the review-texts pool but missing from the
 * breakdown bar. That specific file turned out to be correctly rejected
 * (ensemble-scoreability-check flagged it as 'not_a_review', a preview
 * interview with Nathan Lane, not a review) — but running the same query
 * site-wide surfaced 82 truly-orphaned files across 66 shows with a median
 * age of 57 days. This validator prevents that class of gap from growing
 * silently in the future.
 *
 * The filter mirrors rebuild-all-reviews.js skip logic as of 2026-04-11.
 * If rebuild adds a new skip flag, mirror it here or this validator will
 * start surfacing files that rebuild correctly excludes.
 */
function validateUnscoredReviewTexts() {
  info('Checking for unscored review-text files (silent gaps)...');
  const reviewTextsDir = path.join(DATA_DIR, 'review-texts');
  if (!fs.existsSync(reviewTextsDir)) {
    info('No review-texts directory, skipping');
    return;
  }

  // Load shows.json once so isIncludableForRebuild can apply the
  // isLikelyStaleWrongShow override consistently with the rebuild gate
  // (Notion 34e637c5-416f-8121).
  const showsJsonPath = path.join(DATA_DIR, 'shows.json');
  const showById = {};
  try {
    const showsData = JSON.parse(fs.readFileSync(showsJsonPath, 'utf8'));
    const showsArr = Array.isArray(showsData) ? showsData : (showsData.shows || []);
    for (const s of showsArr) if (s && s.id) showById[s.id] = s;
  } catch { /* fall back to no-override behavior */ }

  let filesScanned = 0;
  const gaps = [];

  const showDirs = fs.readdirSync(reviewTextsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);

  for (const showDir of showDirs) {
    const dirPath = path.join(reviewTextsDir, showDir);
    let files;
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      filesScanned++;
      let r;
      try {
        r = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
      } catch {
        continue; // JSON parse errors caught elsewhere
      }

      // Skip filters + score-presence check live in scripts/lib/review-guards.js
      // (isIncludableForRebuild + hasValidScore) so this validator and
      // scripts/check-review-count-drift.js never drift apart. filePath is passed
      // so duplicateOf circular-recovery matches the drift checker exactly.
      // A silent gap = passes every skip filter BUT has no valid score.
      if (!isIncludableForRebuild(r, showById[showDir], path.join(dirPath, file)) || hasValidScore(r)) continue;

      // This file passes every skip filter and has no score — silent gap.
      const ageDays = r.textFetchedAt
        ? (Date.now() - new Date(r.textFetchedAt).getTime()) / 86400000
        : null;
      gaps.push({
        showDir,
        file,
        outlet: r.outlet || r.outletId || '?',
        critic: r.criticName || '-',
        tier: r.contentTier || '?',
        words: r.textWordCount || r.wordCount || null,
        pending: r.scoreExtractionPending === true,
        ageDays: ageDays != null && Number.isFinite(ageDays) ? Math.round(ageDays) : null,
      });
    }
  }

  if (gaps.length === 0) {
    ok(`No silent scoring gaps — all ${filesScanned} review-text files are scored or legitimately skipped`);
    return;
  }

  // Split by whether the file is actively waiting for scoring. Pending files
  // (scoreExtractionPending=true) are a warn — they'll likely get scored on
  // the next pipeline run. Orphaned files (no pending flag) are an error —
  // nothing is going to pick them up without human intervention.
  const pendingGaps = gaps.filter((g) => g.pending);
  const orphanedGaps = gaps.filter((g) => !g.pending);

  if (pendingGaps.length > 0) {
    // Split fresh vs stuck via scripts/lib/pending-gap-classification.js
    // (unit-tested — see tests/unit/pending-gap-classification.test.mjs).
    // Files pending more than STUCK_PENDING_DAYS are the louder signal that
    // the scorer should have picked them up by now. Schmigadoon 2026 Bug #11:
    // pending files sat for weeks because nothing audited staleness.
    const STUCK_PENDING_DAYS = DEFAULT_STUCK_PENDING_DAYS;
    const { stuck: stuckPendingGaps, fresh: freshPendingGaps } =
      classifyPendingGapsByAge(pendingGaps, STUCK_PENDING_DAYS);

    if (freshPendingGaps.length > 0) {
      console.log('');
      console.log(`  Pending scoring (scoreExtractionPending=true, age ≤ ${STUCK_PENDING_DAYS}d) — first 5:`);
      for (const g of freshPendingGaps.slice(0, 5)) {
        console.log(`    ${g.showDir}/${g.file} | ${g.outlet} / ${g.critic} | tier=${g.tier} age=${g.ageDays}d`);
      }
      if (freshPendingGaps.length > 5) console.log(`    ... and ${freshPendingGaps.length - 5} more`);
      console.log('');
      warn(
        `${freshPendingGaps.length} review-text file(s) marked scoreExtractionPending ` +
        `but not yet scored — pipeline should pick them up on next run`
      );
    }

    if (stuckPendingGaps.length > 0) {
      console.log('');
      console.log(`  STUCK pending scoring (scoreExtractionPending=true, age > ${STUCK_PENDING_DAYS}d) — first 5:`);
      for (const g of stuckPendingGaps.slice(0, 5)) {
        console.log(`    ${g.showDir}/${g.file} | ${g.outlet} / ${g.critic} | tier=${g.tier} age=${g.ageDays}d`);
      }
      if (stuckPendingGaps.length > 5) console.log(`    ... and ${stuckPendingGaps.length - 5} more`);
      console.log('');
      warn(
        `${stuckPendingGaps.length} review-text file(s) have been scoreExtractionPending ` +
        `for more than ${STUCK_PENDING_DAYS} days — the pipeline has NOT picked them up. ` +
        `Fix: run \`node scripts/retry-pending-scores.js --show=<show-id>\` or flag them ` +
        `with rejectionReason/wrongProduction if they should be excluded. ` +
        `Leaving stuck pending files accumulates silent scoring gaps.`
      );
    }
  }

  if (orphanedGaps.length > 0) {
    // Orphaned gaps are reported as a SINGLE warn() (not error) so CI doesn't
    // break on the existing backlog. The backlog is real but known — the point
    // of this validator is to stop it from GROWING silently. The full per-show
    // breakdown is printed inline (not via warn) so the final summary stays
    // readable, but CI logs still show the blast radius.
    //
    // To escalate: change the single warn() below to error() once the backlog
    // has been triaged. Or gate on an env flag like STRICT_UNSCORED_GUARD=1.
    const byShow = {};
    for (const g of orphanedGaps) {
      (byShow[g.showDir] = byShow[g.showDir] || []).push(g);
    }
    const shownShows = Object.keys(byShow).sort().slice(0, 15);
    console.log('');
    console.log('  Orphaned silent gaps by show (first 15):');
    for (const showDir of shownShows) {
      const list = byShow[showDir];
      console.log(`    ${showDir} (${list.length}):`);
      for (const g of list.slice(0, 3)) {
        console.log(`      ${g.file} | ${g.outlet} / ${g.critic} | tier=${g.tier} words=${g.words || '?'} age=${g.ageDays != null ? g.ageDays + 'd' : '?'}`);
      }
      if (list.length > 3) console.log(`      ... and ${list.length - 3} more in this show`);
    }
    const remaining = Object.keys(byShow).length - shownShows.length;
    if (remaining > 0) console.log(`    ... and ${remaining} more shows with orphaned gaps`);
    console.log('');
    warn(
      `${orphanedGaps.length} review-text file(s) would be included by rebuild but have no score ` +
      `(spanning ${Object.keys(byShow).length} shows, median age will grow over time). ` +
      `These reviews are silently missing from their show's composite score. ` +
      `Fix: run the ensemble scorer on each file, or flag rejections (rejectionReason, wrongProduction, etc.). ` +
      `Do NOT leave them in limbo — they accumulate.`
    );
  }
}

function validateReviewTextQuality(shows) {
  info('Checking review text quality (garbage detection)...');
  const reviewTextsDir = path.join(DATA_DIR, 'review-texts');

  if (!fs.existsSync(reviewTextsDir)) {
    info('No review-texts directory found, skipping');
    return;
  }

  // Build set of known outlet names from registry (skip garbage checks for these)
  const knownOutletNames = new Set();
  const registryFile = path.join(DATA_DIR, 'outlet-registry.json');
  if (fs.existsSync(registryFile)) {
    const reg = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    for (const [id, info] of Object.entries(reg.outlets)) {
      knownOutletNames.add(id.toLowerCase());
      if (info.name) knownOutletNames.add(info.name.toLowerCase());
      if (info.displayName) knownOutletNames.add(info.displayName.toLowerCase());
      if (info.aliases) info.aliases.forEach(a => knownOutletNames.add(a.toLowerCase()));
    }
  }

  // Build per-show maps of creative team and cast names.
  // Skip placeholder values ("Unknown", "TBA", etc.) — they collide with generic "Unknown"
  // critic bylines and would flag legitimate reviews as garbage.
  const PLACEHOLDER_NAMES = new Set(['unknown', 'tba', 'tbd', 'tbc', 'n/a', 'na', 'anonymous']);
  const showCreativeTeam = {};  // showId -> Set of lowercase names
  const showCast = {};          // showId -> Set of lowercase names

  // Show lookup + date helpers for the prior-production-by-date backstop (CHECK 0).
  const showById = {};
  for (const show of shows) if (show && show.id) showById[show.id] = show;
  const { earliestShowDate } = require('./lib/date-guard');
  const { isWithinPriorRun } = require('./lib/wrong-production-autoclear');
  const { parseDate: parseReviewDate } = require('./lib/date-utils');
  for (const show of shows) {
    showCreativeTeam[show.id] = new Set();
    showCast[show.id] = new Set();
    if (show.creativeTeam) {
      for (const member of show.creativeTeam) {
        if (member.name) {
          const name = member.name.toLowerCase().trim();
          if (!PLACEHOLDER_NAMES.has(name)) showCreativeTeam[show.id].add(name);
        }
      }
    }
    if (show.cast) {
      for (const member of show.cast) {
        const name = typeof member === 'string' ? member : member.name;
        if (name) {
          const n = name.toLowerCase().trim();
          if (!PLACEHOLDER_NAMES.has(n)) showCast[show.id].add(n);
        }
      }
    }
  }

  let issues = 0;
  let filesChecked = 0;
  let htmlEntityFiles = 0;
  let garbageOutlets = 0;
  let headlineCritics = 0;
  let jsonLdPullQuotes = 0;
  let creativeAsCritic = 0;

  const showDirs = fs.readdirSync(reviewTextsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name);

  for (const showDir of showDirs) {
    const dirPath = path.join(reviewTextsDir, showDir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      filesChecked++;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
      } catch (e) {
        continue; // JSON parse errors caught elsewhere
      }

      // Skip already-flagged reviews
      if (data.wrongShow || data.wrongProduction || data.wrongUrl || data.duplicateOf || data.isRoundupArticle || data.isNotReview) continue;

      // CHECK 0: prior/other-production contamination by date. A review whose
      // publishDate predates the show's earliest date by >180 days, is not within
      // a declared priorRuns window, and has no genuine operator humanReviewScore,
      // is almost always a review of a DIFFERENT production of the same title that
      // leaked onto this entry. This is the backstop for the 2026-06-21
      // audit-aggregator-gap / operator-trust contamination (Notion 386637c5):
      // operator-trust override fields (allowEarlyDate/allowCrossMarket) used to
      // hide these from every guard, so this check deliberately ignores them.
      // Escape hatch: declare a priorRun, or it's a genuine operator entry.
      const wfShow = showById[showDir];
      if (wfShow && data.publishDate && !data.humanReviewScore) {
        const pub = parseReviewDate(data.publishDate);
        const earliestStr = earliestShowDate(wfShow);
        const earliestD = earliestStr ? parseReviewDate(earliestStr) : null;
        if (pub && earliestD && !isNaN(pub.getTime()) && !isNaN(earliestD.getTime())) {
          const daysBefore = (earliestD.getTime() - pub.getTime()) / 86400000;
          if (daysBefore > 180 && !isWithinPriorRun(pub, wfShow.priorRuns)) {
            error(`[wrong-production-by-date] ${showDir}/${file}: review dated ${data.publishDate} is ${Math.round(daysBefore)}d before the show's earliest date ${earliestStr} and not within any declared priorRun — likely a different production leaked onto this entry (set wrongProduction:true, or declare a priorRun)`);
            issues++;
            continue;
          }
        }
      }

      const critic = (data.criticName || '').trim();
      const outlet = (data.outlet || '').trim();

      // CHECK 1: Critic name matches a creative team member or cast member OF THE SAME SHOW
      // (Global matching causes false positives — e.g., critic "Scott Brown" ≠ actor "Scott Brown")
      const showCreative = showCreativeTeam[showDir] || new Set();
      const showCastSet = showCast[showDir] || new Set();
      if (critic && showCreative.has(critic.toLowerCase())) {
        error(`[garbage-review] ${showDir}/${file}: critic "${critic}" is a creative team member of this show — likely not a real review`);
        creativeAsCritic++;
        issues++;
      } else if (critic && showCastSet.has(critic.toLowerCase())) {
        warn(`[garbage-review] ${showDir}/${file}: critic "${critic}" is a cast member of this show — likely not a real review`);
        creativeAsCritic++;
        issues++;
      }

      // CHECK 2: Outlet name is a sentence fragment (too long, contains verbs/articles)
      // Skip for known outlets in the registry (e.g., "A Younger Theatre" starts with "A " but is legitimate)
      const isKnownOutlet = knownOutletNames.has(outlet.toLowerCase());
      if (!isKnownOutlet && outlet.length > 60) {
        error(`[garbage-outlet] ${showDir}/${file}: outlet "${outlet.substring(0, 60)}..." is too long (${outlet.length} chars) — likely a headline or sentence fragment`);
        garbageOutlets++;
        issues++;
      } else if (!isKnownOutlet && /^(is |has |the show (is|was|has|features|stars|boasts) |a |an |in her |in his |but |with )/i.test(outlet)) {
        error(`[garbage-outlet] ${showDir}/${file}: outlet "${outlet}" starts with a sentence fragment`);
        garbageOutlets++;
        issues++;
      }

      // CHECK 3: Critic name is too long (likely a headline)
      if (critic.length > 60) {
        error(`[headline-critic] ${showDir}/${file}: critic name "${critic.substring(0, 60)}..." is too long (${critic.length} chars) — likely a headline`);
        headlineCritics++;
        issues++;
      } else if (looksLikeUrlCriticName(critic)) {
        // CHECK 3b: Critic name is URL-shaped (scraper grabbed the byline LINK
        // href, not the text — e.g. "https://observer.com/author/rex-reed").
        // Length-independent: the old >60 check missed the many sub-60 URL
        // bylines. The save-time mirror lives in review-file-writer.js via
        // sanitizeCriticName; both share looksLikeUrlCriticName (CLAUDE.md §15).
        error(`[url-critic] ${showDir}/${file}: critic name "${critic.substring(0, 60)}" is URL-shaped — scraper captured the byline link, not the name (run scripts/gc-url-critic-names.js --fix)`);
        headlineCritics++;
        issues++;
      }

      // CHECK 4: pullQuote or excerpt contains JSON-LD / structured data.
      // Shares hasJsonLdArtifact with the save-time guard in review-file-writer.js
      // (CLAUDE.md §15) — the writer nulls such fields so they never persist.
      const textFields = [data.pullQuote, data.excerpt].filter(Boolean);
      for (const text of textFields) {
        if (hasJsonLdArtifact(text)) {
          error(`[jsonld-artifact] ${showDir}/${file}: pullQuote/excerpt contains JSON-LD structured data (run scripts/gc-display-field-artifacts.js --fix)`);
          jsonLdPullQuotes++;
          issues++;
          break;
        }
      }

      // CHECK 5: HTML entities in display fields (pullQuote, excerpt, criticName, outlet).
      // Shares hasUndecodedHtmlEntities with the save-time guard, which decodes
      // these fields at write so they never persist (CLAUDE.md §15).
      const displayFields = { pullQuote: data.pullQuote, excerpt: data.excerpt, criticName: data.criticName, outlet: data.outlet };
      for (const [fieldName, value] of Object.entries(displayFields)) {
        if (hasUndecodedHtmlEntities(value)) {
          warn(`[html-entity] ${showDir}/${file}: ${fieldName} contains undecoded HTML entities (run scripts/gc-display-field-artifacts.js --fix)`);
          htmlEntityFiles++;
          issues++;
          break; // Only report once per file
        }
      }
    }
  }

  if (issues === 0) {
    ok(`Review text quality: ${filesChecked} files checked, no issues`);
  } else {
    info(`Review text quality: ${creativeAsCritic} creative-as-critic, ${garbageOutlets} garbage outlets, ${headlineCritics} headline critics, ${jsonLdPullQuotes} JSON-LD artifacts, ${htmlEntityFiles} HTML entity files`);
  }
}

// ===========================================
// CONSENSUS QUALITY CHECKS
// Catches LLM reasoning leaks in critic consensus
// ===========================================

function validateConsensusQuality() {
  info('Checking critic consensus quality...');
  const consensusFile = path.join(DATA_DIR, 'critic-consensus.json');

  if (!fs.existsSync(consensusFile)) {
    info('critic-consensus.json not found, skipping');
    return;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(consensusFile, 'utf8'));
  } catch (e) {
    error(`critic-consensus.json parse error: ${e.message}`);
    return;
  }

  const shows = data.shows || data;
  let issues = 0;

  // LLM reasoning patterns that should never appear in consensus text
  const LLM_LEAK_PATTERNS = [
    /\bWAIT\b.*I need to/i,
    /\bLet me (?:think|reconsider|analyze|re-read|check)\b/i,
    /\bActually,?\s+(?:looking|reading|upon reflection)\b/i,
    /\bI (?:need to|should|must) (?:clarify|reconsider|think)\b/i,
    /\bHmm,?\s/,
    /\bOn second thought\b/i,
    /\bI'll (?:start|begin) (?:by|with)\b/i,
    /^(?:OK|Okay)[,.]?\s/i,
    /\bStep \d+:/i,
    /\bFirst,?\s+(?:I'll|let me|I need)\b/i,
    /\bHere'?s? (?:my|the) (?:analysis|assessment|evaluation)\b/i,
    /\bAs an AI\b/i,
    /\bI (?:don't|cannot|can't) (?:have|provide|access)\b/i,
  ];

  for (const [showId, entry] of Object.entries(shows)) {
    const text = typeof entry === 'string' ? entry : entry?.text || entry?.consensus || '';
    if (!text) continue;

    for (const pattern of LLM_LEAK_PATTERNS) {
      if (pattern.test(text)) {
        error(`[llm-leak] Consensus for "${showId}" contains LLM reasoning: "${text.substring(0, 80)}..."`);
        issues++;
        break;
      }
    }

    // Check for very short consensus (likely incomplete)
    if (text.length < 20) {
      warn(`[consensus-quality] "${showId}" consensus is very short (${text.length} chars)`);
      issues++;
    }
  }

  if (issues === 0) {
    ok(`Critic consensus: ${Object.keys(shows).length} entries, no LLM leaks detected`);
  }
}

// ===========================================
// RUNTIME FORMAT VALIDATION
// Catches raw minutes instead of "Xh Ym" format
// ===========================================

function validateRuntimeFormats(shows) {
  info('Checking runtime formats...');
  let issues = 0;

  for (const show of shows) {
    if (!show.runtime) continue;

    const runtime = String(show.runtime);

    // Valid formats: "2h 15m", "1h 30m", "90m", "2h", etc.
    if (/^\d+$/.test(runtime)) {
      error(`[runtime-format] "${show.title}" (${show.id}) has raw numeric runtime "${runtime}" — should be formatted like "2h 15m"`);
      issues++;
    } else if (!/^\d+h(\s+\d+m)?$|^\d+m$/.test(runtime)) {
      warn(`[runtime-format] "${show.title}" (${show.id}) has unusual runtime format: "${runtime}"`);
      issues++;
    }
  }

  if (issues === 0) {
    ok('All runtime values are properly formatted');
  }
}

// ===========================================
// CREATIVE TEAM DUPLICATE NAME DETECTION
// Catches same person listed multiple times with different roles
// (should be merged into one entry with combined role)
// ===========================================

function validateCreativeTeamDuplicateNames(shows) {
  info('Checking for duplicate creative team names (same person, different roles)...');
  let issues = 0;

  for (const show of shows) {
    if (!show.creativeTeam || !Array.isArray(show.creativeTeam)) continue;

    const nameCount = {};
    for (const member of show.creativeTeam) {
      if (!member.name) continue;
      const key = member.name.toLowerCase().trim();
      if (!nameCount[key]) nameCount[key] = [];
      nameCount[key].push(member.role || 'Unknown');
    }

    for (const [name, roles] of Object.entries(nameCount)) {
      if (roles.length > 1) {
        // Check if someone is listed as both writer and director AND another person
        // is also listed as director — this indicates an LLM hallucination
        const hasDirector = roles.some(r => /^director$/i.test(r));
        const hasWriter = roles.some(r => /playwright|book|writer|author/i.test(r));
        if (hasDirector && hasWriter) {
          // Check if there's ANOTHER director in the creative team
          const otherDirectors = show.creativeTeam.filter(m =>
            m.name.toLowerCase().trim() !== name &&
            /^director$/i.test(m.role)
          );
          if (otherDirectors.length > 0) {
            // Downgrade to warning: legitimate co-writer/co-director combos exist (SIX, 1984, Baby It's You)
            warn(`[creative-dup-name] "${show.title}" (${show.id}): "${name}" listed as both writer AND co-director with "${otherDirectors[0].name}" — verify this is intentional`);
          }
        }
        warn(`[creative-dup-name] "${show.title}" (${show.id}): "${name}" appears ${roles.length} times with roles: ${roles.join(', ')} — consider merging`);
        issues++;
      }
    }
  }

  if (issues === 0) {
    ok('No duplicate creative team names found');
  }
}

// ===========================================
// MAIN
// ===========================================

// ===========================================
// Cross-file key validation
// Prevents orphan entries and key type mismatches
// ===========================================

function validateCrossFileKeys(shows) {
  info('Checking cross-file key consistency...');

  const slugSet = new Set(shows.map(s => s.slug));
  const idSet = new Set(shows.map(s => s.id));
  // Map from ID to slug for mismatch detection
  const idToSlug = new Map(shows.map(s => [s.id, s.slug]));
  let issues = 0;

  // 1. Commercial keys must be show SLUGS (data-commercial.ts looks up by slug)
  const commercialFile = path.join(__dirname, '..', 'data', 'commercial.json');
  if (fs.existsSync(commercialFile)) {
    try {
      const commercial = JSON.parse(fs.readFileSync(commercialFile, 'utf8'));
      const commercialKeys = Object.keys(commercial.shows || {});

      for (const key of commercialKeys) {
        if (!slugSet.has(key)) {
          // Check if it's a show ID instead of a slug
          if (idSet.has(key)) {
            const correctSlug = idToSlug.get(key);
            warn(`commercial.json key "${key}" is a show ID, not a slug. Should be "${correctSlug}". Entry is invisible on /biz page.`);
            issues++;
          } else {
            warn(`commercial.json key "${key}" not found in shows.json (orphan entry)`);
            issues++;
          }
        }
      }
    } catch (e) {
      // Already validated in validateCommercialJson
    }
  }

  // 2. Awards keys must be show IDs
  const awardsFile = path.join(__dirname, '..', 'data', 'awards.json');
  if (fs.existsSync(awardsFile)) {
    try {
      const awards = JSON.parse(fs.readFileSync(awardsFile, 'utf8'));
      const awardsKeys = Object.keys(awards.shows || {});

      for (const key of awardsKeys) {
        if (!idSet.has(key)) {
          if (slugSet.has(key)) {
            warn(`awards.json key "${key}" appears to be a slug, not a show ID`);
          } else {
            warn(`awards.json key "${key}" not found in shows.json (orphan entry)`);
          }
          issues++;
        }
      }

      // 2a. tony.season must be plausible given the show's openingDate.
      // Catches the "fossilized misattribution" bug class where a show ID
      // got data from a different production via title-only matching. See
      // scripts/audit-tony-attribution.js for the full audit.
      const showsById = new Map();
      for (const sh of shows) showsById.set(sh.id, sh);
      const parseSeasonStart = (s) => {
        const m = /^(\d{4})-(\d{2})$/.exec(s || '');
        return m ? parseInt(m[1], 10) : null;
      };
      const expectedSeasonStarts = (openingDate) => {
        if (!openingDate) return [];
        const d = new Date(openingDate);
        const y = d.getFullYear();
        if (Number.isNaN(y)) return [];
        const mo = d.getMonth() + 1;
        // Tony eligibility window straddles late April; accept both bracketing seasons.
        return mo <= 5 ? [y - 1, y] : [y, y - 1];
      };
      // Only Broadway productions are Tony-eligible. West End and Off-Broadway
      // shows must not have tony blocks. Gate on category (the canonical
      // eligibility field), not market — OB shows have market='broadway'.
      let nonBroadwayTonyCount = 0, mismatchCount = 0, malformedDateCount = 0;
      for (const [showId, awardsEntry] of Object.entries(awards.shows || {})) {
        if (!awardsEntry.tony || !awardsEntry.tony.season) continue;
        const show = showsById.get(showId);
        if (!show) continue;
        if (show.category && show.category !== 'broadway') {
          error(`awards.json: ${show.category} show "${showId}" has tony block (Tonys are Broadway-only). Delete it.`);
          nonBroadwayTonyCount++;
          issues++;
          continue;
        }
        if (!show.openingDate) continue;
        const tonyStart = parseSeasonStart(awardsEntry.tony.season);
        if (!tonyStart) continue;
        const expected = expectedSeasonStarts(show.openingDate);
        if (expected.length === 0) {
          // Malformed openingDate — surface it instead of silently passing.
          error(`awards.json: "${showId}" openingDate="${show.openingDate}" is unparseable; cannot verify tony.season=${awardsEntry.tony.season}.`);
          malformedDateCount++;
          issues++;
          continue;
        }
        const gap = Math.min(...expected.map(e => Math.abs(e - tonyStart)));
        if (gap > 1) {
          error(`awards.json: "${showId}" tony.season=${awardsEntry.tony.season} but openingDate=${show.openingDate} (expected ${expected[0]}-${(expected[0]+1).toString().slice(-2)}). Gap ${gap}y — misattribution.`);
          mismatchCount++;
          issues++;
        }
      }
      if (nonBroadwayTonyCount === 0 && mismatchCount === 0 && malformedDateCount === 0) {
        ok(`awards.json: Tony attribution clean (${Object.keys(awards.shows || {}).length} shows checked)`);
      }

      // 2b. Tony season+category must have at most 1 winner (real ties are rare
      // and must be explicitly annotated in data/awards-confirmed-ties.json).
      const TIES_FILE = path.join(__dirname, '..', 'data', 'awards-confirmed-ties.json');
      let confirmedTies = new Set();
      if (fs.existsSync(TIES_FILE)) {
        try {
          const tiesData = JSON.parse(fs.readFileSync(TIES_FILE, 'utf8'));
          for (const t of tiesData.ties || []) confirmedTies.add(`${t.season}|${t.category}`);
        } catch {}
      }
      const winnerMap = {};
      for (const [showId, awardsEntry] of Object.entries(awards.shows || {})) {
        if (!awardsEntry.tony || !awardsEntry.tony.season) continue;
        for (const cat of awardsEntry.tony.wins || []) {
          const k = `${awardsEntry.tony.season}|${cat}`;
          (winnerMap[k] = winnerMap[k] || []).push(showId);
        }
      }
      let dupTieCount = 0;
      for (const [k, ids] of Object.entries(winnerMap)) {
        if (ids.length > 1 && !confirmedTies.has(k)) {
          error(`awards.json: Tony ${k} has ${ids.length} winners (${ids.join(', ')}). If a real tie, add to data/awards-confirmed-ties.json; otherwise fix the misattribution.`);
          dupTieCount++;
          issues++;
        }
      }
      if (dupTieCount === 0) {
        ok(`awards.json: Tony winner uniqueness clean (${confirmedTies.size} confirmed ties registered)`);
      }
    } catch (e) {
      // Parse errors handled elsewhere
    }
  }

  // 3. Audience buzz keys must be show IDs
  const audienceFile = path.join(__dirname, '..', 'data', 'audience-buzz.json');
  if (fs.existsSync(audienceFile)) {
    try {
      const audience = JSON.parse(fs.readFileSync(audienceFile, 'utf8'));
      const audienceKeys = Object.keys(audience.shows || {});

      for (const key of audienceKeys) {
        if (!idSet.has(key)) {
          if (slugSet.has(key)) {
            warn(`audience-buzz.json key "${key}" appears to be a slug, not a show ID`);
          } else {
            warn(`audience-buzz.json key "${key}" not found in shows.json (orphan entry)`);
          }
          issues++;
        }
      }
    } catch (e) {
      // Parse errors handled elsewhere
    }
  }

  // 4. Grosses keys must be show slugs
  const grossesKeyFile = path.join(__dirname, '..', 'data', 'grosses.json');
  if (fs.existsSync(grossesKeyFile)) {
    try {
      const grosses = JSON.parse(fs.readFileSync(grossesKeyFile, 'utf8'));
      const grossesKeys = Object.keys(grosses.shows || {});

      for (const key of grossesKeys) {
        if (!slugSet.has(key)) {
          if (idSet.has(key)) {
            error(`grosses.json key "${key}" is a show ID, not a slug. Should be "${idToSlug.get(key)}"`);
          } else {
            error(`grosses.json key "${key}" not found in shows.json (orphan entry — remove it)`);
          }
          issues++;
        }
      }
    } catch (e) {
      // Parse errors handled in validateGrossesJson
    }
  }

  // 5. Grosses-history keys must be show slugs
  const grossesHistFile = path.join(__dirname, '..', 'data', 'grosses-history.json');
  if (fs.existsSync(grossesHistFile)) {
    try {
      const history = JSON.parse(fs.readFileSync(grossesHistFile, 'utf8'));
      const historyKeys = Object.keys(history).filter(k => !k.startsWith('_') && k !== 'weeks');

      for (const key of historyKeys) {
        if (!slugSet.has(key)) {
          if (idSet.has(key)) {
            warn(`grosses-history.json key "${key}" is a show ID, not a slug`);
          } else {
            warn(`grosses-history.json key "${key}" not found in shows.json (orphan entry)`);
          }
          issues++;
        }
      }
    } catch (e) {
      // Parse errors handled elsewhere
    }
  }

  if (issues === 0) {
    ok('All cross-file keys are consistent (commercial=slug, awards=ID, audience=ID, grosses=slug)');
  } else {
    warn(`${issues} cross-file key issue(s) found — run audit scripts for details`);
  }
}

// ===========================================
// CAST DATA VALIDATION
// ===========================================

function validateCastFiles(shows) {
  info('Checking cast data files...');

  const castDir = path.join(DATA_DIR, 'cast');
  if (!fs.existsSync(castDir)) {
    info('No data/cast/ directory — skipping cast validation');
    return;
  }

  const castFiles = fs.readdirSync(castDir).filter(f => f.endsWith('.json'));
  if (castFiles.length === 0) {
    info('No cast files found');
    return;
  }

  const showIdSet = new Set(shows.map(s => s.id));
  let issues = 0;
  let totalMembers = 0;
  let emptyFiles = 0;

  for (const file of castFiles) {
    const filePath = path.join(castDir, file);
    const expectedId = file.replace('.json', '');

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // showId must match filename
      if (data.showId !== expectedId) {
        warn(`cast/${file}: showId "${data.showId}" doesn't match filename "${expectedId}"`);
        issues++;
      }

      // showId must exist in shows.json
      if (!showIdSet.has(data.showId)) {
        warn(`cast/${file}: showId "${data.showId}" not found in shows.json (orphan)`);
        issues++;
      }

      // openingNightCast must be an array
      if (!Array.isArray(data.openingNightCast)) {
        error(`cast/${file}: openingNightCast is not an array`);
        issues++;
        continue;
      }

      if (data.openingNightCast.length === 0) {
        emptyFiles++;
      }

      // Validate each cast member
      for (let i = 0; i < data.openingNightCast.length; i++) {
        const member = data.openingNightCast[i];
        if (!member.name || typeof member.name !== 'string' || member.name.trim() === '') {
          warn(`cast/${file}: OBC member [${i}] has empty/missing name`);
          issues++;
        }
        if (!member.role || typeof member.role !== 'string') {
          warn(`cast/${file}: OBC member [${i}] (${member.name || 'unnamed'}) has missing role`);
          issues++;
        }
      }

      totalMembers += data.openingNightCast.length;

      // Warn on unusually large casts
      if (data.openingNightCast.length > 60) {
        warn(`cast/${file}: ${data.openingNightCast.length} OBC members — unusually large, possible parsing error`);
      }

    } catch (e) {
      error(`cast/${file}: invalid JSON — ${e.message}`);
      issues++;
    }
  }

  if (issues === 0) {
    ok(`Cast data: ${castFiles.length} files, ${totalMembers} total cast members` +
      (emptyFiles > 0 ? ` (${emptyFiles} empty/tombstone)` : ''));
  } else {
    warn(`Cast data: ${issues} issue(s) across ${castFiles.length} files`);
  }
}

// ===========================================
// TONY NOMINATIONS VALIDATION
// ===========================================

function validateTonyData(shows) {
  info('Checking Tony nominations data...');

  const TONY_FILE = path.join(DATA_DIR, 'tony-nominations.json');
  const AWARDS_FILE = path.join(DATA_DIR, 'awards.json');

  // 1. tony-nominations.json exists and parses
  if (!fs.existsSync(TONY_FILE)) {
    warn('tony-nominations.json not found — skipping Tony validation');
    return;
  }
  if (!fs.existsSync(AWARDS_FILE)) {
    warn('awards.json not found — skipping Tony validation');
    return;
  }

  let tonyData, awardsData;
  try {
    tonyData = JSON.parse(fs.readFileSync(TONY_FILE, 'utf8'));
  } catch (e) {
    error(`tony-nominations.json: invalid JSON — ${e.message}`);
    return;
  }
  try {
    awardsData = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
  } catch (e) {
    error(`awards.json: invalid JSON — ${e.message}`);
    return;
  }

  const noms = tonyData.nominations || [];
  ok(`tony-nominations.json: ${noms.length} nominations parsed`);

  // 2. Coverage threshold
  const expectedShows = Object.keys(awardsData.shows).filter(id => {
    const show = awardsData.shows[id];
    return show.tony && show.tony.nominations > 0;
  });
  const actualShows = new Set(noms.filter(n => n.name !== '(show-level)').map(n => n.showId));
  const coverageRatio = actualShows.size / expectedShows.length;

  if (coverageRatio < 0.90) {
    error(`Tony coverage: ${actualShows.size}/${expectedShows.length} shows (${(coverageRatio * 100).toFixed(1)}%) — below 90% threshold`);
  } else {
    ok(`Tony coverage: ${actualShows.size}/${expectedShows.length} shows (${(coverageRatio * 100).toFixed(1)}%)`);
  }

  // 3. Zero-data gap check for shows with expected >= 3 noms
  const nomsByShow = new Map();
  for (const n of noms) {
    if (n.name === '(show-level)') continue;
    nomsByShow.set(n.showId, (nomsByShow.get(n.showId) || 0) + 1);
  }

  const bigGaps = [];
  for (const id of expectedShows) {
    const expected = awardsData.shows[id].tony.nominations;
    const actual = nomsByShow.get(id) || 0;
    if (expected >= 3 && actual === 0) {
      bigGaps.push({ id, expected });
    }
  }

  if (bigGaps.length > 10) {
    error(`Tony: ${bigGaps.length} shows with expected >= 3 noms but 0 person-level data: ${bigGaps.slice(0, 5).map(g => g.id).join(', ')}...`);
  } else if (bigGaps.length > 0) {
    warn(`Tony: ${bigGaps.length} shows with expected >= 3 noms but 0 person-level data: ${bigGaps.map(g => g.id).join(', ')}`);
  } else {
    ok('Tony: no large gaps (all shows with 3+ expected noms have person-level data)');
  }

  // 4. Duplicate detection
  const seen = new Set();
  let dupeCount = 0;
  for (const n of noms) {
    const key = `${n.showId}|${n.category}|${n.ibdbPersonId}`;
    if (seen.has(key)) dupeCount++;
    seen.add(key);
  }

  if (dupeCount > 0) {
    error(`Tony: ${dupeCount} duplicate entries (same showId|category|ibdbPersonId)`);
  } else {
    ok('Tony: no duplicate entries');
  }

  // 5. Category whitelist
  const KNOWN_CATEGORIES = new Set([
    'Best Musical', 'Best Play', 'Best Revival of a Musical', 'Best Revival of a Play',
    'Best Book of a Musical', 'Best Original Score',
    'Best Actor in a Musical', 'Best Actress in a Musical',
    'Best Actor in a Play', 'Best Actress in a Play',
    'Best Featured Actor in a Musical', 'Best Featured Actress in a Musical',
    'Best Featured Actor in a Play', 'Best Featured Actress in a Play',
    'Best Direction of a Musical', 'Best Direction of a Play',
    'Best Choreography', 'Best Orchestrations',
    'Best Scenic Design of a Musical', 'Best Scenic Design of a Play', 'Best Scenic Design',
    'Best Costume Design of a Musical', 'Best Costume Design of a Play', 'Best Costume Design',
    'Best Lighting Design of a Musical', 'Best Lighting Design of a Play', 'Best Lighting Design',
    'Best Sound Design of a Musical', 'Best Sound Design of a Play', 'Best Sound Design',
  ]);

  const unknownCats = new Set();
  for (const n of noms) {
    if (!KNOWN_CATEGORIES.has(n.category)) unknownCats.add(n.category);
  }
  if (unknownCats.size > 0) {
    warn(`Tony: ${unknownCats.size} unknown categories: ${[...unknownCats].join(', ')}`);
  } else {
    ok('Tony: all categories match whitelist');
  }

  // 6. Regression detection against baseline
  if (baseline && baseline.tonyNominations) {
    const minNoms = Math.floor(baseline.tonyNominations * 0.90);
    if (noms.length < minNoms) {
      error(`Tony regression: ${noms.length} nominations (baseline: ${baseline.tonyNominations}, min allowed: ${minNoms} = -10%)`);
    } else {
      ok(`Tony regression check: ${noms.length} nominations (baseline: ${baseline.tonyNominations}, min: ${minNoms})`);
    }
  } else {
    info('No Tony baseline yet — will set on next successful validation');
  }

  // 7. Season-year sanity check
  const showsById = new Map(shows.map(s => [s.id, s]));
  let yearMismatches = 0;
  for (const n of noms) {
    if (!n.season || n.name === '(show-level)') continue;
    const show = showsById.get(n.showId);
    if (!show || !show.openingDate) continue;
    const openingYear = parseInt(show.openingDate.substring(0, 4));
    const seasonYear = parseInt(n.season.substring(0, 4));
    if (Math.abs(seasonYear - openingYear) > 2) {
      yearMismatches++;
    }
  }
  if (yearMismatches > 0) {
    warn(`Tony: ${yearMismatches} nominations where season year differs from opening year by >2 years`);
  } else {
    ok('Tony: season-year sanity check passed');
  }

  // Write coverage gaps audit file
  try {
    const gapsFile = path.join(DATA_DIR, 'audit', 'tony-coverage-gaps.json');
    const allGaps = [];
    for (const id of expectedShows) {
      const expected = awardsData.shows[id].tony.nominations;
      const actual = nomsByShow.get(id) || 0;
      if (actual < expected) {
        allGaps.push({ showId: id, expected, actual, reason: actual === 0 ? 'no-data' : 'partial' });
      }
    }
    const auditDir = path.dirname(gapsFile);
    if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(gapsFile, JSON.stringify(allGaps, null, 2) + '\n');
    ok(`Tony coverage gaps audit: ${allGaps.length} gaps written to audit file`);
  } catch (e) {
    warn(`Failed to write Tony coverage gaps: ${e.message}`);
  }

  return { totalNominations: noms.length, totalWins: noms.filter(n => n.won).length };
}

// ===========================================
// AGGREGATOR ARCHIVES VALIDATION
// ===========================================

function validateAggregatorArchives(shows) {
  info('Checking aggregator archives...');

  // The full archive lives at data/review-texts/aggregator-archive/ (private repo checkout).
  // data/aggregator-archive/ is a small working/staging directory — not the real archive.
  const reviewTextsArchive = path.join(DATA_DIR, 'review-texts', 'aggregator-archive');
  const archiveDir = fs.existsSync(reviewTextsArchive) ? reviewTextsArchive : path.join(DATA_DIR, 'aggregator-archive');
  if (!fs.existsSync(archiveDir)) {
    // Not an error — many workflows don't check out aggregator-archive (it's in the private repo)
    info('data/aggregator-archive/ not present (skipping archive validation)');
    return;
  }
  if (archiveDir !== reviewTextsArchive) {
    // Only the staging dir is present — skip count validation (it's always small)
    info('Only data/aggregator-archive/ staging dir present (skipping count validation — full archive is in review-texts repo)');
    return;
  }

  const dirs = fs.readdirSync(archiveDir).filter(d =>
    fs.statSync(path.join(archiveDir, d)).isDirectory()
  );

  if (dirs.length === 0) {
    error('data/aggregator-archive/ has zero subdirectories');
    return;
  }

  let total = 0;
  let lowDirs = 0;
  for (const dir of dirs) {
    const files = fs.readdirSync(path.join(archiveDir, dir));
    const count = files.length;
    total += count;
    if (count < 5) {
      warn(`aggregator-archive/${dir}: only ${count} files (expected 5+)`);
      lowDirs++;
    }
  }

  if (total < 2500) {
    error(`Only ${total} total aggregator archive files (expected 2500+). Archives may have been accidentally deleted.`);
  } else {
    ok(`${total} aggregator archive files across ${dirs.length} directories`);
  }

  if (lowDirs > 2) {
    error(`${lowDirs} aggregator directories below minimum file count`);
  }

  // Check recent shows have at least some aggregator coverage
  if (shows) {
    const recentShows = shows.filter(s =>
      (s.status === 'open' || s.status === 'closed') &&
      s.openingDate && new Date(s.openingDate).getFullYear() >= 2023
    );
    let noArchive = 0;
    for (const show of recentShows) {
      const hasArchive = dirs.some(dir => {
        const files = fs.readdirSync(path.join(archiveDir, dir));
        return files.some(f => f.includes(show.id) || f.includes(show.slug));
      });
      if (!hasArchive) noArchive++;
    }
    if (noArchive > 0) {
      warn(`${noArchive} of ${recentShows.length} recent shows (2023+) have no aggregator archive files`);
    }
  }
}

// ===========================================
// ACTOR IMAGES VALIDATION
// ===========================================

function validateActorImages() {
  info('Checking actor-images.json...');

  const imagesFile = path.join(DATA_DIR, 'actor-images.json');
  if (!fs.existsSync(imagesFile)) {
    info('No actor-images.json found — skipping');
    return;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(imagesFile, 'utf8'));
    ok(`actor-images.json: ${Object.keys(data).length} entries`);
  } catch (e) {
    error(`actor-images.json parse error: ${e.message}`);
    return;
  }

  let issues = 0;
  const validSources = ['wikipedia', 'broadwayworld'];
  const svgUrls = [];

  for (const [id, entry] of Object.entries(data)) {
    if (!entry.imageUrl || typeof entry.imageUrl !== 'string') {
      error(`actor-images.json: entry "${id}" missing imageUrl`);
      issues++;
      continue;
    }

    if (!entry.source || !validSources.includes(entry.source)) {
      warn(`actor-images.json: entry "${id}" has invalid source "${entry.source}"`);
      issues++;
    }

    // Catch SVG logos (e.g., American Idol logo) — not valid headshots
    if (/\.svg/i.test(entry.imageUrl)) {
      svgUrls.push({ id, name: entry.name, url: entry.imageUrl });
      issues++;
    }

    // Catch non-HTTPS URLs
    if (!entry.imageUrl.startsWith('https://')) {
      warn(`actor-images.json: entry "${id}" has non-HTTPS URL: ${entry.imageUrl.substring(0, 80)}`);
      issues++;
    }
  }

  if (svgUrls.length > 0) {
    for (const s of svgUrls) {
      error(`actor-images.json: "${s.name}" (${s.id}) has SVG image (likely a logo, not a headshot): ${s.url.substring(0, 80)}`);
    }
  }

  if (issues === 0) {
    ok('All actor image entries are valid');
  }
}

function validateCrossMarketContamination() {
  info('Checking for cross-market contamination...');
  const reviewsFile = path.join(DATA_DIR, 'reviews.json');
  if (!fs.existsSync(reviewsFile)) return;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
  } catch { return; }

  const reviews = data.reviews || [];
  const showsFile = path.join(DATA_DIR, 'shows.json');
  let shows;
  try {
    const sd = JSON.parse(fs.readFileSync(showsFile, 'utf8'));
    shows = sd.shows || sd;
  } catch { return; }

  const showCategoryMap = {};
  for (const s of shows) {
    showCategoryMap[s.id] = s.category || 'broadway';
  }

  // Load outlet registry for region info. Region / dual-market / tier lookups are
  // built by the shared scripts/lib/outlet-region-map.js helper (single source of
  // truth with audit-review-contamination.js) — including the alias-lowercasing
  // nuance a ship-check had to fix once (ship-check 2026-06-15).
  const registryFile = path.join(DATA_DIR, 'outlet-registry.json');
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  } catch { /* no registry = skip check */ return; }
  const { outletRegionMap, dualMarket, tier12Outlets, outletTierMap, canonicalOutletId } = buildOutletMaps(reg);

  // Forward direction: US outlets on West End / off-West End shows.
  // Classification lives in scripts/lib/cross-market-guard.js (pure, tested):
  //   error   — explicitly US-region outlet AND pre-window publish date (>60d
  //             before the show's earliest date, outside every declared priorRun).
  //             Both signals present = Broadway-run reviews leaking onto a WE
  //             revival (Glengarry WE 2026, card 386637c5). Blocks the build.
  //   warning — any other non-London outlet (unknown region, or in-window date —
  //             NYT/Variety-style legitimate WE coverage stays non-blocking, and
  //             Tier 1/2 + dual-market outlets are skipped entirely).
  const showByIdFull = new Map(shows.map(s => [s.id, s]));
  let issues = 0;
  let usOnWeErrors = 0;
  const weReviews = reviews.filter(r => isLondonMarket(showCategoryMap[r.showId]));
  for (const r of weReviews) {
    const oid = (r.outletId || r.outlet || '').toLowerCase();
    const region = outletRegionMap[oid];
    // Pre-window signal: same predicate the rebuild inclusion pass uses
    // (scripts/lib/date-guard.js), including the priorRuns exemption.
    let isPreWindowDate = false;
    const show = showByIdFull.get(r.showId);
    const earliest = show ? earliestShowDate(show) : null;
    if (earliest && r.publishDate) {
      const pw = evaluatePreWindowInclusion({
        pubDate: new Date(r.publishDate),
        showEarliest: new Date(earliest),
        isFlexCategory: true,
        priorRuns: show.priorRuns,
      });
      isPreWindowDate = pw.exclude;
    }
    const { level, reason } = classifyUsOnWeCrossMarket({
      region,
      isDualMarket: dualMarket.has(oid),
      isTier12: tier12Outlets.has(oid),
      isPreWindowDate,
    });
    if (level === 'error') {
      usOnWeErrors++;
      if (usOnWeErrors <= 5) {
        error(`Cross-market: WE show "${r.showId}" has review from US outlet "${r.outlet || oid}" dated ${r.publishDate} (${reason})`);
      }
    } else if (level === 'warning') {
      issues++;
      if (issues <= 5) {
        warn(`Cross-market: WE show "${r.showId}" has review from non-London outlet "${r.outlet || oid}"`);
      }
    }
  }

  if (usOnWeErrors > 5) {
    error(`... and ${usOnWeErrors - 5} more US-on-WE pre-window cross-market reviews`);
  }
  if (issues > 5) {
    warn(`... and ${issues - 5} more US→WE cross-market reviews`);
  }

  // Reverse direction: London outlets on Broadway/off-Broadway shows.
  // Classification lives in scripts/lib/cross-market-guard.js (pure, tested):
  //   error    — Tier 1/2 London prestige paper on a Broadway show (genuine
  //              contamination; they never legitimately cover Broadway).
  //   advisory — Tier 3/untiered London outlet on a Broadway show. The plays-to-see /
  //              The Arts Desk class: niche London aggregators that legitimately cover
  //              Broadway transfers and slowly accumulate NYC reviews. Surfaced as an
  //              isDualMarket candidate but NOT build-blocking. Before 2026-06-15 these
  //              hit the hard error and turned CI red, forcing a reactive isDualMarket
  //              fix after the build was already broken (memory/feedback_plays_to_see_dual_market.md).
  //   warning  — London outlet on off-Broadway/other NYC show (opera cinema
  //              transmissions, London-to-NYC transfers, festival co-productions).
  //   skip     — isDualMarket outlet, or non-London outlet.
  // isBroadwayCategory treats null category as Broadway (historical-import convention,
  // venue-classification.js:48) and routes any new NYC category correctly.
  let reverseIssues = 0;
  let reverseWarnings = 0;
  let reverseAdvisories = 0;
  // Per-outlet accumulation, written to an audit file so a London-only outlet
  // creeping toward dual-market is visible BEFORE it would block a build.
  // Keyed by CANONICAL outlet id (not the alias fragment the review happened to carry)
  // so one outlet appearing under two aliases doesn't split into two audit entries.
  const accumulation = new Map(); // canonId -> { outletId, displayName, tier, broadway:Set, offBroadway:Set }
  const recordAccum = (oid, r, category, bucket) => {
    const canon = canonicalOutletId[oid] || oid;
    let entry = accumulation.get(canon);
    if (!entry) {
      entry = { outletId: canon, displayName: r.outlet || canon, tier: outletTierMap[canon] ?? outletTierMap[oid] ?? null, broadway: new Set(), offBroadway: new Set() };
      accumulation.set(canon, entry);
    }
    entry[bucket].add(r.showId);
    if (r.outlet && entry.displayName === canon) entry.displayName = r.outlet;
  };
  const nonWeReviews = reviews.filter(r => !isLondonMarket(showCategoryMap[r.showId]));
  for (const r of nonWeReviews) {
    const oid = (r.outletId || r.outlet || '').toLowerCase();
    const region = outletRegionMap[oid];
    const category = showCategoryMap[r.showId];
    const isBroadway = isBroadwayCategory({ category });
    const { level, reason } = classifyReverseCrossMarket({
      region,
      isDualMarket: dualMarket.has(oid),
      isTier12: tier12Outlets.has(oid),
      isBroadway,
    });
    if (level === 'skip') continue;
    if (level === 'error') {
      recordAccum(oid, r, category, 'broadway');
      reverseIssues++;
      if (reverseIssues <= 5) {
        error(`Cross-market: Broadway show "${r.showId}" has review from London Tier 1/2 outlet "${r.outlet || oid}" (${reason})`);
      }
    } else if (level === 'advisory') {
      recordAccum(oid, r, category, 'broadway');
      reverseAdvisories++;
    } else { // warning
      recordAccum(oid, r, category, 'offBroadway');
      reverseWarnings++;
      if (reverseWarnings <= 5) {
        warn(`Cross-market: ${category || 'unknown'} show "${r.showId}" has review from London outlet "${r.outlet || oid}" (allowed — opera cinema transmissions, transfers)`);
      }
    }
  }
  if (reverseIssues > 5) {
    error(`... and ${reverseIssues - 5} more London Tier 1/2 → Broadway cross-market reviews`);
  }
  if (reverseWarnings > 5) {
    warn(`... and ${reverseWarnings - 5} more London→off-Broadway/other cross-market reviews`);
  }

  // Advisory: Tier 3/untiered London outlets accumulating Broadway reviews.
  // One grouped line per outlet with the exact remediation, NOT build-blocking.
  const advisoryOutlets = [...accumulation.values()].filter(e => e.broadway.size > 0 && !tier12Outlets.has(e.outletId));
  for (const e of advisoryOutlets) {
    warn(`Cross-market ADVISORY: London-only outlet "${e.displayName}" (tier ${e.tier ?? '?'}) has ${e.broadway.size} Broadway review(s): ${[...e.broadway].join(', ')}. If this is genuine dual-market coverage, set isDualMarket:true in outlet-registry.json (both repos); if misattribution, set wrongProduction:true on the review(s). Advisory only — not blocking CI.`);
  }

  // Persist accumulation so growth is trackable across runs (the plays-to-see class
  // is currently rare — only The Arts Desk — so this is the cheap moment to watch it).
  try {
    const accumFile = path.join(DATA_DIR, 'audit', 'london-only-nyc-accumulation.json');
    const auditDir = path.dirname(accumFile);
    if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
    const payload = {
      generatedBy: 'scripts/validate-data.js reverse cross-market guard',
      description: 'London-region, non-isDualMarket outlets carrying NYC reviews. Tier 3/untiered Broadway hits are advisory isDualMarket candidates; Tier 1/2 Broadway hits are CI errors; off-Broadway hits are tolerated warnings.',
      outlets: [...accumulation.values()]
        .map(e => ({
          outletId: e.outletId,
          displayName: e.displayName,
          tier: e.tier,
          broadwayCount: e.broadway.size,
          offBroadwayCount: e.offBroadway.size,
          broadwayShows: [...e.broadway].sort(),
          offBroadwayShows: [...e.offBroadway].sort(),
          disposition: tier12Outlets.has(e.outletId) && e.broadway.size > 0
            ? 'error'
            : e.broadway.size > 0
              ? 'advisory-isDualMarket-candidate'
              : 'tolerated-off-broadway',
        }))
        .sort((a, b) => (b.broadwayCount - a.broadwayCount) || (b.offBroadwayCount - a.offBroadwayCount) || a.outletId.localeCompare(b.outletId)),
    };
    fs.writeFileSync(accumFile, JSON.stringify(payload, null, 2) + '\n');
  } catch (e) {
    warn(`Failed to write London-only NYC accumulation audit: ${e.message}`);
  }

  const totalIssues = issues + reverseIssues;
  if (totalIssues === 0) {
    ok(`No cross-market contamination detected in reviews.json${reverseAdvisories ? ` (${reverseAdvisories} Tier 3 London→Broadway advisory review(s) across ${advisoryOutlets.length} outlet(s) — see warnings)` : ''}`);
  } else {
    warn(`${totalIssues} cross-market reviews found (${issues} US→WE, ${reverseIssues} London Tier 1/2 → Broadway) — check outlet isDualMarket flags`);
  }
}

// Warn about shows that look like non-theater content (game shows, concerts, readings, etc.)
function validateNonTheaterContent(shows) {
  console.log('--- Non-Theater Content Check ---');
  const NON_THEATER_VENUES = ['kogame', 'appel room', 'rose theater'];
  const SUSPICIOUS_KEYWORDS = ['game show', 'punishment game', 'jazz at lincoln center'];
  let flagged = 0;

  for (const show of shows) {
    const reasons = [];
    const venue = (show.venue || '').toLowerCase();
    if (NON_THEATER_VENUES.some(v => venue.includes(v))) {
      reasons.push(`suspicious venue "${show.venue}"`);
    }
    // One-night shows from 2025+ (TodayTix era)
    if (show.openingDate && show.closingDate && show.openingDate === show.closingDate) {
      const year = parseInt(show.openingDate.substring(0, 4));
      if (year >= 2025) reasons.push('one-night event');
    }
    const desc = (show.description || '').toLowerCase();
    if (SUSPICIOUS_KEYWORDS.some(kw => desc.includes(kw))) {
      reasons.push('non-theater synopsis keywords');
    }
    if (reasons.length > 0) {
      warn(`Possible non-theater content: "${show.title}" (${show.id}) — ${reasons.join(', ')}`);
      flagged++;
    }
  }
  if (flagged === 0) ok('No suspicious non-theater content detected');
  else console.log(`  ⚠️  ${flagged} show(s) flagged for review`);
}

// Lint guard: detect hardcoded outlet ID lists in scripts that should use outlet-registry.json
function validateNoHardcodedOutletLists() {
  console.log('--- Hardcoded Outlet List Check ---');
  const SCRIPTS_DIR = path.join(__dirname);
  const LIB_DIR = path.join(SCRIPTS_DIR, 'lib');
  // Sentinel outlet IDs — if a Set/Array literal contains 3+ of these, it's likely a hardcoded outlet list
  const SENTINEL_IDS = ['nytimes', 'variety', 'vulture', 'guardian', 'timeout', 'newyorker', 'washpost', 'wsj', 'hollywood-reporter', 'theatermania'];
  // Files that are allowed to have outlet IDs (the registry itself, this validator, normalization lib, score extractors)
  const ALLOWLIST = ['validate-data.js', 'review-normalization.js', 'outlet-tiers.js', 'outlet-id-mapper.ts', 'score-extractors.js', 'url-discovery.js'];

  let flagged = 0;
  // Scan both scripts/ and scripts/lib/
  const filesToScan = [];
  try {
    for (const f of fs.readdirSync(SCRIPTS_DIR)) {
      if (f.endsWith('.js') && !ALLOWLIST.includes(f)) filesToScan.push({ name: f, path: path.join(SCRIPTS_DIR, f) });
    }
    if (fs.existsSync(LIB_DIR)) {
      for (const f of fs.readdirSync(LIB_DIR)) {
        if (f.endsWith('.js') && !ALLOWLIST.includes(f)) filesToScan.push({ name: `lib/${f}`, path: path.join(LIB_DIR, f) });
      }
    }
  } catch { ok('Skipped hardcoded outlet list check (scripts dir unreadable)'); return; }

  for (const file of filesToScan) {
    try {
      const content = fs.readFileSync(file.path, 'utf8');
      // Find Set/Array literals that span multiple lines with outlet-like IDs
      const blocks = content.match(/new Set\(\[[\s\S]{10,500}?\]\)/g) || [];
      const arrayBlocks = content.match(/const \w+(?:_OUTLETS|_OUTLET_IDS|OUTLETS_\w+)\s*=\s*\[[\s\S]{10,500}?\]/g) || [];
      for (const block of [...blocks, ...arrayBlocks]) {
        const hits = SENTINEL_IDS.filter(id => block.includes(`'${id}'`) || block.includes(`"${id}"`));
        if (hits.length >= 3) {
          // Check surrounding context (block + 200 chars before it) for registry-derived comments
          const blockIdx = content.indexOf(block);
          const context = content.substring(Math.max(0, blockIdx - 200), blockIdx) + block;
          if (/outlet-registry|registry.*source of truth|derived from.*registry/i.test(context)) continue;
          warn(`Hardcoded outlet list in ${file.name} (contains ${hits.length} sentinel IDs: ${hits.slice(0, 4).join(', ')}...) — consider deriving from outlet-registry.json`);
          flagged++;
        }
      }
    } catch { /* skip unreadable files */ }
  }
  if (flagged === 0) ok('No hardcoded outlet lists detected in scripts');
  else console.log(`  ⚠️  ${flagged} hardcoded outlet list(s) found — consider migrating to outlet-registry.json`);
}

function runValidation() {
  console.log('='.repeat(60));
  console.log('BROADWAY SCORECARD DATA VALIDATION');
  console.log('='.repeat(60));
  console.log(`Mode: ${strictMode ? 'STRICT' : 'STANDARD'}`);
  console.log('');

  // Check shows.json exists and is valid JSON
  if (!fs.existsSync(SHOWS_FILE)) {
    error('shows.json does not exist');
    exitWithError('shows.json does not exist');
  }

  let shows;
  try {
    const data = loadShows();
    shows = data.shows || data;
    ok(`Loaded ${shows.length} shows from shows.json`);
  } catch (e) {
    error(`shows.json parse error: ${e.message}`);
    exitWithError(`shows.json parse error: ${e.message}`);
  }

  console.log('');

  // Run all validations
  validateNoDuplicates(shows);
  console.log('');
  validateRequiredFields(shows);
  console.log('');
  validateStatus(shows);
  validateShowTypes(shows);
  validateDates(shows);
  validateSlugs(shows);
  validateImageUrls(shows);
  validateImageFiles(shows);
  validatePlaceholderImageHashes(shows);
  validateVenueCategory(shows);
  validateTheaterAddress(shows);
  console.log('');
  validateSynopsisQuality(shows);
  validateCreativeTeamQuality(shows);
  validateCreativeTeamCompleteness(shows);
  console.log('');
  validateMinimumCounts(shows);
  console.log('');
  checkForCatastrophicChanges();
  console.log('');
  validateGrossesJson();
  console.log('');
  validateSchedulesJson(shows);
  console.log('');
  validateCommercialJson();
  console.log('');
  validateReviewData(shows);
  console.log('');
  const reviewCount = validateReviewsJson() || 0;
  console.log('');
  validateOutletFragmentation();
  console.log('');
  validateOutletRegistryDuplicates();
  console.log('');
  validateOutletRegistryDomainCollisions();
  console.log('');
  validateOutletRegistryFields();
  console.log('');
  validateCrossMarketContamination();
  console.log('');
  validateBlogReviews();
  console.log('');
  validateCrossFileKeys(shows);
  console.log('');
  validateReviewTextQuality(shows);
  console.log('');
  validateConsensusQuality();
  console.log('');
  validateRuntimeFormats(shows);
  console.log('');
  validateCreativeTeamDuplicateNames(shows);
  console.log('');
  validateCastFiles(shows);
  console.log('');
  const tonyResult = validateTonyData(shows);
  console.log('');
  validateActorImages();
  console.log('');
  validateAggregatorArchives(shows);
  console.log('');
  validateNonTheaterContent(shows);
  console.log('');
  validateOutletAliasIntegrity();
  console.log('');
  validateOutletMapperSync();
  console.log('');
  validateReviewOutletTiers();
  console.log('');
  validateP0ScoreCoverage();
  console.log('');
  validateReviewTextDuplicates(shows);
  console.log('');
  validateUnscoredReviewTexts();
  console.log('');
  validateNoHardcodedOutletLists();
  console.log('');
  validateShowMatchingAliases(shows);
  console.log('');
  validateLotteryRushData(shows);
  console.log('');
  validateTourReviewContamination();
  console.log('');
  validateCrossMarketSourceFiles();
  console.log('');
  validateAggregatorScoreContamination();
  console.log('');
  validateLastUpdatedFormats();
  console.log('');
  validateTodayTixShowtimes(shows);

  // Summary
  console.log('');
  console.log('='.repeat(60));
  console.log('VALIDATION RESULT');
  console.log('='.repeat(60));

  if (errors.length > 0) {
    console.log(`\n❌ FAILED: ${errors.length} error(s) found\n`);
    errors.forEach((e, i) => console.log(`   ${i + 1}. ${e}`));
    // Notion 362637c5-416f-8174 — leave breadcrumb for push-core-data composite
    // action so it refuses to push corrupt data even when its `if: always()` step
    // fires. Composite reads ${RUNNER_TEMP}/.skip-push-core-data and gates push.
    exitWithError(`${errors.length} validation error(s); first: ${errors[0]}`);
  }

  // Write baseline file on successful validation
  const openShows = shows.filter(s => s.status === 'open');
  // Build per-show review counts for regression detection
  const perShowReviews = {};
  if (reviewCount > 0) {
    try {
      const reviewsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'reviews.json'), 'utf8'));
      for (const r of (reviewsData.reviews || reviewsData)) {
        const sid = r.showId || 'unknown';
        perShowReviews[sid] = (perShowReviews[sid] || 0) + 1;
      }
    } catch (e) { /* skip per-show baseline if reviews.json unreadable */ }
  }
  const newBaseline = {
    totalShows: shows.length,
    openShows: openShows.length,
    totalReviews: reviewCount,
    tonyNominations: tonyResult?.totalNominations || null,
    tonyWins: tonyResult?.totalWins || null,
    perShowReviews,
    updatedAt: new Date().toISOString(),
  };
  try {
    const auditDir = path.dirname(BASELINE_FILE);
    if (!fs.existsSync(auditDir)) {
      fs.mkdirSync(auditDir, { recursive: true });
    }
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(newBaseline, null, 2) + '\n');
    ok(`Baseline written: ${newBaseline.totalShows} shows, ${newBaseline.openShows} open, ${newBaseline.totalReviews} reviews`);
  } catch (e) {
    warn(`Failed to write baseline file: ${e.message}`);
  }

  if (warnings.length > 0) {
    console.log(`\n⚠️  PASSED WITH ${warnings.length} WARNING(S)\n`);
    warnings.forEach((w, i) => console.log(`   ${i + 1}. ${w}`));
  } else {
    console.log('\n✅ ALL VALIDATIONS PASSED\n');
  }

  // Clear any stale sentinel from a prior failed run on this runner so
  // push-core-data isn't blocked on data that's now valid.
  clearPushRefusalSentinel();

  process.exit(0);
}

/**
 * Validate show-matching.js aliases point to valid slugs in shows.json.
 * Prevents scraper mismatches from broken alias → slug mappings.
 */
function validateShowMatchingAliases(shows) {
  info('Checking show-matching.js alias targets...');
  const aliasFile = path.join(__dirname, 'lib', 'show-matching.js');
  if (!fs.existsSync(aliasFile)) {
    warn('show-matching.js not found, skipping alias validation');
    return;
  }

  const slugSet = new Set(shows.map(s => s.slug));
  const content = fs.readFileSync(aliasFile, 'utf8');

  // Extract KNOWN_ALIASES entries: 'key': 'slug-value'
  const aliasPattern = /['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g;
  let match;
  let checked = 0;
  let issues = 0;
  while ((match = aliasPattern.exec(content)) !== null) {
    const alias = match[1];
    const target = match[2];
    // Skip non-slug values (URLs, etc)
    if (target.includes('/') || target.includes('.')) continue;
    checked++;
    if (!slugSet.has(target)) {
      warn(`show-matching.js alias "${alias}" → "${target}" — target slug not found in shows.json`);
      issues++;
    }
  }

  if (issues === 0 && checked > 0) {
    ok(`All ${checked} show-matching aliases point to valid slugs`);
  }
}

/**
 * Validate lottery-rush.json for duplicate entries and orphaned show IDs.
 * Catches: digitalRush duplicating lottery (same platform), entries for shows not in shows.json.
 */
function validateLotteryRushData(shows) {
  info('Checking lottery-rush.json...');
  const lotteryFile = path.join(DATA_DIR, 'lottery-rush.json');
  if (!fs.existsSync(lotteryFile)) {
    warn('lottery-rush.json not found, skipping');
    return;
  }

  let lotteryData;
  try {
    lotteryData = JSON.parse(fs.readFileSync(lotteryFile, 'utf8'));
  } catch (e) {
    error(`lottery-rush.json parse error: ${e.message}`);
    return;
  }

  const idSet = new Set(shows.map(s => s.id));
  const entries = lotteryData.shows || lotteryData;
  let issues = 0;

  for (const [showId, data] of Object.entries(entries)) {
    if (showId.startsWith('_')) continue;

    // Check for digitalRush duplicating lottery (same platform AND same price = true duplicate)
    if (data.digitalRush && data.lottery) {
      const rushPlatform = (data.digitalRush.platform || '').toLowerCase();
      const lotteryPlatform = (data.lottery.platform || '').toLowerCase();
      if (rushPlatform && lotteryPlatform && rushPlatform === lotteryPlatform) {
        if (data.digitalRush.price === data.lottery.price) {
          warn(`lottery-rush.json "${showId}": digitalRush and lottery both use "${data.lottery.platform}" at $${data.lottery.price} — duplicate entry`);
        } else {
          // Different prices = likely different programs (e.g., day-of rush vs day-before lottery)
        }
        issues++;
      }
    }
  }

  // Check for digital lotteries/rush with platform but no URL.
  // Known platforms (TodayTix, Broadway Direct, etc.) always have a standard URL — error.
  // Show-specific platforms ("show website", "Hamilton App", etc.) may not have a single URL — warn.
  const KNOWN_PLATFORM_URLS = {
    'telecharge': 'https://rush.telecharge.com',
    'luckyseat': 'https://www.luckyseat.com',
    'todaytix': 'https://www.todaytix.com',
    'broadway direct': 'https://lottery.broadwaydirect.com',
  };
  // Platforms that are show-specific or app-based — no standard URL to require.
  // 'inyougo' is the InYouGo London lottery (app-based draw entry, no reliable
  // per-show web URL — the scraper records the platform from "enter via InYouGo"
  // instructions). Treat like other app-based platforms: warn, don't error.
  const CUSTOM_PLATFORM_PATTERNS = ['show website', 'app', 'website', 'inyougo'];
  let missingUrlErrors = 0;
  let missingUrlWarnings = 0;

  for (const [showId, data] of Object.entries(entries)) {
    if (showId.startsWith('_')) continue;
    const types = [
      { name: 'lottery', entry: data.lottery },
      { name: 'digitalRush', entry: data.digitalRush },
    ];
    for (const { name, entry } of types) {
      if (entry && entry.platform && !entry.url) {
        const platformLower = (entry.platform || '').toLowerCase();
        const knownUrl = KNOWN_PLATFORM_URLS[platformLower];
        const isCustom = !knownUrl && CUSTOM_PLATFORM_PATTERNS.some(p => platformLower.includes(p));
        if (knownUrl || !isCustom) {
          // Known platform or unrecognized platform — error (we should have a URL)
          error(`lottery-rush.json "${showId}": ${name} has platform "${entry.platform}" but no url${knownUrl ? ` (expected: ${knownUrl})` : ''}`);
          missingUrlErrors++;
        } else {
          // Show-specific or app-based platform — warn (URL may not be discoverable)
          warn(`lottery-rush.json "${showId}": ${name} has platform "${entry.platform}" but no url — add when URL is known`);
          missingUrlWarnings++;
        }
      }
    }
  }

  if (missingUrlErrors > 0) {
    error(`${missingUrlErrors} lottery/rush entries have platform but no URL — users can't click through`);
  }
  if (missingUrlWarnings > 0) {
    warn(`${missingUrlWarnings} lottery/rush entries have show-specific platform but no URL — add URLs when available`);
  }

  if (issues === 0 && missingUrlErrors === 0) {
    ok('No duplicate lottery/rush entries or missing URLs detected');
  }
}

function validateTodayTixShowtimes(shows) {
  console.log('--- TodayTix Showtimes ---');
  const ttPath = path.join(__dirname, '..', 'data', 'todaytix-showtimes.json');
  if (!fs.existsSync(ttPath)) {
    warn('todaytix-showtimes.json does not exist (deep links disabled)');
    return;
  }

  let ttData;
  try {
    ttData = JSON.parse(fs.readFileSync(ttPath, 'utf8'));
  } catch (e) {
    error('todaytix-showtimes.json is not valid JSON');
    return;
  }

  if (!ttData.shows || typeof ttData.shows !== 'object') {
    error('todaytix-showtimes.json missing "shows" object');
    return;
  }

  const showCount = Object.keys(ttData.shows).length;
  const openWithTTId = shows.filter(s => (s.status === 'open' || s.status === 'previews') && s.todaytixId).length;

  // Staleness check
  if (ttData.lastUpdated) {
    const age = (Date.now() - new Date(ttData.lastUpdated).getTime()) / (1000 * 60 * 60);
    if (age > 48) {
      warn(`todaytix-showtimes.json is ${Math.round(age)}h old (last updated: ${ttData.lastUpdated})`);
    }
  }

  // Coverage check
  if (showCount === 0) {
    warn('todaytix-showtimes.json has 0 shows');
  } else if (showCount < openWithTTId * 0.5) {
    warn(`todaytix-showtimes.json has ${showCount} shows but ${openWithTTId} open shows have todaytixId (< 50% coverage)`);
  }

  // Structural check: all showtime IDs must be positive integers
  let badIds = 0;
  for (const [showId, entry] of Object.entries(ttData.shows)) {
    if (!entry.todaytixId || typeof entry.todaytixId !== 'number') {
      error(`todaytix-showtimes.json "${showId}": missing or invalid todaytixId`);
      badIds++;
    }
    for (const [date, slots] of Object.entries(entry.showtimes || {})) {
      for (const [slot, id] of Object.entries(slots)) {
        if (typeof id !== 'number' || id <= 0) {
          error(`todaytix-showtimes.json "${showId}" ${date}.${slot}: invalid showtime ID ${id}`);
          badIds++;
        }
      }
    }
  }

  if (badIds === 0) {
    ok(`${showCount} shows with valid showtime IDs (${openWithTTId} eligible)`);
  }
}

runValidation();
