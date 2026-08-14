#!/usr/bin/env node
// scripts/lib/review-gate.mjs — push-boundary review enforcement.
//
// Problem this closes (Notion 39c637c5, incident 2026-07-12 gate-ab monitor):
// ALL prior review-chain enforcement was prose-anchored — the finish-line-gate
// Stop hook only fires when the assistant's final message CLAIMS completion
// ("done", "shipped", …). A session that ships substantial code across turns
// that all end in questions never emits a claim, so the gate never fires and
// unreviewed code lands on main. This lib anchors enforcement to the action
// itself: the push. Prose-independent by construction.
//
// Used by ~/.claude/hooks/pre-push-review-gate.sh (PreToolUse on Bash) and by
// the review skills (/ship-check, /code-review, /second-opinion), which record
// a verdict after they run:
//   node scripts/lib/review-gate.mjs --query=record --reviewer=ship-check --result=pass
//
// Verdict ledger: <ledger-root>/.claude/review-verdicts.jsonl (gitignored),
// one JSON object per line:
//   { ts, reviewer, result, branch, head, diffHash, gatedLines, sessionId? }
// diffHash is a sha256-16 of the PATCH TEXT of the gated diff vs origin/main —
// content-addressed, so it survives merges/rebases that don't change the diff.
//
// Queries (CLI, JSON to stdout — same conventions as transcript-scan.mjs):
//   --query=diff-hash     [--repo=… --ref=HEAD]        current gated diff stats + hash
//   --query=record        --reviewer=… --result=pass|fail [--session-id=…]
//   --query=push-allowed  [--repo=… --ref=HEAD --ledger-root=…]
//   --query=changed-files [--repo=… --ref=HEAD --pattern=<regex>] own-merge-scoped
//                        changed file paths matching --pattern (default: all).
//                        Shared with pre-push-visual-gate.sh (task #879) —
//                        same own-merge scoping as diff-hash/push-allowed but
//                        for callers with a non-GATED_PATH_RE file filter.
//
// push-allowed decision:
//   1. gated lines (added+deleted in src/, scripts/, .github/workflows/ code
//      files) vs origin/main…ref ≤ GATE_LINE_BUDGET → not gated, allowed.
//   2. a pass-verdict whose diffHash matches the current diff → allowed.
//   3. a pass-verdict whose head is an ancestor of ref with ≤ DRIFT_BUDGET_LINES
//      of gated changes since (review fixups) → allowed.
//   4. otherwise blocked — run a review skill (or NO-SHIP-CHECK: bypass, which
//      the hook detects in the transcript, not here).
// /second-opinion verdicts only count for diffs ≤ SECOND_OPINION_MAX_LINES
// (mirrors finish-line-gate: a light review must not rubber-stamp a big diff).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// CJS libs — ci-red-claims.js/duplicate-dispatch-guard.js predate this file's
// ESM conversion and are shared with scripts/claim-ci-red.js, so require()
// rather than porting them to ESM.
const require = createRequire(import.meta.url);
// The CI-red-claim libs (task #584) are optional enhancements: a checkout
// that carries this file without its newer siblings (pre-#584 worktree
// branch, the hook test suite's scratch repo, any partial copy) must degrade
// to "CI-red claim checks skipped", NOT crash. An uncaught require error
// here killed the whole module, and pre-push-review-gate.sh read the empty
// output as "couldn't evaluate → allow" — silently disabling the entire push
// gate in that checkout (found 2026-07-31, Notion card 3ae637c5).
let readClaims = null, CLAIM_TTL_MS = 0, evaluateCiRedClaim = null;
try {
  ({ readClaims, CLAIM_TTL_MS } = require('./ci-red-claims.js'));
} catch (e) {
  process.stderr.write(`review-gate: ci-red-claims.js unavailable (${e.code || e.message}) — CI-red claim checks degraded to no-op\n`);
}
try {
  ({ evaluateCiRedClaim } = require('./duplicate-dispatch-guard.js'));
} catch (e) {
  process.stderr.write(`review-gate: duplicate-dispatch-guard.js unavailable (${e.code || e.message}) — CI-red claim checks degraded to no-op\n`);
}
// Shallow-checkout guard (task #1497, same false-negative class as #1489):
// degrade to no-op rather than crash if landing-verify.js is missing from a
// partial/old checkout, same reasoning as the two requires above.
let libEnsureFullHistory = null;
try {
  ({ ensureFullHistory: libEnsureFullHistory } = require('./landing-verify.js'));
} catch (e) {
  process.stderr.write(`review-gate: landing-verify.js unavailable (${e.code || e.message}) — shallow-checkout ancestry guard degraded to no-op\n`);
}

// ── constants (exported for tests) ──────────────────────────────────────────

// Paths whose changes count toward the gate. Deliberately code-only: CSS/UI
// aesthetics are the visual-qa gate's job; data/, docs, memory files are not
// review surface. Matches finish-line-gate's CODE_DIRS/CODE_EXTS.
export const GATED_PATH_RE = /^(?:src|scripts)\/.*\.(?:js|jsx|ts|tsx|mjs|cjs|sh|py)$|^\.github\/workflows\/[^/]+\.ya?ml$/;

// A push changing ≤ this many gated lines (added+deleted) is not gated.
// Card acceptance: a >30-line scripts/ diff with no verdict must block.
export const GATE_LINE_BUDGET = 30;

// After a verdict, this many further gated lines are assumed to be that
// review's fixups (ship-check findings get FIXED, which changes the diff and
// breaks exact hash match). Beyond it, the fixups themselves deserve review.
export const DRIFT_BUDGET_LINES = 150;

// /second-opinion is a light review — only accepted for small diffs.
export const SECOND_OPINION_MAX_LINES = 100;

export const STRONG_REVIEWERS = new Set(['ship-check', 'code-review']);
export const LIGHT_REVIEWERS = new Set(['second-opinion']);

export const LEDGER_REL_PATH = '.claude/review-verdicts.jsonl';

// ── git helpers ──────────────────────────────────────────────────────────────

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

// The main-worktree root, consistent across all linked worktrees — verdicts
// recorded from a worktree session must be visible when pushing from the main
// checkout after merging (same dance as pre-push-visual-gate.sh).
export function canonicalRoot(repoRoot) {
  try {
    const common = git(repoRoot, ['rev-parse', '--git-common-dir']).trim();
    if (!common) return repoRoot;
    const abs = common.startsWith('/') ? common : join(repoRoot, common);
    return dirname(abs);
  } catch {
    return repoRoot;
  }
}

// origin/main normally; falls back to main for scratch repos without a remote.
export function resolveBase(repoRoot) {
  for (const ref of ['origin/main', 'main']) {
    try {
      git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return ref;
    } catch { /* try next */ }
  }
  return null;
}

// How many commits to walk back from `ref` (across trailing non-merge
// commits) looking for the merge that scopes this push. Bounded so a repo
// with an unusually long non-merge tail (or no merge at all) fails open
// quickly instead of walking deep history on every push.
const OWN_MERGE_WALK_LIMIT = 50;

// Find the merge commit that scopes THIS push's own contribution, walking
// back from `ref` across any trailing non-merge commits, and return its
// first parent (the tip of the target branch immediately before that
// merge); otherwise null.
//
// task #828: with ~20 parallel worktree sessions sharing one local `main`
// checkout (only one worktree can have `main` checked out at a time), the
// documented merge pattern `checkout main && pull && merge <branch> && push`
// serializes on that shared checkout — a session's own `git merge` can land
// on top of OTHER sessions' merges that are already on local main but not
// yet pushed to origin, and non-merge commits (e.g. the session-stop
// "chore: sync cloud-memory" auto-commit) routinely land on top of that. A
// plain `origin/main...HEAD` diff then includes every one of those unrelated,
// already-reviewed merges, not just this session's own — reported as
// "unreviewed" lines in files the session never touched. `M^1..ref` (where M
// is the nearest merge ancestor) isolates exactly what THIS merge — plus any
// of the session's own trailing commits on top of it — introduced (git's own
// definition of "what did this merge bring in"), independent of how much
// unrelated history already sat on `M^1`. Bonus: when the merge was clean
// (no conflicting edits to the same lines), this range's diff text is
// byte-identical to the pre-merge branch diff that /ship-check already
// reviewed, so the exact-hash-match path below recognizes it directly
// instead of falling through to the ledger's fuzzier "nearest verdict" scan
// (which was misattributing a DIFFERENT session's verdict as "stale").
//
// Pull-merge guard: `git pull origin main` (used to resolve a rejected push)
// is ALSO a 2-parent merge — parent1 is the session's own prior HEAD
// (carrying its real unpushed work), parent2 is origin's freshly-fetched
// tip. Scoping to parent1..ref there would diff AWAY the session's own
// commits (already common with parent1) and keep only origin's incoming
// delta — exactly backwards. Detected by: parent2 is (or is an ancestor of)
// `base` — that's origin/main content, not genuine new work — so such merges
// are skipped rather than used as the scope anchor.
function ownMergeParent(repoRoot, ref, base) {
  if (ref === 'WORKTREE') return null;
  let cursor = ref;
  for (let i = 0; i < OWN_MERGE_WALK_LIMIT; i++) {
    if (cursor === base) return null; // walked all the way back to origin/main — nothing to scope
    let out;
    try {
      out = git(repoRoot, ['rev-list', '--parents', '-n', '1', cursor]).trim();
    } catch {
      return null;
    }
    const tokens = out.split(/\s+/).filter(Boolean);
    if (tokens.length === 2) {
      // Ordinary single-parent commit (e.g. a trailing auto-commit) — keep
      // walking back to find the merge that actually scopes this push.
      cursor = tokens[1];
      continue;
    }
    if (tokens.length !== 3) return null; // root commit or octopus merge — bail, fail open
    const [, parent1, parent2] = tokens;
    if (parent2 === base || isAncestor(repoRoot, parent2, base)) {
      // Pull/catch-up merge (parent2 is origin/main content) — not a scope
      // anchor. Nothing further back can be "my own" beyond this either,
      // since everything before a pull is already reflected in parent1,
      // which we're about to inspect next — so stop here rather than walk
      // past it (would risk re-descending into unrelated history).
      return null;
    }
    return parent1;
  }
  return null;
}

// Diff args for base vs ref. ref === 'WORKTREE' means "the working tree as it
// stands" — used when the gated command is a compound `git commit … && git
// push` / `git merge … && git push`, where the pushed state doesn't exist as a
// commit yet at hook time (ship-check round 3 P0-1: the mandated
// merge-then-push flow was evaluated pre-merge and always passed).
//
// `twoDot` ranges are used only for drift calc (verdict.head..ref), which
// must stay anchored to the verdict's own recorded head — own-merge scoping
// does not apply there.
export function diffRangeArgs(repoRoot, base, ref, twoDot) {
  if (ref === 'WORKTREE') {
    // Working tree vs merge-base(base, HEAD) — the three-dot equivalent.
    let mb = base;
    try { mb = git(repoRoot, ['merge-base', base, 'HEAD']).trim() || base; } catch { /* keep base */ }
    return [twoDot ? base : mb];
  }
  const effectiveBase = twoDot ? base : (ownMergeParent(repoRoot, ref, base) || base);
  return [twoDot ? `${effectiveBase}..${ref}` : `${effectiveBase}...${ref}`];
}

// Force prefixes/no-ext-diff: user git config (diff.noprefix, external diff)
// must not change what we hash or parse (ship-check round 3 P1-5: with
// diff.noprefix=true every hash collapsed to the 'empty' sentinel, so one
// recorded verdict would rubber-stamp all future pushes).
const DIFF_STABLE_FLAGS = ['--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];

// Gated files + added/deleted line totals for base...ref (three-dot: what this
// push adds relative to the merge-base with main). `twoDot` is used for drift
// (verdict.head..ref where verdict.head is a known ancestor).
// The gated pathspec. Kept as a named export so the drift scan can narrow it to
// exactly the pushed files without re-stating the default in two places.
export const GATED_DIFF_DIRS = ['src', 'scripts', '.github/workflows'];

// `noRenames`/`pathspec` are used ONLY by queryPushAllowed's drift scan (see
// driftContentKeys) — every other caller keeps the historical invocation
// byte-for-byte, so the primary gate decision and computeDiffHash are unchanged.
export function gatedDiffStats(repoRoot, base, ref, { twoDot = false, noRenames = false, pathspec = null } = {}) {
  const range = diffRangeArgs(repoRoot, base, ref, twoDot);
  const paths = pathspec && pathspec.length ? pathspec : GATED_DIFF_DIRS;
  let out;
  try {
    out = git(repoRoot, ['diff', '--numstat', ...(noRenames ? ['--no-renames'] : []), ...range, '--', ...paths]);
  } catch {
    return { files: [], totalLines: 0, error: `git diff failed for ${range.join(' ')}` };
  }
  const files = [];
  let totalLines = 0;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    // numstat path may be quoted or contain rename braces; renames show as
    // "old => new" or "{a => b}/rest" — take the post-rename path.
    let path = m[3].replace(/^"|"$/g, '');
    if (path.includes(' => ')) {
      path = path.replace(/\{([^{}]*) => ([^{}]*)\}/g, '$2').replace(/^.* => /, '');
      path = path.replace(/\/\//g, '/');
    }
    if (!GATED_PATH_RE.test(path)) continue;
    // Binary files report "-"; count as 0 lines but keep the file listed.
    const added = m[1] === '-' ? 0 : parseInt(m[1], 10);
    const deleted = m[2] === '-' ? 0 : parseInt(m[2], 10);
    files.push({ path, added, deleted });
    totalLines += added + deleted;
  }
  return { files, totalLines };
}

// Changed file paths for base...ref, own-merge scoped the same way as
// gatedDiffStats (see ownMergeParent above), but filtered by an arbitrary
// caller-supplied regex instead of the hardcoded GATED_PATH_RE. Shared by
// pre-push-visual-gate.sh (task #879), whose UI-file gate has a different
// path definition (tsx/jsx/css/tailwind config) than this file's code-review
// gate — without this, that hook re-implemented the unscoped
// `origin/main...$DIFF_REF` diff and inherited the same #828 false-positive:
// on a shared local main with ~20 parallel worktree sessions, another
// session's already-merged-but-unpushed UI commit would show up as "UI files
// changed" for a push that touched none.
//
// Known trade-off (shared with queryPushAllowed's own-scope budget check
// above): if session A merges an unreviewed UI file onto local main and its
// own push hasn't landed yet, then session B merges backend-only work on top
// and pushes, B's push carries A's UI file to origin but this query reports
// zero UI files — the visual-qa gate is skipped for content B never touched.
// Accepted here for the same reason #828 accepted it for the code-review
// gate: each session is expected to run its own /visual-qa (or ship-check)
// before merging into shared main, so by the time a commit reaches this
// scoping it should already have been reviewed by its own author session.
export function scopedChangedFiles(repoRoot, base, ref, pathRegex) {
  const range = diffRangeArgs(repoRoot, base, ref, false);
  let out;
  try {
    out = git(repoRoot, ['diff', '--name-only', ...range]);
  } catch {
    return { files: [], error: `git diff failed for ${range.join(' ')}` };
  }
  return { files: out.split('\n').filter(Boolean).filter(p => pathRegex.test(p)) };
}

// Patch text for the gated files only: split on "diff --git" headers and
// keep hunks whose post-image path matches GATED_PATH_RE. Paths with
// spaces/unicode are C-quoted (`diff --git "a/x y" "b/x y"`). Shared by
// computeDiffHash (below) and gatedDiffPatchText (CI-red claim matching).
function gatedPatchChunks(repoRoot, base, ref) {
  let patch;
  try {
    patch = git(repoRoot, ['diff', ...DIFF_STABLE_FLAGS, ...diffRangeArgs(repoRoot, base, ref, false), '--', 'src', 'scripts', '.github/workflows']);
  } catch {
    return [];
  }
  return patch.split(/^(?=diff --git )/m).filter(c => {
    const m = c.match(/^diff --git "?a\/.* "?b\/(.+?)"?$/m);
    return m && GATED_PATH_RE.test(m[1]);
  });
}

// Content-addressed hash of the gated diff. Uses patch text (blob-hash index
// lines depend only on content), so a merge/rebase that leaves the diff
// identical keeps the hash — a verdict recorded on a worktree branch stays
// valid when main is pushed after merging that branch.
export function computeDiffHash(repoRoot, base, ref) {
  const chunks = gatedPatchChunks(repoRoot, base, ref);
  if (chunks.length === 0) return 'empty';
  return createHash('sha256').update(chunks.join('')).digest('hex').slice(0, 16);
}

// Full patch text of the gated diff (not hashed) — used by
// queryCiRedClaimConflict to substring-match a claimed symbol/runId against
// what this push actually changes.
export function gatedDiffPatchText(repoRoot, base, ref) {
  return gatedPatchChunks(repoRoot, base, ref).join('');
}

// Shallow-checkout guard (task #1497, same false-negative class as #1489):
// `git merge-base --is-ancestor` and `git rev-list` BOTH silently omit/deny
// genuine ancestors past a shallow boundary. This module has two entry
// points into the git graph — isAncestor()'s merge-base spawn and
// ancestorSet()'s rev-list — reached from several different exported
// functions (queryPushAllowed, recordVerdict, the diff-hash/changed-files
// CLI queries via ownMergeParent) in an order that isn't fixed. Rather than
// guard every current and future caller individually, guard the two
// mechanisms themselves, memoized per repoRoot so the (network-touching)
// unshallow attempt runs at most once per process regardless of how many
// ancestry checks follow.
const historyEnsured = new Map(); // repoRoot -> boolean (still shallow?)
function ensureHistoryOnce(repoRoot) {
  if (!libEnsureFullHistory) return; // landing-verify.js unavailable — degraded no-op, see require() above
  if (historyEnsured.has(repoRoot)) return;
  const { shallow } = libEnsureFullHistory({ cwd: repoRoot, remote: 'origin', log: (m) => process.stderr.write(`review-gate: ${m}\n`) });
  historyEnsured.set(repoRoot, shallow);
}

function isAncestor(repoRoot, maybeAncestor, ref) {
  ensureHistoryOnce(repoRoot);
  try {
    execFileSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', maybeAncestor, ref], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

// One-shot ancestor set for `ref`, replacing a per-entry `merge-base
// --is-ancestor` spawn in the ledger scan below.
//
// WHY (measured on the real repo, 2026-08-12, task #1304): the ledger had 1148
// strong pass verdicts / 1079 distinct heads, and only 35 of those heads still
// EXIST as objects here — the rest were recorded from worktrees whose branches
// have since been deleted and pruned. `merge-base --is-ancestor` costs ~33ms on
// a live object but ~589ms on a missing one (git searches every packfile before
// giving up), so the scan cost ~10.6 MINUTES, essentially all of it spent
// failing to find objects that are gone. The drift diffs everyone would suspect
// were 44ms each, ~1.5s total. `git rev-list <ref>` builds the entire ancestor
// set in 38ms (1658 commits).
//
// Semantics are IDENTICAL, not merely close: `merge-base --is-ancestor X ref`
// is true exactly when X is reachable from ref (ref itself included), which is
// exactly `git rev-list ref` membership. A commit that exists but is unreachable
// is absent from the set and false either way; a missing object is absent from
// the set and made the spawn throw, also false. So no verdict that used to
// match stops matching — this is a pure cost fix with no behaviour change and,
// in particular, no new way to block.
//
// Returns null when rev-list fails, so the caller falls back to the spawn rather
// than silently treating every verdict as non-ancestor (which WOULD change
// behaviour, in the blocking direction).
function ancestorSet(repoRoot, ref) {
  ensureHistoryOnce(repoRoot);
  try {
    // Resolve to a single commit FIRST. `merge-base --is-ancestor X <ref>`
    // requires a commit-ish, but `git rev-list` also accepts revision-SET
    // syntax (`--all`, `A..B`, `^X`), so handing it an unvalidated caller ref
    // could silently build a set that answers a different question. Pinning to
    // one SHA keeps the two forms answering the same question for every input
    // (adversarial review, 2026-08-12: queryPushAllowed's `ref` is a public
    // parameter, not only the validated merge sources).
    const sha = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
    if (!sha) return null;
    const out = git(repoRoot, ['rev-list', sha]);
    return new Set(out.split('\n').filter(Boolean));
  } catch {
    return null;
  }
}

// ── ledger ───────────────────────────────────────────────────────────────────

export function readLedger(ledgerRoot) {
  const p = join(ledgerRoot, LEDGER_REL_PATH);
  if (!existsSync(p)) return [];
  const entries = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* tolerate partial line */ }
  }
  return entries;
}

export function recordVerdict({ repoRoot, ledgerRoot = null, reviewer, result, ref = 'HEAD', sessionId = null }) {
  ledgerRoot = ledgerRoot || canonicalRoot(repoRoot);
  if (!reviewer) return { recorded: false, reason: '--reviewer is required' };
  if (!['pass', 'fail'].includes(result)) return { recorded: false, reason: '--result must be pass|fail' };
  const base = resolveBase(repoRoot);
  if (!base) return { recorded: false, reason: 'no origin/main or main ref to diff against' };
  // 'WORKTREE' isn't a real git rev (see diffRangeArgs) — it means "diff the
  // working tree", not "resolve this ref". `git rev-parse WORKTREE` fails,
  // so head/branch must resolve against HEAD instead; the diff/hash calls
  // below correctly keep using `ref` as-is (gatedDiffStats/computeDiffHash
  // already special-case WORKTREE via diffRangeArgs). queryPushAllowed's
  // drift-matching already expects verdict.head to be a real ancestor commit
  // in this case (`isAncestor(repoRoot, e.head, ref === 'WORKTREE' ? 'HEAD' : ref)`),
  // so recording HEAD here is exactly what that consumer wants.
  const revParseRef = ref === 'WORKTREE' ? 'HEAD' : ref;
  const head = git(repoRoot, ['rev-parse', revParseRef]).trim();
  const branch = git(repoRoot, ['rev-parse', '--abbrev-ref', revParseRef]).trim();
  const stats = gatedDiffStats(repoRoot, base, ref);
  const entry = {
    ts: new Date().toISOString(),
    reviewer,
    result,
    branch,
    head,
    diffHash: computeDiffHash(repoRoot, base, ref),
    gatedLines: stats.totalLines,
    ...(sessionId ? { sessionId } : {}),
  };
  const p = join(ledgerRoot, LEDGER_REL_PATH);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + '\n');
  return { recorded: true, entry, ledger: p };
}

// ── plan-phase verdicts (task #1079) ─────────────────────────────────────────
//
// Everything above this line is DIFF-phase: a verdict is content-addressed on
// the patch text, because the review it records happened after the code
// existed. The owner decision behind task #1079 needs the other half — a review
// recorded BEFORE the first edit, when there is no diff to hash. Those entries
// carry `phase: 'plan'` and are keyed on (sessionId, freshness window) instead.
//
// They live in the SAME ledger on purpose. A second parallel ledger was the
// original proposal and the /plan-review design reviewer killed it as a P0:
// two verdict stores that both claim to answer "was this reviewed?" drift the
// moment either evolves, which is the split-brain risk dispatch-ledger.js:581
// documents ("one ledger … on purpose"). Diff-phase readers already ignore
// unknown fields, and queryPushAllowed() below filters on diffHash/head, which
// plan entries do not carry — so they are inert to it.
//
// Scope classification lives in scripts/lib/infra-review-scope.js (pure, CJS).

export function recordPlanVerdict({
  repoRoot, ledgerRoot = null, reviewer, result, sessionId = null, scope = [], note = '',
}) {
  ledgerRoot = ledgerRoot || canonicalRoot(repoRoot);
  if (!reviewer) return { recorded: false, reason: '--reviewer is required' };
  if (!['pass', 'fail'].includes(result)) return { recorded: false, reason: '--result must be pass|fail' };
  // Unlike recordVerdict(), this deliberately does NOT require an origin/main
  // base: a plan review can legitimately run on a fresh worktree with nothing
  // committed yet, and refusing to record there would make the gate
  // unsatisfiable exactly when it fires most (first edit of a new session).
  if (!sessionId) return { recorded: false, reason: '--session-id is required for a plan verdict' };
  const entry = {
    ts: new Date().toISOString(),
    phase: 'plan',
    reviewer,
    result,
    sessionId,
    ...(scope.length ? { scope } : {}),
    ...(note ? { note } : {}),
  };
  const p = join(ledgerRoot, LEDGER_REL_PATH);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + '\n');
  return { recorded: true, entry, ledger: p };
}

// Answer the hook's question: may this session write these paths?
// Returns the pure decision from infra-review-scope.js with the ledger read
// filled in. Never throws — a caller that cannot evaluate must fail OPEN.
export function queryInfraEditAllowed({
  repoRoot, ledgerRoot = null, paths = [], sessionId = null, priorBlocks = 0, bypass = false,
}) {
  let scope;
  try {
    scope = require('./infra-review-scope.js');
  } catch (e) {
    return { action: 'allow', gated: false, tier: null, matched: [], reason: `infra-review-scope unavailable (${e.code || e.message}) — fail open` };
  }
  let verdicts = [];
  try {
    verdicts = readLedger(ledgerRoot || canonicalRoot(repoRoot));
  } catch { /* unreadable ledger → treated as empty, decision still made */ }
  return scope.evaluateInfraReviewGate({
    paths, verdicts, sessionId, now: Date.now(), priorBlocks, bypass, repoRoot,
  });
}

// Safety valve for the drift memo: heads × pushed-files object lookups fed
// through one `cat-file` process. Past this, skip the memo and fall back to the
// historical one-diff-per-entry scan (slower, identical answers) rather than
// push a multi-megabyte batch through a pipe.
const DRIFT_KEY_PAIR_LIMIT = 200_000;
// Sentinel for "path does not exist at this head". MUST be head-independent:
// `cat-file --batch-check` echoes the full `<sha>:<path> missing` for absent
// objects, and leaving that raw would give every head a unique key and defeat
// the memo entirely — which is the single most common case (a brand-new file
// added by the push exists at NO reviewed head).
const DRIFT_KEY_ABSENT = '∅';

// Content key for the drift diff, batched.
//
// The drift scan below asks the same question once per ledger entry: "how many
// lines of THIS PUSH'S files changed between the reviewed head and ref?" With a
// ~1700-entry ledger that was ~1250 `git diff` spawns per push — measured at
// 105s (and 178s on a warmer ledger), which is what made the merge gate a
// throughput problem and blew merge-gate-hook.test's 20s per-call ceiling.
//
// Because that diff is taken with `--no-renames` over exactly the pushed paths,
// its result is a PURE FUNCTION of those paths' blob OIDs at `head` (the ref
// side is fixed for the whole scan). Two heads with the same blobs therefore
// have the same drift, so one diff per DISTINCT key replaces one per entry. In
// the common case — a push that adds or rewrites a file that no reviewed head
// ever had — every head collapses to ONE key and the scan costs ONE diff.
// Measured on the live ledger: 1257 spawns → 1, 105s → 0.5s.
//
// `--no-renames` is what makes the key exact. With rename detection on, a
// pushed path could be paired against a differently-named source that the key
// does not cover (the main diff normalizes `old => new` to the POST-rename path
// only, so the source is not in pushFiles), and two heads with identical
// pushed-file blobs could still diff differently.
//
// This is a deliberate, MEASURED semantic narrowing, not an assumption. Old vs
// new drift was compared head-by-head across the live 1700-entry ledger on
// synthetic pushes off origin/main (2026-08-14):
//     modify an existing gated file   1165 heads,  0 mismatches
//     pure rename of a gated file     1165 heads, 56 mismatches
//     rename + content change         1165 heads, 56 mismatches
// EVERY mismatch was new > old (e.g. old=0 new=91, old=31 new=91) — a rename
// counts as delete+add instead of collapsing to its content delta. So the only
// behaviour change is that a push which RENAMES a gated file larger than
// DRIFT_BUDGET_LINES can now need a fresh review where it previously rode an
// older verdict. It can turn an allow into a deny but never a deny into an
// allow, which is the fail-closed direction for a review gate. Exact-hash
// matches — the gate's primary path — are not affected at all.
//
// Returns null (→ caller memoizes per-head, i.e. today's behaviour) if the
// batch is oversized or git fails, so this can only ever cost speed.
export function driftContentKeys(repoRoot, heads, paths) {
  const uniqueHeads = [...new Set(heads)];
  if (!uniqueHeads.length || !paths.length) return null;
  if (uniqueHeads.length * paths.length > DRIFT_KEY_PAIR_LIMIT) return null;
  const probes = [];
  for (const h of uniqueHeads) for (const p of paths) probes.push(`${h}:${p}`);
  let out;
  try {
    out = execFileSync('git', ['-C', repoRoot, 'cat-file', '--batch-check=%(objectname)'], {
      input: `${probes.join('\n')}\n`,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const lines = out.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  // One output line per probe is the contract; anything else means a format we
  // did not predict, so decline the memo rather than mis-key it.
  if (lines.length !== probes.length) return null;
  const byHead = new Map();
  let i = 0;
  for (const h of uniqueHeads) {
    const parts = [];
    for (let j = 0; j < paths.length; j++, i++) {
      const line = lines[i];
      parts.push(line.endsWith(' missing') ? DRIFT_KEY_ABSENT : line);
    }
    byHead.set(h, parts.join(','));
  }
  return byHead;
}

// ── the gate decision ────────────────────────────────────────────────────────

export function queryPushAllowed({ repoRoot, ledgerRoot = null, ref = 'HEAD' }) {
  ledgerRoot = ledgerRoot || canonicalRoot(repoRoot);
  const base = resolveBase(repoRoot);
  if (!base) {
    // Can't establish a diff base — fail open (never wedge a push on a
    // detached scratch clone), but say so.
    return { gated: false, allowed: true, reason: 'no origin/main base — gate not applicable' };
  }
  const stats = gatedDiffStats(repoRoot, base, ref);
  if (stats.error) {
    return { gated: false, allowed: true, reason: `diff failed (${stats.error}) — fail open` };
  }
  if (stats.totalLines <= GATE_LINE_BUDGET) {
    return {
      gated: false, allowed: true,
      reason: `gated diff is ${stats.totalLines} lines (≤ budget ${GATE_LINE_BUDGET})`,
      gatedLines: stats.totalLines,
    };
  }

  const currentHash = computeDiffHash(repoRoot, base, ref);
  const entries = readLedger(ledgerRoot).filter(e => e && e.result === 'pass');
  // Built once, used for every entry's ancestor test — see ancestorSet() for
  // why the per-entry spawn made this scan take ~10 minutes.
  const ancestors = ancestorSet(repoRoot, ref === 'WORKTREE' ? 'HEAD' : ref);
  const isAncestorOfRef = (head) => (
    ancestors ? ancestors.has(head) : isAncestor(repoRoot, head, ref === 'WORKTREE' ? 'HEAD' : ref)
  );
  // Loop-invariant: `stats` does not change inside the scan, so the pushed-file
  // set is hoisted out (it was rebuilt per entry) and doubles as the drift
  // pathspec.
  const pushFiles = new Set(stats.files.map(f => f.path));
  const pushFilePaths = [...pushFiles];
  const reviewerEligible = (e) => {
    const light = LIGHT_REVIEWERS.has(e.reviewer);
    if (light) return stats.totalLines <= SECOND_OPINION_MAX_LINES;
    return STRONG_REVIEWERS.has(e.reviewer);
  };
  // Pre-pass over exactly the entries the scan below would price, so the memo
  // keys for all of them resolve in ONE `cat-file` batch instead of a diff each.
  const driftHeads = [];
  for (const e of entries) {
    if (!e || !reviewerEligible(e) || !e.head) continue;
    if (isAncestorOfRef(e.head)) driftHeads.push(e.head);
  }
  const driftKeyByHead = driftContentKeys(repoRoot, driftHeads, pushFilePaths);
  const driftByKey = new Map();
  const driftFor = (head) => {
    // No key map → key on the head itself, which is just the historical
    // one-diff-per-distinct-head behaviour.
    const key = (driftKeyByHead && driftKeyByHead.get(head)) || head;
    if (driftByKey.has(key)) return driftByKey.get(key);
    const raw = gatedDiffStats(repoRoot, head, ref, {
      twoDot: true, noRenames: true, pathspec: pushFilePaths,
    });
    // verdict.head..ref also spans the OTHER parent of any merge (e.g. main
    // merged into the branch after review) — those files are already on
    // origin/main and don't appear in the push diff, so counting them would
    // false-inflate drift and block clean merges. Narrowing the pathspec above
    // already enforces this; the filter stays as a belt-and-braces assertion.
    const hit = raw.error ? raw : {
      files: raw.files.filter(f => pushFiles.has(f.path)),
      totalLines: raw.files.filter(f => pushFiles.has(f.path))
        .reduce((n, f) => n + f.added + f.deleted, 0),
    };
    driftByKey.set(key, hit);
    return hit;
  };
  let nearest = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!reviewerEligible(e)) continue;
    // 'empty' is a no-gated-hunks sentinel, not a content hash — it must never
    // satisfy an exact match (a hash-degradation bug on either side would
    // otherwise turn one old verdict into a permanent rubber stamp).
    if (e.diffHash && e.diffHash !== 'empty' && currentHash && currentHash !== 'empty'
        && e.diffHash === currentHash) {
      return {
        gated: true, allowed: true, via: 'exact-hash', verdict: e,
        gatedLines: stats.totalLines, diffHash: currentHash,
      };
    }
    if (e.head && isAncestorOfRef(e.head)) {
      // Drift = gated changes since the reviewed head, restricted to files this
      // push actually changes.
      const drift = driftFor(e.head);
      if (!drift.error && drift.totalLines <= DRIFT_BUDGET_LINES) {
        return {
          gated: true, allowed: true, via: 'fixup-drift', verdict: e,
          driftLines: drift.totalLines, gatedLines: stats.totalLines, diffHash: currentHash,
        };
      }
      if (!nearest || (drift.totalLines || Infinity) < nearest.driftLines) {
        nearest = { reviewer: e.reviewer, ts: e.ts, driftLines: drift.totalLines ?? Infinity };
      }
    }
  }
  return {
    gated: true, allowed: false,
    reason: nearest
      ? `stale verdict (${nearest.reviewer} @ ${nearest.ts}): ${nearest.driftLines} gated lines changed since (> drift budget ${DRIFT_BUDGET_LINES})`
      : 'no review verdict for this diff',
    gatedLines: stats.totalLines,
    gatedFiles: stats.files.map(f => f.path).slice(0, 10),
    diffHash: currentHash,
  };
}

// ── the MERGE gate (task #1304, owner-approved 2026-08-12) ──────────────────
//
// queryPushAllowed above guards the PUSH. That is one step too late. The
// documented worktree flow is `worktree → merge the branch into the SHARED
// local main checkout → push`, and ~20 parallel sessions share the one
// checkout at /Users/tompryor/Broadwayscore. So by the time the push gate
// blocks, the unreviewed merge commit is ALREADY on shared local main — and
// the next session to run push-with-retry.sh pushes `main` wholesale and
// carries it to origin. Observed 3× in one session on 2026-08-12: two commits
// reached origin/main while the authoring session's own push was still
// blocked, and /code-review could not even review that session's diff because
// `git diff @{upstream}...HEAD` had already gone empty.
//
// The dangerous state is created by the MERGE, so the gate belongs there too.
//
// DIVISION OF LABOUR WITH THE PUSH GATE — load-bearing, do not collapse.
// pre-push-review-gate.sh:187-211 ALREADY awk-parses the merge source out of
// a compound `git merge X && git push origin main` and gates on it. That case
// is fully covered and stays the push gate's. This gate owns only what the
// push gate structurally cannot see:
//   - a STANDALONE `git merge X` (no push in the same command)
//   - `scripts/merge-worktree-to-main.sh [branch]` — the real call site, whose
//     command string contains no `git merge` token AND matches no
//     PUSH_INGRESS_RE pattern (the name has no "push" in it), so today it
//     reaches shared main completely ungated.
// The hook enforces the split by deferring (exit 0) whenever the command
// carries a push ingress. Letting both gates fire on one command is not merely
// redundant: queryOverrideActiveForPush's consume marker is one-shot per
// (sessionId, markerNs), so whichever gate consumed it first would starve the
// other into blocking a push the user had explicitly overridden — a FALSE
// BLOCK on the primary documented flow. The merge gate also uses its own
// markerNs ('merge-gate') as defence in depth.
//
// KNOWN GAP (documented, not chased — same convention as
// infra-review-scope.js's KNOWN_GAPS): scripts/autonomous-merge.js:455,594
// runs `git merge --ff-only` through execFileSync, so no string-matching hook
// can see it. It is dispatched only via `gh workflow run autonomous-merge.yml`
// (autonomous-run.js:155) and never from a session Bash call, and its result
// still faces the push gate downstream.
//
// Fail-open is load-bearing here in a way it is not for the push gate: a
// wedged merge blocks every session's only integration path, not one push.
// Every error path below returns allowed:true.

// The merge wrapper script — the real call site (merge-worktree-to-main.sh:203).
const MERGE_WRAPPER_BASENAME = 'merge-worktree-to-main.sh';

// Interpreters that can carry a script path as their first argument.
const SCRIPT_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'env', 'nohup', 'time']);

// `git merge` flags that consume a FOLLOWING value; that value must not be
// mistaken for the merge source ref. (`--flag=value` forms are single tokens
// and are dropped by the generic leading-dash test.)
const MERGE_VALUE_FLAGS = new Set([
  '-m', '--message', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option',
  '-S', '--gpg-sign', '--into-name',
]);

// `git merge` forms that finish or abandon an in-progress merge. They carry no
// source ref and must NEVER be gated: blocking `git merge --abort` would
// strand the shared main worktree mid-conflict, which is strictly worse than
// the problem this gate exists to solve (cf. task #916, stale MERGE_HEAD on
// shared main blocking all pushes with no recovery path).
const MERGE_CONTROL_FLAGS = new Set(['--abort', '--continue', '--quit']);

// git global options taking a separate value, skipped when locating the
// subcommand (`git -C <path> merge X`).
const GIT_GLOBAL_VALUE_OPTS = new Set(['-C', '-c', '--exec-path', '--git-dir', '--work-tree', '--namespace']);

// Lazily loaded shell tokenizer, shared with infra-review-scope.js so there is
// exactly one definition of "where does one command end". Same degrade-don't-
// crash contract as the ci-red-claims require above: a checkout carrying this
// file without its sibling must fail OPEN, not throw.
let _shellLex = null;
function shellLex() {
  if (_shellLex !== null) return _shellLex;
  try {
    const { shellSegments, tokenize } = require('./infra-review-scope.js');
    if (typeof shellSegments !== 'function' || typeof tokenize !== 'function') throw new Error('missing exports');
    _shellLex = { shellSegments, tokenize };
  } catch (e) {
    process.stderr.write(`review-gate: infra-review-scope.js tokenizer unavailable (${e.code || e.message}) — merge gate degraded to no-op\n`);
    _shellLex = false;
  }
  return _shellLex;
}

// infra-review-scope's shellSegments splits on `; && || |` and newlines but
// not on subshell parens, so `(cd x && git merge y)` leaves a stray `(` on the
// first token and `)` on the last. Strip them — a ref name can never contain
// either, so this can only ever repair a token, never corrupt one.
function stripShellNoise(value) {
  return String(value).replace(/^[(]+/, '').replace(/[)]+$/, '');
}

function basename(p) {
  const s = String(p || '');
  return s.slice(s.lastIndexOf('/') + 1);
}

// Drop leading `FOO=bar` environment assignments. `DRY_RUN=1 scripts/merge-…`
// skips the wrapper's PUSH but still performs the MERGE, so it must still gate.
function withoutEnvPrefix(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return tokens.slice(i);
}

// Classify ONE simple command. Returns null when it is not merge-relevant.
function classifySegment(rawTokens) {
  let toks = withoutEnvPrefix(rawTokens);
  if (toks.length === 0) return null;

  // `bash scripts/merge-worktree-to-main.sh …`, `env FOO=1 bash …`
  while (toks.length > 1 && SCRIPT_INTERPRETERS.has(basename(toks[0]))) {
    toks = withoutEnvPrefix(toks.slice(1));
    // Skip the interpreter's own flags so `bash -x scripts/merge-…sh` still
    // reaches the script name. Bailing on ANY leading flag (the first cut)
    // meant `bash -x <wrapper>` silently escaped the gate — QA review,
    // 2026-08-12.
    //
    // `-c` is the one that must still bail: its payload is a quoted sub-script
    // this shallow parser cannot read, so guessing would be worse than failing
    // open. Short-flag clusters are checked for `c` too (`bash -xc '…'`).
    while (toks.length > 1 && toks[0].startsWith('-')) {
      const flag = toks[0];
      if (flag === '-c' || (/^-[a-zA-Z]+$/.test(flag) && flag.includes('c'))) return null;
      toks = toks.slice(1);
    }
  }
  if (toks.length === 0) return null;

  if (basename(toks[0]) === MERGE_WRAPPER_BASENAME) {
    // Args: [branch] [-- files…]. First non-flag token before `--` is the
    // branch; absent, the wrapper defaults to the invoking cwd's branch
    // (merge-worktree-to-main.sh:54).
    let branch = null;
    for (const t of toks.slice(1)) {
      if (t === '--') break;
      if (t.startsWith('-')) continue;
      branch = t;
      break;
    }
    return { kind: 'wrapper', branch };
  }

  if (basename(toks[0]) !== 'git') return null;

  let i = 1;
  while (i < toks.length) {
    const t = toks[i];
    if (!t.startsWith('-')) break;
    if (GIT_GLOBAL_VALUE_OPTS.has(t)) { i += 2; continue; }
    i += 1;
  }
  const sub = toks[i];
  if (!sub) return null;
  const rest = toks.slice(i + 1);

  if (sub === 'checkout' || sub === 'switch') {
    // The branch this switches to becomes the merge destination for a later
    // `git merge` in the same compound command (`git checkout main && git
    // merge X`) — the shape the documented flow uses, and the one the repo's
    // CURRENT branch cannot reveal at hook time.
    //
    // Two forms look like a branch switch and are not (adversarial review,
    // 2026-08-12) — both would have produced FALSE BLOCKS, the failure
    // direction that wedges sessions:
    //   `git checkout main -- some/file`  restores a path FROM main; the
    //       checked-out branch never changes.
    //   `git checkout --detach main`      lands on a detached HEAD, so a
    //       following merge does not touch the main branch ref at all.
    if (rest.includes('--')) return null;                       // path restore
    if (rest.includes('--detach') || rest.includes('-d')) return null;  // detached HEAD
    for (let j = 0; j < rest.length; j++) {
      const t = rest[j];
      if (t === '-b' || t === '-B' || t === '-c' || t === '-C') { j += 1; continue; }
      if (t.startsWith('-')) continue;
      return { kind: 'checkout', branch: t };
    }
    return null;
  }

  if (sub === 'commit') return { kind: 'commit' };

  if (sub !== 'merge') return null;   // `git pull` is deliberately not here

  const sources = [];
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j];
    if (MERGE_CONTROL_FLAGS.has(t)) return { kind: 'merge-control' };
    if (MERGE_VALUE_FLAGS.has(t)) { j += 1; continue; }
    if (t === '--') continue;
    if (t.startsWith('-')) continue;
    sources.push(t);
  }
  return { kind: 'merge', sources };
}

// Does this Bash command merge something INTO the default branch, and what
// will land? Pure: `currentBranch` (of the repo the command runs in) and
// `defaultBranch` are injected, so this is unit-testable without a fixture.
// The hook resolves them exactly as the push gate resolves its own.
export function parseMergeIngress(command, { currentBranch = null, defaultBranch = 'main' } = {}) {
  const notMerge = (reason) => ({ isMerge: false, targetsMain: false, sources: [], via: null, destination: null, reason });
  const cmd = String(command || '');
  if (!cmd.trim()) return notMerge('empty command');
  // Cheap pre-filter — keeps the gate off the hot path for the ~99% of Bash
  // calls that are not merges.
  if (!/\bmerge\b/.test(cmd)) return notMerge('no merge ingress in command');
  const lex = shellLex();
  if (!lex) return notMerge('tokenizer unavailable — fail open');

  let destination = currentBranch;   // `git merge X` merges into the checked-out branch
  let segments;
  try {
    segments = lex.shellSegments(cmd).map(seg => lex.tokenize(seg).map(t => stripShellNoise(t.value)).filter(Boolean));
  } catch (e) {
    return notMerge(`tokenizer threw (${e.message}) — fail open`);
  }
  const classified = segments.filter(t => t.length).map(classifySegment);

  // `git commit … && git checkout main && git merge X`: at hook time the commit
  // has not happened, so the branch tip does NOT yet contain the work that will
  // land. Evaluate the working tree too. pre-push-review-gate.sh:212-214 already
  // does exactly this for its own compound case; the merge gate was missing it
  // (adversarial review, 2026-08-12). Scanned across ALL segments because the
  // commit can sit either side of the merge. Cheap in practice: data-daemon
  // churn lives in data/, which GATED_PATH_RE does not cover, so this rarely
  // adds lines that were not going to be reviewed anyway.
  const commitsFirst = classified.some(s => s && s.kind === 'commit');
  const withWorktree = (sources) => (commitsFirst ? [...sources, 'WORKTREE'] : sources);

  for (const seg of classified) {
    if (!seg) continue;
    if (seg.kind === 'commit') continue;
    if (seg.kind === 'checkout') { destination = seg.branch; continue; }
    if (seg.kind === 'merge-control') return notMerge('git merge --abort/--continue/--quit carries no source ref');
    if (seg.kind === 'wrapper') {
      // The wrapper locates the main worktree itself and merges into the
      // default branch by construction, so the session's own cwd cannot make
      // it target anything else.
      const branch = seg.branch || currentBranch;
      if (!branch) return notMerge('merge wrapper with no resolvable source branch');
      // The wrapper itself refuses this ("nothing to integrate", :56).
      if (branch === defaultBranch) return notMerge(`merge wrapper source is ${defaultBranch} — the wrapper refuses this`);
      return {
        isMerge: true, targetsMain: true, sources: withWorktree([branch]), via: 'wrapper',
        destination: defaultBranch, reason: `${MERGE_WRAPPER_BASENAME} integrates ${branch} into ${defaultBranch}`,
      };
    }
    if (seg.kind === 'merge') {
      if (seg.sources.length === 0) return notMerge('git merge with no source ref');
      if (destination !== defaultBranch) {
        return {
          isMerge: true, targetsMain: false, sources: seg.sources, via: 'git-merge', destination,
          reason: `merge destination is ${destination || 'unknown'}, not ${defaultBranch}`,
        };
      }
      return {
        isMerge: true, targetsMain: true, sources: withWorktree(seg.sources), via: 'git-merge', destination,
        reason: `git merge into ${defaultBranch}`,
      };
    }
  }
  return notMerge('no merge ingress parsed');
}

// The merge-gate decision. Evaluates every source ref that would land and
// returns the STRICTEST verdict, reusing queryPushAllowed() so that "reviewed"
// means byte-identically the same thing at merge time as at push time — the
// two gates cannot drift apart in what they accept.
//
// Never throws: every failure path returns allowed:true (see the fail-open
// note at the top of this section). Each source is evaluated in its own
// try/catch so one bad ref cannot take the whole loop down with it.
export function queryMergeAllowed({ repoRoot, ledgerRoot = null, sources = [] }) {
  const evaluated = [];
  if (!Array.isArray(sources) || sources.length === 0) {
    return { allowed: true, reason: 'no merge sources to evaluate', evaluated };
  }
  let root;
  try {
    root = ledgerRoot || canonicalRoot(repoRoot);
  } catch (e) {
    return { allowed: true, reason: `could not resolve ledger root (${e.message}) — fail open`, evaluated };
  }
  for (const src of sources) {
    // 'WORKTREE' is the working-tree sentinel (see diffRangeArgs), not a rev —
    // `git rev-parse WORKTREE` fails, so it must skip the resolve check or the
    // compound `git commit … && git merge …` case would always fail open.
    if (src !== 'WORKTREE') {
      // An unresolvable ref is a parse/infra failure, never a violation.
      try {
        git(repoRoot, ['rev-parse', '--verify', '--quiet', `${src}^{commit}`]);
      } catch {
        evaluated.push({ ref: src, allowed: true, reason: 'ref does not resolve — fail open' });
        continue;
      }
    }
    let verdict;
    try {
      verdict = queryPushAllowed({ repoRoot, ledgerRoot: root, ref: src });
    } catch (e) {
      evaluated.push({ ref: src, allowed: true, reason: `gate threw (${e.message}) — fail open` });
      continue;
    }
    if (!verdict || typeof verdict.allowed !== 'boolean') {
      evaluated.push({ ref: src, allowed: true, reason: 'gate returned no verdict — fail open' });
      continue;
    }
    evaluated.push({ ref: src, ...verdict });
    if (verdict.allowed === false) {
      return {
        allowed: false,
        blockingRef: src,
        reason: verdict.reason,
        gatedLines: verdict.gatedLines,
        gatedFiles: verdict.gatedFiles,
        diffHash: verdict.diffHash,
        evaluated,
      };
    }
  }
  return { allowed: true, reason: 'all merge sources reviewed or under budget', evaluated };
}

// One-call entrypoint for the hook: parse the command and decide, so the hook
// pays a single node startup instead of two. `currentBranch` is read from the
// repo when not supplied. Never throws.
export function queryMergeGate({ repoRoot, ledgerRoot = null, command, currentBranch = undefined, defaultBranch = 'main' }) {
  let branch = currentBranch;
  if (branch === undefined) {
    try {
      branch = git(repoRoot, ['branch', '--show-current']).trim() || null;
    } catch {
      branch = null;   // detached HEAD or unreadable repo — parse still runs
    }
  }
  let ingress;
  try {
    ingress = parseMergeIngress(command, { currentBranch: branch, defaultBranch });
  } catch (e) {
    return { allowed: true, reason: `merge-ingress parse threw (${e.message}) — fail open` };
  }
  if (!ingress.isMerge || !ingress.targetsMain) {
    return { allowed: true, ingress, reason: ingress.reason };
  }
  return { ...queryMergeAllowed({ repoRoot, ledgerRoot, sources: ingress.sources }), ingress };
}

// ── CI-red claim conflict (task #584) ───────────────────────────────────────
// Closes the gap task #542's evaluateCiRedClaim shipped with: nothing called
// it, because a PreToolUse hook can't query the shared task-list tool.
// scripts/lib/ci-red-claims.js is the file-based ledger a hook CAN read
// (data/audit/ci-red-claims.jsonl, appended by scripts/claim-ci-red.js).
// This query is deliberately independent of queryPushAllowed above (its own
// function, its own CLI query, its own bash-hook block) — the goal is to add
// duplicate-fix detection without touching the existing, working review gate.

// Unexpired claims, excluding the caller's own (ownTaskId) — same TTL +
// exclude semantics as ci-red-claims.js's activeClaimsAsTasks, but returning
// raw {symbol, runId, taskId} entries so the diff-text substring match below
// has the literal values to search for (activeClaimsAsTasks only returns a
// folded subject string, which is lossy when both symbol and runId are set).
export function activeCiRedClaims({ now = Date.now(), excludeTaskId = null, claimsPath = undefined } = {}) {
  // CLAIM_TTL_MS > 0 too: an older ci-red-claims.js revision without that
  // export would leave readClaims truthy but TTL 0, silently expiring every
  // claim — report degraded instead (reviewer P2, card 3ae637c5).
  if (!readClaims || !(CLAIM_TTL_MS > 0)) return [];
  return readClaims(claimsPath)
    .filter(c => c && c.taskId && now - new Date(c.ts).getTime() < CLAIM_TTL_MS)
    .filter(c => excludeTaskId == null || String(c.taskId) !== String(excludeTaskId));
}

// Minimum needle length for the substring match below. Without a floor, a
// short generic claimed symbol (e.g. "run", "main", "config") would match
// almost any diff — adversarial review (task #584) flagged this as a
// realistic false-positive source. 4 chars matches this codebase's shortest
// real CI-red symbol names seen in practice (e.g. "fold", still excludes
// single tokens like "run"/"id").
const MIN_NEEDLE_LEN = 4;

// Blocks when the pushed diff's gated-file content contains the symbol
// and/or runId of another in_progress task's claim — the same substring-
// match heuristic duplicate-dispatch-guard.js's taskClaimsTarget already
// uses for task subject/description, applied here to diff patch text
// instead. Best-effort: a fix that doesn't literally reference the symbol
// name won't be caught, same known limitation evaluateCiRedClaim already
// has for task subjects.
export function queryCiRedClaimConflict({ repoRoot, ref = 'HEAD', ownTaskId = null, claimsPath = undefined, now = Date.now() }) {
  if (!readClaims || !evaluateCiRedClaim || !(CLAIM_TTL_MS > 0)) {
    return { blocked: false, reason: 'ci-red claim libs unavailable in this checkout — check skipped' };
  }
  const base = resolveBase(repoRoot);
  if (!base) return { blocked: false, reason: 'no origin/main or main ref — fail open' };
  const patchText = gatedDiffPatchText(repoRoot, base, ref).toLowerCase();
  if (!patchText) return { blocked: false, reason: 'no gated diff text' };
  const claims = activeCiRedClaims({ now, excludeTaskId: ownTaskId, claimsPath });
  for (const claim of claims) {
    // Check symbol AND runId independently — a claim can carry both, and a
    // diff that names only one of them (e.g. references the CI run number
    // but not the failing symbol) must still be caught (adversarial review,
    // task #584: `symbol || runId` here previously meant a claim with both
    // set never matched on runId content at all).
    const symbolNeedle = String(claim.symbol || '').toLowerCase();
    const runIdNeedle = String(claim.runId || '').toLowerCase();
    const symbolHit = symbolNeedle.length >= MIN_NEEDLE_LEN && patchText.includes(symbolNeedle);
    const runIdHit = runIdNeedle.length >= MIN_NEEDLE_LEN && patchText.includes(runIdNeedle);
    if (!symbolHit && !runIdHit) continue;
    const asTask = {
      id: claim.taskId,
      status: 'in_progress',
      subject: [claim.symbol, claim.runId].filter(Boolean).join(' '),
      description: '',
    };
    const verdict = evaluateCiRedClaim(
      { symbol: symbolHit ? claim.symbol : null, runId: runIdHit ? claim.runId : null },
      [asTask]
    );
    if (!verdict.allow) {
      return { blocked: true, reason: verdict.reason, claimedBy: verdict.claimedBy };
    }
  }
  return { blocked: false, reason: 'no active CI-red claim conflicts with this diff' };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    const eq = a.indexOf('=');
    if (eq >= 0 && a.startsWith('--')) args[a.slice(2, eq)] = a.slice(eq + 1);
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/lib/review-gate.mjs --query=<mode> [options]

Queries:
  diff-hash      current gated diff stats + content hash
  record         append a review verdict to the ledger
                   --reviewer=ship-check|code-review|second-opinion --result=pass|fail
  push-allowed   should a push of --ref be allowed without a fresh review?
  merge-gate     should this Bash --command be allowed to merge into main
                   without a fresh review? Parses the merge ingress (git merge
                   into main, or ${MERGE_WRAPPER_BASENAME}) and
                   evaluates each source ref with push-allowed's own logic.
                   --current-branch=<b>  branch the command runs on (default:
                                         read from --repo)
                   --default-branch=<b>  merge destination to gate (default: main)
  ci-red-claim-conflict   does --ref's gated diff conflict with an active
                   CI-red claim from another task? --own-task=<id> excludes
                   the caller's own claim (task #584).
  changed-files  own-merge-scoped changed file paths matching --pattern
                   (default: all). --pattern=<regex>

Common options:
  --repo=<path>         git repo/worktree to diff in (default: cwd)
  --ledger-root=<path>  root holding ${LEDGER_REL_PATH} (default: canonical
                        main-worktree root of --repo, shared across worktrees)
  --ref=<ref>           ref being pushed / reviewed (default: HEAD)

All queries print JSON to stdout. Exit 0 success / 1 bad args.`);
}

// realpath both sides: a `file://${argv[1]}` string compare silently fails
// when the script is invoked via a symlinked path (macOS /tmp → /private/tmp),
// making the CLI a no-op — bit the hook test suite on 2026-07-12.
const __isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
        || import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (__isMain) {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }
  const repoRoot = args.repo || process.cwd();
  const ledgerRoot = args['ledger-root'] || null; // null → canonicalRoot(repo)
  const ref = args.ref || 'HEAD';
  let result;
  switch (args.query) {
    case 'diff-hash': {
      const base = resolveBase(repoRoot);
      result = base
        ? { base, ...gatedDiffStats(repoRoot, base, ref), diffHash: computeDiffHash(repoRoot, base, ref) }
        : { error: 'no origin/main or main ref' };
      break;
    }
    case 'record':
      result = recordVerdict({
        repoRoot, ledgerRoot, ref,
        reviewer: args.reviewer, result: args.result,
        sessionId: args['session-id'] || null,
      });
      break;
    case 'record-plan':
      result = recordPlanVerdict({
        repoRoot, ledgerRoot,
        reviewer: args.reviewer, result: args.result,
        sessionId: args['session-id'] || null,
        scope: (args.scope || '').split(',').filter(Boolean),
        note: args.note || '',
      });
      break;
    case 'infra-edit-allowed':
      result = queryInfraEditAllowed({
        repoRoot, ledgerRoot,
        paths: (args.paths || '').split('\n').map((s) => s.trim()).filter(Boolean),
        sessionId: args['session-id'] || null,
        priorBlocks: Number(args['prior-blocks'] || 0),
        bypass: args.bypass === 'true' || args.bypass === true,
      });
      break;
    case 'push-allowed':
      result = queryPushAllowed({ repoRoot, ledgerRoot, ref });
      break;
    case 'merge-gate':
      // No --command → nothing to evaluate. Fail OPEN (a missing arg must not
      // read as "blocked"), matching every other error path in this section.
      result = args.command
        ? queryMergeGate({
            repoRoot, ledgerRoot, command: args.command,
            currentBranch: args['current-branch'] !== undefined ? args['current-branch'] : undefined,
            defaultBranch: args['default-branch'] || 'main',
          })
        : { allowed: true, reason: 'no --command given — fail open' };
      break;
    case 'ci-red-claim-conflict':
      result = queryCiRedClaimConflict({ repoRoot, ref, ownTaskId: args['own-task'] || null });
      break;
    case 'changed-files': {
      const base = resolveBase(repoRoot);
      if (!base) { result = { error: 'no origin/main or main ref' }; break; }
      let re;
      try {
        re = new RegExp(args.pattern || '.*');
      } catch (e) {
        result = { error: `bad --pattern: ${e.message}` };
        break;
      }
      result = { base, ...scopedChangedFiles(repoRoot, base, ref, re) };
      break;
    }
    default:
      console.error(`ERROR: unknown or missing --query "${args.query || ''}"`);
      process.exit(1);
  }
  console.log(JSON.stringify(result));
}
