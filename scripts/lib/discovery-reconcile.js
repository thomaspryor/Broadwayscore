const fs = require('fs');
const path = require('path');
const { normalizeTitle, areTitlesSimilar } = require('./deduplication');

/**
 * Stale-entry reconciliation for scripts/discover-new-shows.js (Gap C, card #1446).
 *
 * checkForDuplicate() / the todaytixId dedup step correctly identify a
 * rediscovered candidate as an existing shows.json entry, then historically
 * did nothing further with it — the existing entry's preview/opening date
 * and venue could sit stale forever. wanted-2022 carried a 2022-10-28 preview
 * date for a show that's actually previewing 2026-10-15 until a session
 * hand-patched the data directly (commit 37daf0f2fba) — the code path that
 * found the match never wrote anything back.
 *
 * Deliberately scoped to shows that haven't started their run yet (status
 * 'announced' or 'upcoming'): an 'open'/'previews' show's dates are already
 * confirmed by the run itself (and may carry a manual correction), and a
 * 'closed' show is historical — discovery re-crawls shouldn't touch either.
 *
 * Two further guards added after adversarial review (ship-check, card #1446):
 * - openingDate is only overwritten when BOTH the existing entry's source and
 *   the candidate's source are re-crawlable ones. A curated/human-verified
 *   openingDateSource (e.g. 'review-derived-press-night' — set when a press
 *   night is inferred from actual published reviews) must never be silently
 *   clobbered by a routine TodayTix/Playbill re-listing; West End opening-
 *   night selection depends on that source trust (scripts/lib/opening-night-
 *   selection.js). A candidate date with no source at all is also refused —
 *   writing a new date while leaving the old source label creates an
 *   inconsistent (date, source) pair.
 * - previewsStartDate/venue patches likewise only apply while openingDate is
 *   still re-crawlable (or unset) — once an opening date has been curated by
 *   hand, the whole record is treated as settled rather than picking which
 *   individual fields to still trust.
 *
 * A third guard added after the same review: reconciliation trusts WHICHEVER
 * check matched (todaytixId equality, or any of checkForDuplicate's 9 checks,
 * including its loosest fuzzy/containment ones) as proof this is the same
 * production. scripts/lib/todaytix-dates.js documents that TodayTix recycles
 * show IDs across unrelated productions — the reason unconfirmedStartDate
 * quarantining exists for dates — but nothing quarantined venue, so a
 * recycled-ID or loose-fuzzy false-positive match could silently overwrite a
 * real show's venue with an unrelated production's. Independent of which
 * check matched, require the candidate's title to itself resemble the
 * existing show's title before writing anything.
 */
const RECRAWLABLE_OPENING_DATE_SOURCES = new Set(['playbill', 'ibdb', 'todaytix', null, undefined]);

function titlesResembleEachOther(a, b) {
  const na = normalizeTitle(a || '');
  const nb = normalizeTitle(b || '');
  if (!na || !nb) return false;
  if (na === nb) return true;
  return areTitlesSimilar(na, nb);
}

function computeShowReconciliation(existing, candidate) {
  if (!existing || !candidate) return null;
  if (existing.status !== 'announced' && existing.status !== 'upcoming') return null;
  if (!RECRAWLABLE_OPENING_DATE_SOURCES.has(existing.openingDateSource)) return null;
  if (!titlesResembleEachOther(existing.title, candidate.title)) return null;

  const patch = {};

  if (candidate.openingDate && candidate.openingDateSource &&
      candidate.openingDate !== existing.openingDate) {
    patch.openingDate = candidate.openingDate;
    patch.openingDateSource = candidate.openingDateSource;
  }
  if (candidate.previewsStartDate && candidate.previewsStartDate !== existing.previewsStartDate) {
    patch.previewsStartDate = candidate.previewsStartDate;
  }
  if (candidate.venue && candidate.venue !== existing.venue) {
    patch.venue = candidate.venue;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Multi-source-agreement gate (BRO-2072, follow-up to #1446 / card #1446
 * ship-check gap #1).
 *
 * computeShowReconciliation() above only checks whether a candidate is the
 * SAME show as an existing entry — it says nothing about whether the
 * candidate's data is trustworthy enough to overwrite what's already there.
 * A single source's parser regression (a botched Playbill scrape, a
 * TodayTix field remap) would previously patch venue/dates straight onto
 * shows.json for every match in that run with no independent corroboration.
 *
 * Mirrors scripts/enrich-off-broadway-dates.js:919's pattern: a value seen
 * from >=2 independent discovery sources in the same run is trusted outright;
 * a single source is only trusted for a small date nudge (this is the
 * original card #1446 bug — a stale date drifting by days/weeks as a show's
 * schedule firms up) capped at RECONCILE_MAX_SHIFT_DAYS. A single source
 * proposing a venue change, or a date shift bigger than the cap, is withheld
 * — those look like either a wrong-production match or a parser regression,
 * not routine drift.
 */
const RECONCILE_MAX_SHIFT_DAYS = 60;

// Reconciliation candidates never pass through the ISO-normalization step
// scripts/discover-new-shows.js applies to brand-new shows (that happens
// later in the pipeline, only for the `newShows` path) — an unparseable
// candidate date can reach here as-is. Infinity (not 0) for a bad parse:
// this only runs once evaluateReconciliationSafety has already confirmed
// BOTH sides are present, so a NaN here means malformed input, not "nothing
// to compare" — it must fail the shift cap, not silently pass it.
function dayShift(a, b) {
  if (!a || !b) return 0;
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  if (Number.isNaN(ms)) return Infinity;
  return Math.round(ms / 86400000);
}

function evaluateReconciliationSafety(existing, patch, agreeingSourceCount) {
  if (agreeingSourceCount >= 2) {
    return { safe: true, reason: 'multi-source-agreement' };
  }

  const holdReasons = [];
  if (patch.venue) {
    holdReasons.push(existing.venue ? 'venue-change-single-source-unconfirmed' : 'venue-fill-single-source-unconfirmed');
  }
  // Per-field, not a combined max: dayShift(a, b) returns 0 whenever either
  // side is missing, so a combined check would let a single source fill in
  // ANY date for a show with no existing baseline (shiftDays trivially 0) —
  // exactly the parser-regression case this gate exists to catch, and worse
  // for a freshly-announced show since there's nothing to sanity-check
  // against. Missing-baseline fills are held for corroboration same as venue.
  for (const field of ['openingDate', 'previewsStartDate']) {
    if (!patch[field]) continue;
    if (!existing[field]) {
      holdReasons.push(`${field}-fill-single-source-unconfirmed`);
      continue;
    }
    const shiftDays = dayShift(patch[field], existing[field]);
    if (shiftDays > RECONCILE_MAX_SHIFT_DAYS) {
      holdReasons.push(`${field}-shift-too-large (${shiftDays}d > ${RECONCILE_MAX_SHIFT_DAYS}d cap)`);
    }
  }
  if (holdReasons.length > 0) {
    return { safe: false, reason: holdReasons.join('; ') };
  }
  return { safe: true, reason: 'single-source-small-change' };
}

/**
 * Resolves one existing show's accumulated per-run reconciliation proposals
 * (BRO-2072) into a final patch + a list of held (unconfirmed) fields.
 *
 * `fields.openingDate` is a Map<dateValue, { sources: Set<sourceLabel>,
 * openingDateSource }> — openingDate and openingDateSource are resolved as
 * one unit, keyed by date, so the winning date's provenance always comes
 * from a candidate that actually proposed that date (never an independently
 * "most popular" source label tied to a DIFFERENT date). `fields.venue` and
 * `fields.previewsStartDate` are plain Map<value, Set<sourceLabel>> — ties
 * keep the first value seen (insertion order).
 *
 * Pure and side-effect-free (no shows.json mutation, no audit writes) so
 * discover-new-shows.js's per-run source-tagging/accumulation logic can be
 * exercised directly in scripts/lib/discovery-reconcile.test.mjs instead of
 * only through its three exported primitives in isolation.
 */
function resolveReconciliationFields(existing, fields) {
  const patch = {};
  const heldFields = [];

  if (fields.openingDate) {
    let bestValue = null;
    let bestEntry = null;
    for (const [value, entry] of fields.openingDate.entries()) {
      if (!bestEntry || entry.sources.size > bestEntry.sources.size) {
        bestValue = value;
        bestEntry = entry;
      }
    }
    const fieldPatch = { openingDate: bestValue, openingDateSource: bestEntry.openingDateSource };
    const safety = evaluateReconciliationSafety(existing, fieldPatch, bestEntry.sources.size);
    if (safety.safe) {
      Object.assign(patch, fieldPatch);
    } else {
      heldFields.push({ field: 'openingDate', value: bestValue, agreeingSourceCount: bestEntry.sources.size, reason: safety.reason });
    }
  }

  for (const field of ['previewsStartDate', 'venue']) {
    if (!fields[field]) continue;
    let bestValue = null;
    let bestSources = null;
    for (const [value, sources] of fields[field].entries()) {
      if (!bestSources || sources.size > bestSources.size) {
        bestValue = value;
        bestSources = sources;
      }
    }
    const fieldPatch = { [field]: bestValue };
    const safety = evaluateReconciliationSafety(existing, fieldPatch, bestSources.size);
    if (safety.safe) {
      Object.assign(patch, fieldPatch);
    } else {
      heldFields.push({ field, value: bestValue, agreeingSourceCount: bestSources.size, reason: safety.reason });
    }
  }

  return { patch, heldFields };
}

/**
 * Before/after audit trail for reconciliation patches (BRO-2072 gap #3).
 * Mirrors enrich-off-broadway-dates.js's appendAudit(): read-append-write,
 * capped history, one entry per run (even a no-op run, so an operator can
 * see discovery ran and found nothing to reconcile).
 */
const AUDIT_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'discovery-reconciliation-log.json');
const AUDIT_MAX_RUNS = 50;

// auditPath is overridable (unit tests point it at a tmp file) so exercising
// this never writes into the real, git-tracked data/audit/ directory.
function appendReconciliationAudit(entries, meta = {}, auditPath = AUDIT_PATH) {
  if (entries.length === 0) return;
  let existing = { _meta: { schema: 'discovery-reconciliation-log v1' }, runs: [] };
  if (fs.existsSync(auditPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      if (!Array.isArray(existing.runs)) existing.runs = [];
    } catch {
      // corrupt audit file — start fresh rather than blocking the run.
    }
  }
  existing.runs.push({
    runAt: new Date().toISOString(),
    script: 'discover-new-shows',
    ...meta,
    entries,
  });
  if (existing.runs.length > AUDIT_MAX_RUNS) existing.runs = existing.runs.slice(-AUDIT_MAX_RUNS);
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(auditPath, JSON.stringify(existing, null, 2));
}

module.exports = {
  computeShowReconciliation,
  evaluateReconciliationSafety,
  resolveReconciliationFields,
  appendReconciliationAudit,
  RECONCILE_MAX_SHIFT_DAYS,
  AUDIT_PATH,
};
