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
// (?=\s|$) not \b: an imperative verb takes an object after whitespace, while
// a hyphen right after the verb is a compound technical noun ("Post-Tonys
// rollout", "Reply-to header parsing bug") that \b wrongly matched — task #108
// sat in the human-territory list because of this.
const HUMAN_ACTION_RE = /^(send|reply|follow up|email|recruit|post|repost|meet|reschedule|reconnect|call|text|dm|share|announce|pitch|ask)(?=\s|$)/i;

// Domains where an unattended mistake is expensive or externally visible.
// Tag names are compared lowercased.
// owner-action (2026-07-19): cards that need the OWNER personally (outreach,
// credentials, posting, meetings) — deterministic replacement for the
// human-action title heuristic on tagged cards; the loop must never spend
// triage LLM calls on them.
const DENY_TAGS = new Set(['email', 'commercial', 'scoring', 'ios-app', 'owner-action']);

// Category is the trailing meta segment of the mirrored task description's
// first line ("[notion:<id>] P0 Now · In progress · Marketing") written by
// notion-tasks-sync (fmt:2). Only a genuine bridge line ([notion: prefix) may
// vouch a category: without that check, any native description whose first
// line happens to contain 2+ '·' characters would fabricate a category and
// bypass the fail-closed null branch below.
function categoryOf(task) {
  const firstLine = (task.description || '').split('\n')[0];
  if (!/^\[notion:/i.test(firstLine)) return null;
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
// Unknown category = fail CLOSED: apply the human-action verb filter WITHOUT
// the ≤5-word bound, since no category vouches for a long verb-led subject
// being a product card ("Email gate conversion critically low" stays pickable
// only when a bridge line says Product). Unknown covers BOTH null (no fmt-2
// meta line: native TaskCreate, or pre-fmt:2 legacy) AND the literal
// 'no-category' that notion-tasks-sync writes when the Notion card's category
// is empty ("Ask Dennis T to mentor…" was default-pickable through that gap).
// Explicit --id still reaches anything this excludes (--pick indexes the
// already-filtered list, so it can't).
function isExcludedCategory(task) {
  const c = categoryOf(task);
  if (c === null || c === 'no-category') return HUMAN_ACTION_RE.test((task.subject || '').trim());
  if (EXCLUDED_CATEGORIES.has(c)) return true;
  return isHumanActionSubject(task.subject);
}

// Notion-card shape ({name, category, tags[]}) — used by the nightly triage.
// Returns { eligible, reason } — reason is always set when ineligible.
function isCardEligible(card) {
  const category = (card.category || '').trim().toLowerCase();
  if (EXCLUDED_CATEGORIES.has(category)) {
    return { eligible: false, reason: `category "${card.category}" is human territory` };
  }
  // Same fail-closed rule as isExcludedCategory: an empty/'no-category' card
  // has no category to vouch for a long verb-led title, so the verb filter
  // applies without the ≤5-word bound ("Ask Dennis T to mentor (Tony voter +
  // coproducer path)" was card-eligible through the bounded check).
  if ((category === '' || category === 'no-category') && HUMAN_ACTION_RE.test((card.name || '').trim())) {
    return { eligible: false, reason: `title is a human action and card has no category ("${(card.name || '').trim()}")` };
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
  // Growth round 1 (2026-07-14, owner-approved via growth card): unlocks real
  // backlog cards #72 (garbage slugs) + #69 (lint violator). Implementers must
  // add colocated tests per repo convention — neither file has one yet.
  'scripts/lib/outlet-canonicalize.js',
  'scripts/auto-triage-cross-production.js',
  'scripts/bsc-next.js',
  'scripts/bsc-next.test.mjs',
]);

// Exact-path exclusions. The scoring-delta watchlists (INCLUSION_FILES +
// SCORE_VALUE_FILES from scripts/scoring-delta.js) are mirrored here — a
// colocated drift test fails if scoring-delta.js gains an entry we miss.
const EXCLUDED_FILES = new Set([
  'scripts/lib/scraper.js',
  // The loop must never edit the corpus that gates its own triage quality.
  'tests/fixtures/triage-calibration.json',
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
  // Traversal segments defeat prefix matching ("tests/../src/x" starts with
  // an allowed prefix). git diff output never contains them, but this is the
  // canonical predicate and future callers may feed constructed paths.
  if (f.split('/').includes('..') || f.includes('\\')) return false;
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

// ── Deterministic-green class (Sprint 3, owner spec refinement 2026-07-14) ──
//
// NOT a model judgment call ("confident prose ≠ safety" — the owner's exact
// objection to auto-approving on an LLM's say-so). This is a pure, mechanical
// predicate over the file list: a diff is deterministic-green iff EVERY file
// is a test, doc, or fixture — paths that cannot change site/data behavior no
// matter what they contain. autonomous-merge.yml merges these WITHOUT a human
// tap; every other diff (anything touching a "real" file) keeps the human
// tap even if every check passed, because passing checks describe today's
// tests, not tomorrow's behavior change.
//
// Deliberately narrower than TIER1_ALLOW_PREFIXES: memory/** (runbooks, notes)
// is Tier-1-allowed but is prose a human should skim, not inert test code —
// it stays in the judged/tap-required class.
const DETERMINISTIC_GREEN_PREFIXES = ['tests/', 'docs/'];

function isDeterministicGreenPath(file) {
  const f = normalizePath(file);
  if (!f) return false;
  if (/\.test\.mjs$/.test(f)) return true;
  return DETERMINISTIC_GREEN_PREFIXES.some(p => f.startsWith(p));
}

// Empty diff is never green (nothing to merge); every file must qualify.
function isDiffDeterministicGreen(files) {
  const list = (files || []).map(normalizePath).filter(Boolean);
  if (!list.length) return false;
  return list.every(isDeterministicGreenPath);
}

// ── Tier 2: data-pipeline card classes (Sprint 4) ───────────────────────────
//
// Tier 1's path gate (above) is scoped to THIS repo's worktree. Tier-2 cards
// instead write to one of two private data repos (~/broadway-scorecard-data
// and this repo's data/review-texts/ — its own nested git clone), which have
// no Tier-1 path overlap at all: EXCLUDED_PREFIXES already blocks 'data/'
// wholesale, and the private repos aren't reachable through this repo's
// worktree mechanics in the first place. Classification and the diff gate
// therefore need their own default-deny predicates, not a Tier-1 extension.
//
// classifyDataCard() is DETERMINISTIC — no LLM — mirroring the same idiom as
// isHumanActionSubject() above: a small enumerated set of narrow title/tag
// patterns, never free-text sentiment on the Problem/Evidence prose (a card's
// notes are untrusted content, same as everywhere else in this file). Unknown
// shape → null (default-deny) — the executor never guesses a class.
const DATA_CARD_CLASSES = new Set(['missing-show', 're-gather', 'byline-recovery', 'cluster-cleanup']);

// tag → class is the strongest signal because it's a controlled vocabulary
// value, not prose: posthog-friction-analyzer.js already stamps 'missing-show'
// on every card it files (verified against real cards: #28/#58/#59/#83/#84/#85).
// Title-prefix patterns are the fallback for the other three classes, which
// have no equivalent standardized tag today — same fallback idiom as
// isHumanActionSubject's title-verb match.
const DATA_CLASS_TAGS = { 'missing-show': 'missing-show' };
const DATA_CLASS_TITLE_PATTERNS = [
  // Order matters: more specific patterns first. "re-gather" cards are
  // sometimes ALSO byline/cluster-shaped in free text, so the explicit verb
  // wins over the noisier byline/cluster keyword matches below.
  { cls: 'missing-show', re: /^Missing show:/i },
  { cls: 're-gather', re: /\bre-?gather\b/i },
  { cls: 'byline-recovery', re: /^Byline recovery:/i },
  { cls: 'cluster-cleanup', re: /\b(byline-explosion|duplicate detector|dedup(?:e|lication)?)\b/i },
];

function classifyDataCard(card) {
  const tag = (card.tags || []).map(t => String(t).trim().toLowerCase());
  for (const [cls, wantTag] of Object.entries(DATA_CLASS_TAGS)) {
    if (tag.includes(wantTag)) return cls;
  }
  const name = String(card.name || '').trim();
  for (const { cls, re } of DATA_CLASS_TITLE_PATTERNS) {
    if (re.test(name)) return cls;
  }
  return null;
}

// Which private repo(s) a class's implementation diff is expected to land in.
// 'scorecard-data' = ~/broadway-scorecard-data (shows.json et al).
// 'review-texts'   = this repo's data/review-texts/ nested clone.
const DATA_CLASS_REPO = {
  'missing-show': 'scorecard-data',
  're-gather': 'review-texts',
  'byline-recovery': 'review-texts',
  'cluster-cleanup': 'review-texts',
};

// Path allow-list PER PRIVATE REPO — same default-deny shape as isPathAllowed,
// scoped to what each class may legitimately touch. reviews.json is DERIVED
// (rebuild-all-reviews.js) and explicitly excluded: an implementer must never
// hand-edit or locally rebuild it (memory/feedback_local_rebuild_stale_clone_hazard.md)
// — CI's rebuild-fast dispatch is the only path that regenerates it.
function isScorecardDataPathAllowed(file) {
  const f = normalizePath(file);
  return f === 'shows.json';
}

// review-texts: only per-show JSON files (live or _pending), never the
// top-level junk that lives in that repo's root (failed-fetches.json,
// .playwright-mcp screenshots, etc. — verified against the real repo tree).
function isReviewTextsPathAllowed(file) {
  const f = normalizePath(file);
  if (!f || f.split('/').includes('..') || f.includes('\\')) return false;
  if (!f.endsWith('.json')) return false;
  const parts = f.split('/');
  if (parts.length === 2) return true; // <showId>/<outlet>--<critic>.json
  if (parts.length === 3 && parts[0] === '_pending') return true; // _pending/<showId>/<file>.json
  return false;
}

function isDataRepoPathAllowed(repoKey, file) {
  if (repoKey === 'scorecard-data') return isScorecardDataPathAllowed(file);
  if (repoKey === 'review-texts') return isReviewTextsPathAllowed(file);
  return false;
}

function isDataRepoDiffAllowed(repoKey, files) {
  const refused = (files || []).map(normalizePath).filter(f => !isDataRepoPathAllowed(repoKey, f));
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
  DETERMINISTIC_GREEN_PREFIXES,
  DATA_CARD_CLASSES,
  DATA_CLASS_REPO,
  categoryOf,
  isHumanActionSubject,
  isExcludedCategory,
  isCardEligible,
  isPathAllowed,
  isDiffAllowed,
  isDeterministicGreenPath,
  isDiffDeterministicGreen,
  classifyDataCard,
  isScorecardDataPathAllowed,
  isReviewTextsPathAllowed,
  isDataRepoPathAllowed,
  isDataRepoDiffAllowed,
};
