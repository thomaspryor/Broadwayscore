/**
 * autonomous-eligibility.js — the single canonical eligibility predicate for
 * the autonomous nightly loop (and for bsc-next's default-pick filter).
 *
 * Two layers, both DEFAULT-DENY:
 *
 *  1. Card level — isCardEligible(card): may the loop even attempt this
 *     Notion card? Refuses human-territory categories (marketing,
 *     partnerships), human-action imperatives ("Email volunteers"), and
 *     deny-tagged domains (email, commercial, scoring, ios-app) where a
 *     wrong unattended change is expensive or externally visible.
 *
 *  2. Path level — isPathAllowed(file) / isDiffAllowed(files): may an
 *     implementation diff touch this file? Tier 1 allows tests/**, docs/**,
 *     memory/**, and an enumerated set of leaf tooling scripts. EXCLUSIONS
 *     ALWAYS WIN over allows: workflows, src/, data/, scraper infra, audit
 *     scripts, *-gate.js CI gates, the scoring-delta watchlists (kept in
 *     sync with scripts/scoring-delta.js by a colocated drift test), and the
 *     autonomous loop's own files (no self-modification).
 *
 * The loop treats card text as untrusted: no matter what a card claims, the
 * path gate runs on the RESULTING `git diff --name-only` before any push.
 *
 * Lifted from the working prototype in scripts/bsc-next.js (2026-07-12),
 * which now require()s this module — never maintain two copies.
 */

// ── Card level ──────────────────────────────────────────────────────────────

// Marketing/Partnerships cards are human territory — the loop (and bsc-next's
// default pick) must never select them. Explicit --id/--pick still can.
const EXCLUDED_CATEGORIES = new Set(['marketing', 'partnerships']);

// Second layer: Admin/Product cards that are still human ACTIONS (emailing
// people, reconnecting accounts, posting) — category can't see these.
const HUMAN_ACTION_RE = /^(send|reply|follow up|email|recruit|post|repost|meet|reschedule|reconnect|call|text|dm|share|announce|pitch|ask)\b/i;

// Domains where an unattended mistake is expensive or externally visible.
// Tag names are compared lowercased.
const DENY_TAGS = new Set(['email', 'commercial', 'scoring', 'ios-app']);

// Category is the trailing meta segment of the mirrored task description's
// first line ("[notion:<id>] P0 Now · In progress · Marketing") written by
// notion-tasks-sync (fmt:2).
function categoryOf(task) {
  const firstLine = (task.description || '').split('\n')[0];
  const parts = firstLine.split('·').map(s => s.trim());
  return parts.length >= 3 ? parts[parts.length - 1].toLowerCase() : null;
}

// Human-action verb applies only to short imperatives ("Email volunteers") —
// long subjects starting with the same word are product cards ("Email gate
// conversion critically low at 0.9%").
function isHumanActionSubject(subject) {
  const s = (subject || '').trim();
  return HUMAN_ACTION_RE.test(s) && s.split(/\s+/).length <= 5;
}

// Task-mirror shape ({subject, description}) — used by bsc-next.
function isExcludedCategory(task) {
  const c = categoryOf(task);
  if (c !== null && EXCLUDED_CATEGORIES.has(c)) return true;
  return isHumanActionSubject(task.subject);
}

// Notion-card shape ({name, category, tags[]}) — used by the nightly triage.
// Returns { eligible, reason } — reason is always set when ineligible.
function isCardEligible(card) {
  const category = (card.category || '').trim().toLowerCase();
  if (EXCLUDED_CATEGORIES.has(category)) {
    return { eligible: false, reason: `category "${card.category}" is human territory` };
  }
  if (isHumanActionSubject(card.name)) {
    return { eligible: false, reason: `title is a human action ("${(card.name || '').trim()}")` };
  }
  const denied = (card.tags || []).find(t => DENY_TAGS.has(String(t).trim().toLowerCase()));
  if (denied) {
    return { eligible: false, reason: `deny-tag "${denied}"` };
  }
  return { eligible: true, reason: null };
}

// ── Path level (Tier 1) ─────────────────────────────────────────────────────

// Prefix allows. A file is allowed iff it matches an allow AND no exclusion.
const TIER1_ALLOW_PREFIXES = ['tests/', 'docs/', 'memory/'];

// Enumerated leaf tooling files the loop may edit. Deliberately tiny; grows
// only by a human-reviewed commit to this file. Never add: anything on an
// exclusion list below (exclusions win anyway), shared pipeline libs, or
// files whose breakage is silent.
const TIER1_ALLOW_FILES = new Set([
  'scripts/bsc-next.js',
  'scripts/bsc-next.test.mjs',
]);

// Exact-path exclusions. The scoring-delta watchlists (INCLUSION_FILES +
// SCORE_VALUE_FILES from scripts/scoring-delta.js) are mirrored here — a
// colocated drift test fails if scoring-delta.js gains an entry we miss.
const EXCLUDED_FILES = new Set([
  'scripts/lib/scraper.js',
  // scoring-delta INCLUSION_FILES
  'scripts/lib/review-guards.js',
  'scripts/rebuild-all-reviews.js',
  'scripts/lib/date-guard.js',
  'scripts/lib/wrong-production-autoclear.js',
  'src/lib/scoring.ts',
  'src/lib/engine.ts',
  'src/lib/data-core.ts',
  // scoring-delta SCORE_VALUE_FILES
  'scripts/lib/rebuild-helpers.js',
  'scripts/lib/score-extractors.js',
  'scripts/lib/score-parsers.js',
  'scripts/lib/review-normalization.js',
  'scripts/lib/score-routing.js',
]);

// Prefix/pattern exclusions.
const EXCLUDED_PREFIXES = [
  '.github/workflows/', // CI is never self-served
  'src/',               // site code is Tier 3 (gated, separate eligibility)
  'data/',              // core data is Tier 2 (separate eligibility)
  'scripts/audit-',     // audit scripts gate CI — hands off
  'scripts/autonomous-',      // no self-modification
  'scripts/lib/autonomous-',  // no self-modification (incl. this file)
];

function normalizePath(file) {
  return String(file || '').replace(/^\.\//, '').replace(/^\/+/, '');
}

function isPathAllowed(file) {
  const f = normalizePath(file);
  if (!f) return false;
  // Exclusions always win.
  if (EXCLUDED_FILES.has(f)) return false;
  if (EXCLUDED_PREFIXES.some(p => f.startsWith(p))) return false;
  if (/-gate\.js$/.test(f)) return false; // CI catastrophe-floor gates
  // Allows.
  if (TIER1_ALLOW_FILES.has(f)) return true;
  return TIER1_ALLOW_PREFIXES.some(p => f.startsWith(p));
}

// Gate a whole diff (git diff --name-only output). Refused list names every
// offending file so the run can mark the card failed with evidence.
function isDiffAllowed(files) {
  const refused = (files || []).map(normalizePath).filter(f => !isPathAllowed(f));
  return { allowed: refused.length === 0, refused };
}

module.exports = {
  EXCLUDED_CATEGORIES,
  HUMAN_ACTION_RE,
  DENY_TAGS,
  TIER1_ALLOW_PREFIXES,
  TIER1_ALLOW_FILES,
  EXCLUDED_FILES,
  EXCLUDED_PREFIXES,
  categoryOf,
  isHumanActionSubject,
  isExcludedCategory,
  isCardEligible,
  isPathAllowed,
  isDiffAllowed,
};
