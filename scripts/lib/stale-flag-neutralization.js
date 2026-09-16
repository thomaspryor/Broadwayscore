/**
 * BRO-1431: when a review file's body transitions from an empty/short stub to
 * a substantial real article — ingest-urls.js re-ingesting a URL, or
 * collect-review-texts.js's fetch landing on an existing stub — exclusion
 * state stamped against the OLD (empty/wrong) body must not silently survive.
 * Without this, the review looks collected (fullText present) but stays
 * excluded from scoring until someone notices and manually clears it with the
 * full protection-field set (memory/feedback_manual_review_protection_fields.md).
 *
 * Evidence: 2026-07-13 Met opera backfill — 7 bachtrack revival reviews got
 * real bodies injected into stubs that carried wrongProduction:true (stamped
 * by review-file-writer.js's Guard A market-routing "ambiguous-production"
 * call, made with no body to judge from — see createOrMergeReviewFile). All 7
 * stayed excluded until manually cleared (review-texts commits after
 * 87ebe2d7ce0).
 *
 * Deliberately narrow, matching the caution documented in
 * stale-flag-after-url-correction.js: a prior blanket auto-remediation built
 * on a similar "this flag might be stale" signal was removed after it put
 * aggregatorStars-scored wrong-production reviews straight into live scoring
 * (see that file's "NOTE: this module deliberately has NO auto-remediation").
 * To avoid repeating that mistake:
 *   - Only fires when the body ACTUALLY improved (short/empty -> substantial).
 *   - Never clears a flag a human already stood behind (manual-clear fields,
 *     an override, a provenance of 'manual', or an existing human score).
 *   - Never clears a flag whose stated basis is a pure DATE claim — a date
 *     guard's verdict has nothing to do with the article's body, so new text
 *     can't contradict it (same carve-out gather-reviews.js's URL-replacement
 *     path and url-change-invariant.js's AUTO_DATE_WP_PREFIXES already apply).
 *   - Clears the flag rather than asserting it's wrong: the file becomes
 *     re-checkable by the normal contentVerification/scoring pipeline, which
 *     can re-flag it if the fresh text really is the wrong production. The
 *     clear is stamped via the canonical wrongProductionAutoCleared(+At)
 *     breadcrumb pair (review-write-guard.js's CLEAR_BREADCRUMBS /
 *     _freshWrongProductionAutoClear) so safeWriteReview's protected-field
 *     restore honors it instead of resurrecting the stale flag from disk.
 *   - Never runs when a fresh contentVerification pass for THIS body already
 *     ran in the SAME write (collect-review-texts.js gates its call on
 *     `!contentVerification`) — that pass already IS the re-evaluation, and
 *     this function must not undo what it just concluded.
 *   - Never touches a record a human has weighed in on, in either direction
 *     (isHumanClearedWrongProduction) — this also protects a manual-entry
 *     write that supplies its own fresh contentVerification alongside the
 *     body (manual-review-fields.js), which would otherwise get its verdict
 *     fields stripped by the same logic that neutralizes a genuinely stale one.
 *
 * Known accepted gap (Codex adversarial review, BRO-1431 ship-check): clearing
 * is not proof of correctness, only proof that re-verification is now
 * possible. Between this clear and the next LLM wrong-production pass
 * (enrich-reviews.yml, up to 6h later), a review of the SAME wrong production
 * with a merely-longer body could sit includable. This mirrors the existing
 * risk window every newly-created review already has before its first LLM
 * verification — not a new regression — and closing it fully would mean
 * gating inclusion on synchronous re-verification, out of this fix's scope.
 *
 * wrongShow is intentionally NOT handled here — its manual-clear/URL-lock
 * semantics are a separate, more delicate subsystem (see
 * memory/feedback_inplace_url_update_preserves_stale_state.md and the
 * JCS Palladium incident it documents); scope this module to wrongProduction
 * until wrongShow's equivalent is designed and vetted separately.
 *
 * Pure module: no fs, no process, no side effects beyond mutating the passed
 * `existing` object in place (mirrors clear-failure-flags.js's contract).
 */

'use strict';

const { WRONG_PRODUCTION_PROVENANCE_FIELDS } = require('./wrongproduction-provenance');

const BODY_STALE_THRESHOLD = 600;
const BODY_SUBSTANTIAL_THRESHOLD = 2000;

// Content-INDEPENDENT wrongProduction bases — computed from a publish date or
// a declared prior-run/tour window, not from what the article actually says.
// New body text can never contradict these, so they must survive a body
// replacement untouched. Prefix set mirrors url-change-invariant.js's
// AUTO_DATE_WP_PREFIXES, plus the write-time date-guard reason shape from
// review-guards.js's getWrongProductionReasonFromUrl ("Auto-flagged: URL date
// ...", stamped by Guards J/K in review-file-writer.js).
const DATE_BASED_WRONGPROD_PREFIXES = [
  'Pre-opening guard',
  'Date guard',
  'Dateless show',
  'Tour transfer',
  'Auto-flagged: URL date',
];

// collect-review-texts.js's anticipatory-pre-opening-post gate stamps this
// exact reason string (no note prefix) — also a pure date/window claim.
const DATE_BASED_WRONGPROD_REASONS = new Set(['anticipatory_pre_opening_post']);

function _wrongProductionBasisStrings(existing) {
  return [existing.wrongProductionNote, existing.wrongProductionReason, existing.wrongProductionDetail]
    .filter((s) => typeof s === 'string' && s.trim());
}

/**
 * True when the current wrongProduction flag's stated basis is a pure date
 * claim — a body replacement must not clear these.
 * @param {object} existing
 * @returns {boolean}
 */
function isDateBasedWrongProduction(existing) {
  if (!existing) return false;
  if (existing.wrongProductionReason && DATE_BASED_WRONGPROD_REASONS.has(existing.wrongProductionReason)) {
    return true;
  }
  return _wrongProductionBasisStrings(existing).some(
    (basis) => DATE_BASED_WRONGPROD_PREFIXES.some((prefix) => basis.startsWith(prefix))
  );
}

/**
 * Signals that a human (or an explicit override flow) already made a
 * decision about this file's wrongProduction state — in EITHER direction —
 * so nothing here should auto-touch it. Single source of truth:
 * review-file-writer.js imports this rather than keeping its own local copy
 * (BRO-1431 — previously duplicated as `_isHumanClearedWrongProduction`),
 * and collect-review-texts.js shares it too, so the shared writer and the
 * fetch pipeline can't drift. Mirrors contradicted-flag-basis.js's
 * hasHumanAssertedFlag (same humanReviewScore / wrongProductionProvenance
 * ==='manual' signals) for the sibling "don't second-guess a human" rule
 * elsewhere in this codebase.
 *
 * `humanReviewedWrongProduction === true` (Codex adversarial review,
 * BRO-1431 ship-check) is included alongside `=== false`: the field name
 * describes WHETHER a human reviewed it, not which way they ruled, and a
 * human confirming a review genuinely IS the wrong production must be just
 * as untouchable as one confirming it isn't — clearing the flag out from
 * under an explicit human "yes, this is wrong" would be worse than the
 * bug this module exists to fix.
 * @param {object|null|undefined} existing
 * @returns {boolean}
 */
function isHumanClearedWrongProduction(existing) {
  if (!existing) return false;
  return typeof existing.humanReviewedWrongProduction === 'boolean'
    || existing.wrongProductionManualClear === true
    || existing.wrongProductionOverride === true
    || existing.wrongProduction === false
    || existing.wrongProductionProvenance === 'manual'
    || existing.humanReviewScore != null;
}

/**
 * True when a body went from empty/short (< BODY_STALE_THRESHOLD chars) to
 * substantial (>= BODY_SUBSTANTIAL_THRESHOLD chars) — the transition that
 * makes any exclusion state stamped against the OLD body suspect.
 * @param {string|null|undefined} fullTextBefore
 * @param {string|null|undefined} fullTextAfter
 * @returns {boolean}
 */
function bodyBecameSubstantial(fullTextBefore, fullTextAfter) {
  const before = typeof fullTextBefore === 'string' ? fullTextBefore.trim().length : 0;
  const after = typeof fullTextAfter === 'string' ? fullTextAfter.trim().length : 0;
  return before < BODY_STALE_THRESHOLD && after >= BODY_SUBSTANTIAL_THRESHOLD;
}

// contentVerification fields that describe the OLD body's verdict — same set
// gather-reviews.js's URL-replacement path already clears (the
// applyUrlChangeInvariant call site), plus the CV-level wrongProduction
// mirror collect-review-texts.js writes alongside contentVerification.isValid.
// Deliberately NOT the whole object: fields like contentVerification.isFilmTv
// describe the article's TYPE, not a verdict about whether it's the right
// production/article, and aren't invalidated by a body replacement.
const STALE_CV_FIELDS = ['isValid', 'wrongArticle', 'wrongProduction', 'verifiedAt', 'verifiedBy', 'reasoning', 'confidence'];

/**
 * Neutralize stale exclusion state on `existing` when its body just
 * transitioned from empty/short to substantial. Mutates `existing` in place.
 *
 * @param {object} existing - parsed review-text record (mutated)
 * @param {string} fullTextBefore - the body's value BEFORE this write
 * @param {object} [opts]
 * @param {string} [opts.now] - ISO timestamp override (for tests)
 * @returns {string[]} names of the groups cleared ('contentVerification' and/or
 *   'wrongProduction'), for logging — empty when the transition didn't
 *   qualify or nothing needed clearing.
 */
function neutralizeStaleFlagsOnBodyReplacement(existing, fullTextBefore, opts = {}) {
  if (!existing || typeof existing !== 'object') return [];
  if (!bodyBecameSubstantial(fullTextBefore, existing.fullText)) return [];
  // Never touch a record a human has already weighed in on — neither the
  // contentVerification cleanup below nor the wrongProduction clear further
  // down. Codex adversarial review (BRO-1431 ship-check): manual-review-
  // fields.js's operator-trust path writes a FRESH contentVerification
  // ({wrongProduction:false, wrongArticle:false}) in the SAME write that
  // fills in the body, alongside wrongProductionManualClear — blind
  // CV-field deletion here would strip the operator's own verdict, not a
  // stale one.
  if (isHumanClearedWrongProduction(existing)) return [];

  const cleared = [];
  const nowIso = opts.now || new Date().toISOString();

  // (a) stale contentVerification — its verdict describes the body that just
  // got replaced.
  if (existing.contentVerification && typeof existing.contentVerification === 'object') {
    let touched = false;
    for (const field of STALE_CV_FIELDS) {
      if (existing.contentVerification[field] !== undefined) {
        delete existing.contentVerification[field];
        touched = true;
      }
    }
    if (touched) cleared.push('contentVerification');
  }

  // (d) wrongProduction — clear only when neither a human decision nor a
  // date-derived (content-independent) basis is protecting it. Cleared, not
  // flipped to a verified-correct false: the file becomes re-checkable by
  // the normal verification/scoring pipeline rather than asserted clean.
  // Provenance breadcrumbs (WRONG_PRODUCTION_PROVENANCE_FIELDS) die with the
  // flag — an orphaned breadcrumb with no live flag is its own bug class
  // (see wrongproduction-provenance.js's docblock, task #1109/#2740).
  if (existing.wrongProduction === true
      && !isHumanClearedWrongProduction(existing)
      && !isDateBasedWrongProduction(existing)) {
    const wasNote = existing.wrongProductionNote || existing.wrongProductionReason || '(no reason recorded)';
    const autoClearedNote = `ingest: body replaced (empty/short -> substantial), was: ${wasNote}`;
    existing.wrongProduction = false;
    // wrongProductionNote has a fresh-auto-clear exemption in
    // review-write-guard.js's CLEAR_BREADCRUMBS (_freshWrongProductionAutoClear),
    // so nulling it is honored rather than restored from disk.
    existing.wrongProductionNote = null;
    // wrongProductionReason/Detail and the provenance breadcrumbs below have
    // NO such exemption — nulling them would be silently restored by
    // safeWriteReview's protected-field preserve loop (existing real value +
    // incoming null with no honored clear = restore). A non-empty value is
    // never treated as "empty" by that loop, so overwriting with a superseded
    // marker always wins outright, breadcrumb support or not.
    existing.wrongProductionReason = `superseded: ${autoClearedNote}`;
    existing.wrongProductionDetail = `superseded: ${autoClearedNote}`;
    for (const field of WRONG_PRODUCTION_PROVENANCE_FIELDS) {
      if (existing[field] !== undefined && existing[field] !== null) {
        existing[field] = `superseded: wrongProduction cleared ${nowIso}`;
      }
    }
    // Canonical clear breadcrumb (review-write-guard.js CLEAR_BREADCRUMBS /
    // _freshWrongProductionAutoClear) — required so safeWriteReview's
    // protected-field restore honors the wrongProduction/wrongProductionNote
    // clears above instead of resurrecting them from the on-disk copy.
    existing.wrongProductionAutoCleared = autoClearedNote;
    existing.wrongProductionAutoClearedAt = nowIso;
    cleared.push('wrongProduction');
  }

  return cleared;
}

module.exports = {
  BODY_STALE_THRESHOLD,
  BODY_SUBSTANTIAL_THRESHOLD,
  bodyBecameSubstantial,
  isDateBasedWrongProduction,
  isHumanClearedWrongProduction,
  neutralizeStaleFlagsOnBodyReplacement,
};
