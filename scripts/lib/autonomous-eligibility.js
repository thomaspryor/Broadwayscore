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

// Leaf module (task #1154) — NOT verify-gate.js, which owns the same regex but
// sits downstream of this file (verify-gate -> autonomous-triage-core -> here).
// Requiring verify-gate from here would close a CommonJS cycle and hand one
// side a half-built exports object.
const { hasOwnerJudgmentMarker } = require('./owner-judgment-marker.js');

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
  // Hard exclusion, checked before every heuristic below (task #1154). The
  // card itself says only the owner can judge the outcome — that is a stronger
  // statement than anything category/tags/subject can infer, and all three of
  // those independently missed the Sarah check-in card, which the P0/P1
  // backlog sweep in dispatch-watchdog-core.js then auto-dispatched twice.
  // The marker used to be consulted ONLY by the verify gate, where it ARMS a
  // dispatch — so the one signal saying "a human must do this" was, in effect,
  // a permission slip.
  if (hasOwnerJudgmentMarker(task && task.description)) return true;
  const c = categoryOf(task);
  if (c === null || c === 'no-category') return HUMAN_ACTION_RE.test((task.subject || '').trim());
  if (EXCLUDED_CATEGORIES.has(c)) return true;
  return isHumanActionSubject(task.subject);
}

// Notion-card shape ({name, category, tags[]}) — used by the nightly triage.
// Returns { eligible, reason, kind } — reason/kind are always set when
// ineligible, both null when eligible.
//
// kind classifies WHY, for callers that need to act differently on the reason
// rather than just refuse to self-pick (task #1186): 'owner-judgment-marker'
// (4) and 'human-territory' (1, 2, and the 'owner-action' deny-tag — see its
// own docstring below, "cards that need the OWNER personally") both mean a
// HUMAN must do or judge the work. 'deny-tag' (the other DENY_TAGS entries —
// email/commercial/scoring/ios-app) means only that the UNATTENDED LOOP
// shouldn't self-pick this domain for blast-radius reasons; the work itself
// is still ordinary and machine-verifiable. enrich-card-acceptance.js was
// stamping the same "VERIFY: owner-judgment" marker for both kinds, and after
// #1154 made that marker a hard dispatch exclusion everywhere (not just the
// loop's self-pick), the conflation started blocking P1 auto-dispatch and
// manual `bsc-next --id` on technical deny-tagged cards that were never
// actually owner-judgment cards. Additive only — eligible/reason are
// unchanged, so existing callers that ignore `kind` see no behavior change.
function isCardEligible(card) {
  // Same hard exclusion as isExcludedCategory, on the full card's notes rather
  // than the truncated task mirror (task #1154). Live for the callers that
  // pass a whole card — autonomous-triage-core.js and autonomous-shadow-run.js.
  // enrich-card-acceptance.js passes only {name, category, tags}, so this is a
  // no-op there by design: that caller already returns 'already armed' on the
  // marker before it ever reaches this predicate.
  if (hasOwnerJudgmentMarker(card.notes)) {
    return { eligible: false, reason: 'card declares VERIFY: owner-judgment — only the owner can judge the outcome', kind: 'owner-judgment-marker' };
  }
  const category = (card.category || '').trim().toLowerCase();
  if (EXCLUDED_CATEGORIES.has(category)) {
    return { eligible: false, reason: `category "${card.category}" is human territory`, kind: 'human-territory' };
  }
  // Same fail-closed rule as isExcludedCategory: an empty/'no-category' card
  // has no category to vouch for a long verb-led title, so the verb filter
  // applies without the ≤5-word bound ("Ask Dennis T to mentor (Tony voter +
  // coproducer path)" was card-eligible through the bounded check).
  if ((category === '' || category === 'no-category') && HUMAN_ACTION_RE.test((card.name || '').trim())) {
    return { eligible: false, reason: `title is a human action and card has no category ("${(card.name || '').trim()}")`, kind: 'human-territory' };
  }
  if (isHumanActionSubject(card.name)) {
    return { eligible: false, reason: `title is a human action ("${(card.name || '').trim()}")`, kind: 'human-territory' };
  }
  const denied = (card.tags || []).find(t => DENY_TAGS.has(String(t).trim().toLowerCase()));
  if (denied) {
    return { eligible: false, reason: `deny-tag "${denied}"`, kind: String(denied).trim().toLowerCase() === 'owner-action' ? 'human-territory' : 'deny-tag' };
  }
  return { eligible: true, reason: null, kind: null };
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
  // The gate itself (2026-08-17). Every file above is refused because
  // CLAUDE.md rule 12.7 requires scoring-delta.js to run before the change
  // ships — but scoring-delta.js was itself self-servable, so an unattended
  // agent could weaken the check that guards all of them. Found by executing
  // isCodeDiffAllowed() against each path rather than reading the list; the
  // drift guard below only asserts watchlist ⊆ refused, so it could never have
  // caught the gate's own absence.
  'scripts/scoring-delta.js',
  'scripts/test-temporal-override-regression.js',
  // The single sanctioned reader for external score claims (CLAUDE.md rule 3).
  // Divergence here changes what the site TELLS people its scores are, without
  // touching how any score is computed — so none of the watchlists above cover
  // it, and shipped copy has silently diverged through this path before.
  'scripts/lib/canonical-critic-scores.ts',
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

// ── Tier 3: code cards (src/ + scripts/) — owner-approved 2026-07-25 ────────
//
// A PEER of Tiers 1/2, not a widening of Tier 1 (plan-review design P0: Tier 1
// stays "enumerate only what you can afford to break"; Tier 3 is the broad
// code scope with its own predicate, tunable/deletable in isolation). Same
// shape as Tier 1: prefix allows, exclusions ALWAYS win. Merge safety is
// UNCHANGED: src//scripts/ paths are never deterministic-green, so any diff
// touching one keeps the owner's morning approval tap (a tier-3 card whose
// diff lands ONLY on tests/docs stays auto-mergeable, exactly as before) —
// this widens what the loop may ATTEMPT, never what may land untapped.
const TIER3_ALLOW_PREFIXES = ['src/', 'scripts/'];

// Prefix exclusions specific to unattended code work. Everything here is a
// place where a wrong unattended edit is expensive, externally visible, or
// self-serving. scripts/bsc- is excluded wholesale (dispatcher/prune/conductor
// integrity); the bsc-next pair still reaches Tier 3 through the Tier-1
// enumeration below — that list is the human-reviewed carve-out mechanism.
const TIER3_EXCLUDED_PREFIXES = [
  '.github/workflows/',       // CI is never self-served
  'data/',                    // core data is Tier 2
  'supabase/',                // auth/DB
  'scripts/audit-',           // audit scripts gate CI
  'scripts/autonomous-',      // no self-modification
  'scripts/lib/autonomous-',  // no self-modification (incl. this file)
  'scripts/send-',            // email senders — broadcast safety (CLAUDE.md rule 17)
  'scripts/lib/email-',       // email infra
  'scripts/notion-',          // brain integrity
  'scripts/bsc-',             // dispatcher integrity (bsc-next pair via Tier-1 files)
  'scripts/lib/bsc-',         // dispatcher control-plane (model routing shim)
  'scripts/lib/cmux-',        // workspace launch/list — 2026-07-14 incident class
];

// Basename-level email/send deny (ship-check Codex finding): prefix rules
// missed scripts/lib/affiliate-email.js, brand-mention-email.js,
// send-lock.js. ANY scripts file whose basename mentions email/broadcast/
// send- is out — over-blocking is fine, default-deny is the philosophy.
const TIER3_EXCLUDED_BASENAME_RE = /(email|broadcast|^send-)/i;

// Dispatch bookkeeping the recheck pass (plan v2 Sprint 3) depends on having
// a stable shape — the loop must not be able to rewrite its own ledger.
const TIER3_EXCLUDED_EXTRA_FILES = new Set([
  'scripts/lib/dispatch-ledger.js',
  'scripts/lib/workspace-naming.js',
]);

// Dependency/deploy/config manifests: a wrong unattended change breaks every
// build or deploy at once, and checks describe today's tree, not the manifest
// a human intended.
const TIER3_EXCLUDED_FILES = new Set([
  'package.json',
  'package-lock.json',
  'next.config.js',
  'tsconfig.json',
  'vercel.json',
  'middleware.ts',
  'src/middleware.ts',
]);

// Extensions autonomous-checks.js's decideChecks() actually knows how to
// verify under scripts/: node --check for .js/.mjs/.cjs, tsc for .ts/.tsx.
// A scripts/ path with any other extension (.py, .sh, .json, ...) has no
// check the planner can ever produce for it — decideChecks would return an
// empty plan and ship-check's fail-closed no-checks result kills the card,
// but only AFTER a full implementer envelope (S $4 / M $14) has been spent
// (#454). Gating the extension here means such a card is never planned at
// all, so nothing is spent trying. src/ is unrestricted: any src/ change
// (any extension) trips `next lint` + `next build` in decideChecks, so it's
// checkable regardless of extension.
const SCRIPTS_CHECKABLE_EXT_RE = /\.(js|mjs|cjs|ts|tsx)$/;

function isCodePathAllowed(file) {
  const f = normalizePath(file);
  if (!f) return false;
  if (f.split('/').includes('..') || f.includes('\\')) return false;
  // Tier 3 ⊇ Tier 1: anything the tight Tier-1 gate allows is allowed here
  // too (tests/docs/memory prefixes + the enumerated leaf files — including
  // the bsc-next pair despite the scripts/bsc- prefix exclusion below).
  if (isPathAllowed(f)) return true;
  // Tier-3-specific rules. Exclusions always win over the prefix allows.
  if (EXCLUDED_FILES.has(f)) return false;        // scoring watchlists, scraper.js, calibration corpus
  if (TIER3_EXCLUDED_FILES.has(f)) return false;
  if (TIER3_EXCLUDED_EXTRA_FILES.has(f)) return false;
  if (TIER3_EXCLUDED_PREFIXES.some(p => f.startsWith(p))) return false;
  if (/-gate\.js$/.test(f)) return false;         // CI catastrophe-floor gates
  const base = f.slice(f.lastIndexOf('/') + 1);
  if (base.endsWith('.js') && TIER3_EXCLUDED_BASENAME_RE.test(base)) return false;
  // Manifests are refused by BASENAME anywhere, not just repo root — the
  // exact-match set left `scripts/package.json` allowed (ship-check QA probe).
  if (/^(package(-lock)?\.json|next\.config\.js|tsconfig\.json|vercel\.json|middleware\.ts)$/.test(base)) return false;
  if (f.startsWith('scripts/')) return SCRIPTS_CHECKABLE_EXT_RE.test(f);
  return TIER3_ALLOW_PREFIXES.some(p => f.startsWith(p));
}

function isCodeDiffAllowed(files) {
  const refused = (files || []).map(normalizePath).filter(f => !isCodePathAllowed(f));
  return { allowed: refused.length === 0, refused };
}

// One authoritative prose description per tier, consumed by BOTH the triage
// prompt (autonomous-triage-core.js) and the implementer prompt
// (autonomous-run-core.js). Plan-review design P0-3: both files hardcoded
// "cannot touch src/" prose that a Tier-3 run would contradict in the same
// sentence as its derived allow-list — scope prose must come from the same
// module as the predicates so they cannot drift.
function describeScope(tier) {
  if (tier === 3) {
    return `Tier 3 (code): may edit src/** and scripts/**, plus everything Tier 1 allows (tests/**, docs/**, memory/**, and the enumerated leaf files incl. scripts/bsc-next.js + its test, which stay editable despite the scripts/bsc- exclusion below). Under scripts/, only .js/.mjs/.cjs/.ts/.tsx files are in scope — other extensions (.py, .sh, .json, ...) have no check the loop can ever run, so they're refused before anything is spent, not failed after. EXCLUDED no matter what a card says — prefixes: ${TIER3_EXCLUDED_PREFIXES.join(', ')}; dependency/deploy manifests anywhere (package.json, package-lock.json, next.config.js, tsconfig.json, vercel.json, middleware.ts); files: ${[...TIER3_EXCLUDED_EXTRA_FILES].join(', ')}, tests/fixtures/triage-calibration.json; any scripts file whose name mentions email/broadcast/send-; the scoring watchlist files, scripts/lib/scraper.js, and any *-gate.js CI gate. It also cannot: make product or business decisions; send email; talk to humans; run expensive backfills.`;
  }
  const allowed = [...TIER1_ALLOW_PREFIXES.map(p => `${p}**`), ...TIER1_ALLOW_FILES];
  return `Tier 1: may only edit ${allowed.join(', ')}. It cannot: touch src/, data/, workflows, scraping/scoring/audit infra; make product or business decisions; send email; talk to humans; run expensive backfills.`;
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
  TIER3_ALLOW_PREFIXES,
  TIER3_EXCLUDED_PREFIXES,
  TIER3_EXCLUDED_FILES,
  SCRIPTS_CHECKABLE_EXT_RE,
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
  isCodePathAllowed,
  isCodeDiffAllowed,
  describeScope,
  isDeterministicGreenPath,
  isDiffDeterministicGreen,
  classifyDataCard,
  isScorecardDataPathAllowed,
  isReviewTextsPathAllowed,
  isDataRepoPathAllowed,
  isDataRepoDiffAllowed,
};
