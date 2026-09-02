/**
 * Shared provenance vocabulary for wrongProduction writers (task #1109).
 *
 * Root cause of the 2026-08-06 main-red (#1108): 35+ scripts write
 * `wrongProduction = true`, each inventing its own breadcrumb shape
 * (wrongProductionNote, wrongProductionReason, _wrongProductionDetectedBy,
 * llmReason, auditReason, ...). mergeReviews() had to guess a write's
 * provenance from that prose, guessed wrong, and auto-cleared a flag that
 * should have stayed — putting a 2016 Broadway Cats review on the 2026 West
 * End show page. The immediate fix (251be9b4b4c) added
 * isUrlProvenanceWrongProduction() below, gated on a one-entry legacy
 * allow-list. This module is the permanent fix: a canonical
 * `wrongProductionProvenance` field new writers can set directly instead of
 * being inferred, plus the static-scan primitives scripts/lint-
 * wrongproduction-provenance.js uses to fail CI when a writer sets the flag
 * with no provenance signal at all — the exact shape of writer this bug
 * class needs.
 *
 * Pure module: no fs, no process, no side effects. The corpus-resolution
 * half (isUrlProvenanceWrongProduction) is required by
 * scripts/lib/review-normalization.js; the static-scan half is required by
 * scripts/lint-wrongproduction-provenance.js. Tested by the colocated
 * scripts/lib/wrongproduction-provenance.test.mjs (CLAUDE.md rule 15 —
 * require()s these functions, does not restate them).
 */

'use strict';

const PROVENANCE_VALUES = new Set(['url', 'date', 'content', 'manual']);

// BRO-2740: the breadcrumb fields that describe WHY a wrongProduction flag was
// set. They are meaningless — and actively harmful — without the flag itself:
// a file carrying `wrongProductionDetectedBy` / `Detail` / `DetectedAt` with
// no `wrongProduction` reads to every downstream auditor as "this WAS flagged
// wrong-production", which is what reddened three Data Validation gates on
// 2026-09-02 (cross-market leak, sibling misroute, url-downgrade) for two
// files whose flag had legitimately been cleared.
//
// Corpus evidence for the dominant failure mode (measured 2026-09-02 over
// 42,520 review files, 204 orphans): 138 of the 156 `ingest-anticipatory-gate`
// orphans have the `wrongProduction` KEY ABSENT, no `wrongProductionReason`
// and NO `wrongProductionAutoCleared` breadcrumb. Every rebuild-all-reviews
// auto-clear path stamps that breadcrumb, so those 138 were not cleared by the
// rebuild — they were cleared by the URL-change path, which deleted exactly
// `wrongProduction` / `Reason` / `Note` and left everything below behind.
//
// This is the single source of truth for that set. Both URL-change clear lists
// (REPLACE_CLEAR_FIELDS in wrongprod-replacement-preserve.js, WP_FIELDS in
// url-change-invariant.js) spread it in, so a NEW provenance field added by a
// future detector is cleared by both paths the moment it is listed here — the
// drift that produced this bug class was two hand-maintained triples.
//
// NOT included, deliberately: `wrongProductionManualClear`,
// `humanReviewedWrongProduction`, `wrongProductionOverride` and the rest of
// the human-decision family. A human's clear stays valid across a URL change
// (see HUMAN_DECISION_FIELDS) — those fields describe a DECISION, not the
// basis of a flag. Also not included: `wrongProductionAutoCleared` /
// `AutoClearedAt`, which url-change-invariant.js already clears by name.
const WRONG_PRODUCTION_PROVENANCE_FIELDS = [
  // Canonical field (task #1109) — the whole point of adding it was that a
  // flag's provenance be explicit rather than inferred, so it must die with
  // the flag or the inference it replaced comes back wrong.
  'wrongProductionProvenance',
  // Modern detector stamps: apply-cross-production-llm-flags.js,
  // auto-triage-cross-production.js, collect-review-texts.js's anticipatory
  // gate (153 of the 156 orphans).
  'wrongProductionDetail',
  'wrongProductionDetectedAt',
  'wrongProductionDetectedBy',
  // The timestamp ON `wrongProductionReason` (review-write-guard.js:195), which
  // the flag triple already clears. Unlike everything else here it IS in
  // PROTECTED_FIELDS, so leaving it out stranded a protected date for a reason
  // that no longer exists — and being protected, nothing downstream would ever
  // clear it. Listing it here also subtracts it from SCORED_PRESERVE_FIELDS,
  // which is right: it must not be carried into a replacement whose reason was
  // dropped. The _urlChangedClear breadcrumb is what stops the push-restore
  // resurrecting it (code-review finding).
  'wrongProductionReasonAt',
  // Anticipatory-gate inputs. Written in the same block as the flag by
  // collect-review-texts.js:4402 and deleted in the same block by both
  // rebuild-all-reviews.js clear paths, so they belong to this family even
  // though they are not `wrongProduction*`-prefixed.
  'anticipatoryGateOutletCategory',
  'anticipatoryGateDaysBeforeOpening',
  // Legacy `_`-prefixed forms (cleanup-dedup-comprehensive.js, 49 orphans).
  // isUrlProvenanceWrongProduction() still READS `_wrongProductionDetectedBy`
  // via LEGACY_URL_DETECTORS, which is precisely why a stranded one is
  // dangerous: it makes a re-flagged file look URL-provenanced to the
  // mergeReviews self-heal on the strength of a PREVIOUS url's verdict.
  '_wrongProductionDetectedBy',
  '_wrongProductionDetectedAt',
  '_wrongProductionDetail',
  // Written in the SAME statement as _wrongProductionDetectedBy
  // (cleanup-dedup-comprehensive.js:300) and read as "this was flagged" by
  // one-off/audit-wp-cv-valid.js:154. Omitting it split a two-field write
  // across the clear boundary, stranding half of it (code-review finding).
  '_wrongProductionReason',
];

function isValidProvenance(value) {
  return typeof value === 'string' && PROVENANCE_VALUES.has(value);
}

// Detectors whose only historical signal is `_wrongProductionDetectedBy`
// with no note. New writers should set wrongProductionProvenance = 'url'
// directly instead of growing this Set — kept only for the one corpus
// writer (cleanup-dedup-comprehensive.js) that predates the field.
const LEGACY_URL_DETECTORS = new Set(['cleanup-dedup-comprehensive']);

/**
 * Is this wrongProduction flag URL-based (and therefore eligible for the
 * venue-transfer self-heal in mergeReviews), as opposed to date- or
 * content-based?
 *
 * The explicit `wrongProductionProvenance` field, when present, is
 * authoritative — that is the entire point of adding it. Absent that field,
 * fall back to the legacy inference this function always used: a MISSING
 * note is NOT evidence of a URL-based flag (that default is what cleared
 * date-based flags and caused the 2026-08-06 main-red); evidence must be
 * positive, either a 'Same URL' note or an explicit legacy detector stamp.
 */
function isUrlProvenanceWrongProduction(data) {
  if (!data) return false;
  if (typeof data.wrongProductionProvenance === 'string') {
    return data.wrongProductionProvenance === 'url';
  }
  if (typeof data.wrongProductionNote === 'string'
      && data.wrongProductionNote.startsWith('Same URL')) {
    return true;
  }
  if (!data.wrongProductionNote && LEGACY_URL_DETECTORS.has(data._wrongProductionDetectedBy)) {
    return true;
  }
  return false;
}

// ── static-scan primitives (used by the lint CLI) ──────────────────────────

// Matches `.wrongProduction = true` member assignment, not `wrongProduction:
// true` object-literal construction (that form is caught separately by
// OBJECT_LITERAL_RE — kept distinct because a bare literal has no `.` prefix
// to anchor on and needs its own false-positive guard) and not comparisons
// (`===`/`!==`, filtered by the caller).
const ASSIGNMENT_RE = /\.wrongProduction\s*=\s*true\b/;

// `{ wrongProduction: true, ... }` object-literal construction — the blind
// spot a second-opinion review of this plan flagged: a writer that builds a
// brand-new object with the flag as a literal key would otherwise bypass
// ASSIGNMENT_RE entirely, reopening the "future writer invents its own
// shape" problem one syntax form over.
const OBJECT_LITERAL_RE = /\bwrongProduction\s*:\s*true\b/;

const PROVENANCE_FIELD_RE = /\b_?wrongProduction(?:Provenance|Reason|Note|DetectedBy)\s*[:=]/;

const PROVENANCE_WINDOW_LINES = 8;

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function isComparisonLine(line) {
  return line.includes('===') || line.includes('!==');
}

/**
 * Is `index` inside a string/template literal that opened earlier on this
 * (single) line? Single-line only — deliberately not tracking multi-line
 * template literals, the same simplification scripts/lint-resend-calls.js's
 * whole-file `.includes()` check makes.
 *
 * Needed because "wrongProduction: true" and ".wrongProduction=true" both
 * appear constantly as PROSE — console.log messages, `note:`/`description:`
 * field values quoting a prior flag decision, error-message templates — not
 * as real writes. Without this, the lint drowned in ~60 false positives on
 * this repo's real corpus (fix-cross-outlet-attributions*.js's `note:`
 * fields alone account for most of them) on its first real run.
 *
 * KNOWN GAP (ship-check adversarial review, task #1109): this quote-parity
 * tracker doesn't know about regex literals, so an apostrophe inside a
 * `/.../ ` regex on the SAME line as a `.wrongProduction = true` write (e.g.
 * `if (!x.match(/it's wrong/i)) data.wrongProduction = true;`) can flip the
 * parity into a false "inside a string" and hide a real, unprovenanced
 * write. No current writer in this repo does this — verified zero hits —
 * and this codebase's convention is one statement per line, so the fix
 * (real tokenization) isn't worth the complexity it would add to a
 * best-effort scanner. Same class of documented, accepted limitation as
 * scripts/lib/infra-review-scope.js's KNOWN_GAPS.
 */
function isInsideStringLiteral(line, index) {
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = 0; i < index; i++) {
    const c = line[i];
    if (c === '\\') { i++; continue; } // skip escaped char, incl. escaped quotes
    if (!inDouble && !inTemplate && c === "'") inSingle = !inSingle;
    else if (!inSingle && !inTemplate && c === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && c === '`') inTemplate = !inTemplate;
  }
  return inSingle || inDouble || inTemplate;
}

/**
 * Find every real `.wrongProduction = true` write in source text — member
 * assignment or object-literal construction — skipping comment lines,
 * `===`/`!==` comparisons, and matches inside string/template literals
 * (prose that merely mentions the flag).
 */
function findWrongProductionAssignments(content) {
  const lines = content.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line) || isComparisonLine(line)) continue;
    for (const re of [ASSIGNMENT_RE, OBJECT_LITERAL_RE]) {
      const m = re.exec(line);
      if (m && !isInsideStringLiteral(line, m.index)) {
        hits.push({ line: i + 1, text: line.trim() });
        break;
      }
    }
  }
  return hits;
}

/**
 * Does a provenance-carrying field (canonical or legacy) appear within
 * `windowLines` of the given 1-indexed line number? Comment lines inside the
 * window are excluded so a doc-comment mention can't paper over a real gap.
 */
function hasNearbyProvenanceSignal(content, lineNumber, windowLines = PROVENANCE_WINDOW_LINES) {
  const lines = content.split('\n');
  const idx = lineNumber - 1;
  const start = Math.max(0, idx - windowLines);
  const end = Math.min(lines.length, idx + windowLines + 1);
  const window = lines.slice(start, end)
    .filter((l) => !isCommentLine(l))
    .join('\n');
  return PROVENANCE_FIELD_RE.test(window);
}

/**
 * Full violation scan for one file's source text: every wrongProduction
 * write with no provenance signal nearby.
 */
function scanFileForViolations(content, relPath) {
  const violations = [];
  for (const hit of findWrongProductionAssignments(content)) {
    if (!hasNearbyProvenanceSignal(content, hit.line)) {
      violations.push({ file: relPath, line: hit.line, text: hit.text });
    }
  }
  return violations;
}

module.exports = {
  PROVENANCE_VALUES,
  WRONG_PRODUCTION_PROVENANCE_FIELDS,
  LEGACY_URL_DETECTORS,
  isValidProvenance,
  isUrlProvenanceWrongProduction,
  findWrongProductionAssignments,
  hasNearbyProvenanceSignal,
  scanFileForViolations,
};
