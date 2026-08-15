#!/usr/bin/env node
// scripts/lib/infra-review-scope.js — classify a file path as shared
// infrastructure, and decide whether a pre-implementation review is required
// before editing it.
//
// Owner decision (Notion 3b4637c5, task #1079, 2026-08-05): sessions changing
// shared infrastructure ship plans that look obviously correct to their author
// and are not. One plan on 2026-08-05 carried four defects — a P0 that would
// have fed spendCircuitBreakerStatus completions it did not earn (disabling the
// only cost guard while tripling dispatch rate), a "fix" reverting a deliberate
// oldest-first decision documented at scripts/lib/backlog-drain.js:1-23, a
// concurrency bump already known-blocked by worktree lock contention, and a
// watcher pointed at a gitignored path that would have reported a live bug as
// fixed. All four were caught only because the owner happened to ask for a
// review. Owner condition, verbatim intent: get a second-opinion or plan-review
// FIRST, because "these things that seem obvious often have unintended
// implications".
//
// WHY THIS SHAPE — the six-reviewer /plan-review of the policy (see the header
// of the test file for the full list) redrew the original proposal:
//
//  1. NOT `scripts/lib/**`. Codex counted 809 files under scripts/lib and 2.7%
//     of all path touches in the last 7 days. Blanket-gating that surface taxes
//     parsers, scoring helpers and email utilities that no other session
//     depends on — the card's own warning that universal scope "gets routed
//     around, which is worse than no policy". Rules below are a curated
//     chokepoint list, tier-tagged.
//  2. TWO TIERS, not one. 'critical' = fleet blast radius (dispatch layer,
//     spend/circuit breakers, concurrency primitives, push paths, the gates
//     themselves, CI, hooks) — these BLOCK. 'shared' = wider infra worth
//     observing — these WARN and record telemetry only. Four reviewers
//     independently said do not enforce a fleet-wide block on an unmeasured
//     base rate (the policy's evidence is n=1); the warn tier is how the base
//     rate gets measured.
//  3. Path classification is the ONLY input. A session is never asked whether
//     its own change is in scope — that closes the self-classification dodge
//     the card names. It does NOT close the shell-write dodge; see
//     bashWriteTargets() below, which is the partial answer, and KNOWN_GAPS.
//  4. The gate's own files are hard-exempt IN CODE (EXEMPT_RE), not by
//     convention. The pre-mortem's primary scenario was a self-gating deadlock:
//     the hook wedges, and the only file that could unwedge it is gated by
//     itself.
//
// Pure functions only — no fs, no git, no process. The ledger read/write lives
// in scripts/lib/review-gate.mjs (one ledger, per the design reviewer's P0:
// review-gate.mjs already owns verdict recording and a second parallel ledger
// is the split-brain risk dispatch-ledger.js:581-587 documents). The hook lives
// at ~/.claude/hooks/infra-plan-review-gate.sh.
//
// Tested by scripts/tests/infra-review-gate.test.mjs (CLAUDE.md rule 15 —
// the test require()s these functions, it does not restate them).

'use strict';

// How long a recorded pre-implementation review covers subsequent edits in the
// same session. Long enough that one review covers a normal implementation run;
// short enough that a review at 09:00 doesn't silently authorise an unrelated
// decision made at 17:00. The devil's-advocate reviewer flagged the original
// plan's missing TTL: "one plan-review at session start silently covers
// unrelated edits made an hour and several unrelated decisions later."
const VERDICT_TTL_MS = 4 * 60 * 60 * 1000;

// A session that is blocked on the same file more than this many times stops
// being blocked and is allowed through with an audit record. Headless sessions
// have no human to answer a block; the pre-mortem's cascade step (6) was
// sessions "looping the same blocked edit expecting a transient failure" and
// burning tokens fleet-wide with zero progress. Failing open on repeat is
// strictly better than a fleet-wide stall, and the audit record is what makes
// it visible.
const MAX_BLOCKS_PER_FILE = 2;

// Files that can never be gated, whatever else matches. These are the gate's
// own moving parts: if the gate misbehaves, editing these is the fix, and a
// gate that blocks its own repair is a deadlock (pre-mortem PRIMARY scenario).
// Tests and fixtures are exempt too — a test cannot break a peer session, and
// gating them punishes exactly the behaviour the policy wants more of.
const EXEMPT_RE = new RegExp([
  String.raw`(?:^|/)infra-review-scope\.js$`,
  String.raw`(?:^|/)infra-plan-review-gate\.sh$`,
  String.raw`(?:^|/)infra-review-gate\.test\.mjs$`,
  String.raw`\.test\.mjs$`,
  String.raw`\.test\.ts$`,
  String.raw`\.test\.sh$`,
  String.raw`(?:^|/)__fixtures__/`,
  String.raw`(?:^|/)tests?/`,
].join('|'));

// ── the rules ────────────────────────────────────────────────────────────────
//
// Order matters: first match wins, so critical rules precede shared ones.
// `why` is shown to the blocked session — a rule that cannot explain itself
// reads as bureaucracy and gets bypassed.
const SHARED_INFRA_RULES = [
  {
    id: 'dispatch',
    tier: 'critical',
    label: 'session dispatch layer',
    re: /^scripts\/(?:lib\/)?(?:bsc-(?:next|conductor|prune|reconcile|status|needs-you)|backlog-drain|digest-autofix|notion-tasks-sync|dispatch-[a-z-]+|duplicate-dispatch-guard|headless-dispatchability|reroute-backlog)\.(?:js|mjs|cjs|sh)$/,
    why: 'every auto-dispatched session is launched through this; a defect here stalls or storms the whole fleet',
  },
  {
    id: 'spend',
    tier: 'critical',
    label: 'spend / run-budget guard',
    re: /^scripts\/lib\/(?:[a-z-]*spend[a-z-]*|[a-z-]*circuit-breaker|[a-z-]*budget)\.(?:js|mjs|cjs)$/,
    // The `budget` half also catches run/time budgets (opening-night-budget.js,
    // run-budget.js), not only the money breakers. That is deliberate — they
    // are the same class of stop-the-runaway guard — but the label and this
    // text must say so, because a rule whose stated reason does not match the
    // file it just blocked is how a gate loses credibility and gets bypassed.
    why: 'a stop-the-runaway guard (API spend, provider credits, or cron run-time); the 2026-08-05 P0 was a false completion credited to this class',
  },
  {
    id: 'concurrency',
    tier: 'critical',
    label: 'concurrency primitive / push path',
    re: /^scripts\/lib\/(?:file-lock|locks-index|send-lock|[a-z-]*-lock|monitor-lock-staleness|atomic-[a-z-]+|[a-z-]*-atomic-write|push-[a-z-]+|merge-worktree-to-main|run-push-audits)\.(?:js|mjs|cjs|sh)$/,
    why: 'many sessions write here at once; a defect corrupts or silently drops another session\'s work',
  },
  {
    id: 'gates',
    tier: 'critical',
    label: 'review / correctness gate',
    re: /^scripts\/lib\/(?:review-gate|review-guards|transcript-scan|non-review-gate|ui-paths|content-quality|score-routing|rebuild-helpers)\.(?:js|mjs|cjs)$/,
    why: 'these decide what other gates allow; a defect here silently disables enforcement everywhere downstream',
  },
  {
    id: 'hooks',
    tier: 'critical',
    label: 'agent hook / harness settings',
    // Hooks live in the ~/.claude repo, so this rule matches on the tail of an
    // absolute path rather than a repo-relative one.
    re: /(?:^|\/)\.claude\/(?:hooks\/[^/]+\.(?:sh|js|mjs|py)|settings(?:\.local)?\.json)$/,
    why: 'runs inside every session on this machine; a fail-closed bug wedges every workspace at once',
  },
  {
    id: 'ci-gate',
    tier: 'critical',
    label: 'merge/deploy-gating CI workflow',
    // The card says "CI gates", not "all workflows", and the distinction is
    // load-bearing: there are 221 workflows here, and gating every one of them
    // put 221 of the blocking tier's 272 files behind a review — the
    // universal-scope tax the card warns gets routed around. A scraper cron
    // failing fails itself; these fail everyone.
    // autonomous-merge.yml is here because its own docstring calls it the ONLY
    // place a branch the nightly loop produced reaches main — a defect there
    // merges a bad branch unattended, which is precisely this tier's remit.
    re: /^\.github\/workflows\/(?:test|lint-workflows|vercel-deploy|vercel-build-guard|autonomous-merge)\.ya?ml$/,
    why: 'gates merges and deploys for every branch and session; a defect here lands main red, blocks prod, or merges a bad branch unattended',
  },
  {
    id: 'ci',
    tier: 'shared',
    label: 'CI workflow',
    re: /^\.github\/workflows\/[^/]+\.ya?ml$/,
    why: 'runs on shared infrastructure and shared secrets, but a failure is scoped to this workflow',
  },
  {
    id: 'shared-lib',
    tier: 'shared',
    label: 'shared script library',
    re: /^scripts\/lib\/[^/]+\.(?:js|mjs|cjs|sh)$/,
    why: 'imported by other scripts, so a behaviour change can reach callers you have not read',
  },
];

// Shell commands that write to a file operand rather than to stdout.
// A PreToolUse hook on the edit tools alone does NOT close the dodge — Codex
// and the devil's-advocate reviewer both enumerated these independently, and
// worktree-enforce.sh already had to build a comparable battery for the same
// reason. Best-effort extraction, not a proof: see KNOWN_GAPS.
const WRITE_COMMANDS = {
  tee: 'all',          // tee [-a] FILE...
  sed: 'inplace',      // sed -i … FILE   (BSD form is `sed -i '' 's/…/…/' FILE`)
  perl: 'inplace',
  ruby: 'inplace',
  cp: 'last',
  mv: 'last',
  install: 'last',
  rsync: 'last',
};

// `git apply X` / `patch < X` are the one write route whose targets are NOT on
// the command line — they are named inside the patch. Treating the patch file
// as the write target (the first cut did) flags a throwaway /tmp path that
// matches no rule, so a patch touching backlog-drain.js sailed through with the
// gate reporting "allow" — worse than not handling patches at all, because the
// shipped test asserted the wrong answer and made it look covered.
// bashPatchSources() returns the patch FILES; the hook reads each and passes
// the text to patchTargets(), which stays pure.
const PATCH_COMMANDS = new Set(['patch']);

// `> path` / `>> path`, including `2> path`. Deliberately not `<`.
const REDIRECT_RE = /(?:^|\s)\d*>>?\s*["']?([^\s"'<>;&|]+)/g;

// Split a command line into rough segments so `printf x | tee f && sed -i … g`
// is seen as three commands. Quote-blind by design: a `|` inside a quoted
// string over-splits, which can only ever produce an extra candidate path, and
// a candidate that matches no rule is discarded anyway.
function shellSegments(command) {
  return String(command).split(/(?:\|\||&&|[;|\n])/);
}

// Tokenise one segment, dropping surrounding quotes and remembering which
// tokens were quoted — a quoted token in `sed -i '' 's/a/b/' file` is the
// script or the empty backup suffix, never the file operand.
function tokenize(segment) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    if (m[3] !== undefined) out.push({ value: m[3], quoted: false });
    else out.push({ value: m[1] !== undefined ? m[1] : m[2], quoted: true });
  }
  return out;
}

// A commit body built via `$(cat <<'EOF' … EOF)`, or any other embedded
// here-doc, carries literal prose across multiple *shell* lines even though
// it is a single quoted VALUE to the real shell. shellSegments()/tokenize()
// have no notion of quoting across a newline, so each heredoc body line would
// otherwise become its own fake "segment" and get tokenized/classified as if
// it were a live command — a commit message that merely NAMES a write
// command, the merge wrapper script, or `git merge --abort` as prose got
// misread as invoking it (task #1557, first caught in the merge gate;
// bashWriteTargets/bashPatchSources below share the exposure since they
// tokenize the same way). Strip heredoc BODIES (and their terminator line,
// which names the tag, not a command) before segmenting.
// Lookbehind/lookahead pin this to EXACTLY two `<` — without it, `<<<TAG`
// (a here-string, no multi-line body at all) matches at its second `<` and
// gets read as a heredoc opener, swallowing every following line — including
// a genuine merge command — as fake "body" until (if ever) a line matching
// the tag turns up. That is a false NEGATIVE (a real merge silently hidden
// from the gate), the dangerous direction for a review gate to fail in —
// caught by adversarial review, task #1557. Tag charset intentionally starts
// with a letter/underscore (never a digit): Bash also accepts purely numeric
// delimiters (`<<123`), but allowing digit-led tags would make this regex
// match `<<8`-style bit-shift text inside arithmetic expansions
// (`$((x<<8))`) — a far more common shape in real commands than a numeric
// heredoc tag, so the false-positive trade favors requiring a leading
// letter/underscore. Dash/dot are still allowed after the first character
// (`<<END-1`, `<<'END.TAG'`) since those cost nothing extra.
const HEREDOC_OPEN_RE = /(?<!<)<<(?!<)(-)?\s*(['"]?)([A-Za-z_][A-Za-z0-9_.-]*)\2/g;
function stripHeredocBodies(command) {
  const str = String(command || '');
  if (!str.includes('<<')) return str; // fast path — no heredocs
  const lines = str.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    i++;
    HEREDOC_OPEN_RE.lastIndex = 0;
    const tags = [];
    let m;
    while ((m = HEREDOC_OPEN_RE.exec(line)) !== null) tags.push({ tag: m[3], dashed: !!m[1] });
    // A line can open more than one heredoc (`cmd <<A <<B`). Real bash
    // consumes their bodies in the order the redirections appear — A's body
    // runs until A's own terminator, then B's body begins immediately after
    // — so a coincidental line matching B's tag inside A's body must NOT end
    // the strip early (it did in an earlier revision that tracked only the
    // last tag on the line, itself an adversarial-review finding).
    for (const { tag, dashed } of tags) {
      // Real bash terminator rules: plain `<<TAG` requires the line to be
      // EXACTLY the tag (no leading/trailing whitespace); `<<-TAG`
      // additionally permits leading TABS (not spaces) before the tag.
      // Matching this precisely — rather than a loose trim() — matters: a
      // body line that merely trims down to the tag text would otherwise end
      // the strip early and re-expose the rest of the body to classification.
      const isTerminator = dashed ? (l) => l.replace(/^\t+/, '') === tag : (l) => l === tag;
      while (i < lines.length && !isTerminator(lines[i])) i++;
      if (i >= lines.length) break; // unterminated — nothing left to strip precisely
      i++; // drop the terminator line, continue with the next tag's body (if any)
    }
  }
  return out.join('\n');
}

// Documented, deliberate holes. Named here so a future session reads them as a
// known cost rather than "discovering" them and hard-locking the gate in
// response. Every one of these is cheaper to accept than to chase, because the
// push-time gate (pre-push-review-gate.sh) still sees the resulting diff.
const KNOWN_GAPS = [
  'a script in the repo that writes files (the hook sees the invocation, not the write)',
  'python -c / node -e inline writes with computed paths',
  'a subagent spawned with its own session id (its verdicts are its own)',
  'any write performed inside a CI job rather than a session',
];

// ── path normalisation ───────────────────────────────────────────────────────

/**
 * Turn whatever a hook received in tool_input.file_path into the repo-relative
 * form the rules expect.
 *
 * The original plan hand-waved this and the devil's-advocate reviewer caught
 * it: a worktree session's path is
 * `<repo>/.claude/worktrees/<name>/scripts/lib/foo.js`, and ~35 worktrees exist
 * at any time, so without prefix-stripping every worktree session is invisible
 * to the classifier by construction — the gate would look enforced and observe
 * nothing. review-gate.mjs never had to solve this because it reads
 * `git diff --name-only`, which is already repo-relative.
 *
 * Absolute paths outside the repo (notably ~/.claude/hooks/*) are returned
 * as-is; the 'hooks' rule matches on their tail.
 */
function toRepoRelative(filePath, { repoRoot = null } = {}) {
  if (!filePath) return '';
  // Collapse repeated separators before anything else: `$TMPDIR` and other
  // env-built prefixes routinely end in `/`, producing `…/T//dbg/scripts/…`.
  // A prefix test against a single-slash root misses, the path stays absolute,
  // and the gate classifies nothing while looking enforced.
  let p = String(filePath).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (repoRoot) {
    // macOS resolves /tmp and /var through /private, so `git rev-parse
    // --show-toplevel` can return /private/var/… while the tool_input path
    // says /var/… — the same directory under two names. A plain prefix test
    // misses, the path stays absolute, and the gate silently classifies
    // nothing while looking enforced. Try both spellings.
    const root = String(repoRoot).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    const candidates = [root];
    if (root.startsWith('/private/')) candidates.push(root.slice('/private'.length));
    else candidates.push('/private' + root);
    for (const c of candidates) {
      if (p === c) return '';
      if (p.startsWith(c + '/')) { p = p.slice(c.length + 1); break; }
    }
  }
  // Strip a linked-worktree prefix wherever it appears, so this works whether
  // the path was absolute, already repo-relative, or relative to the main
  // worktree root.
  p = p.replace(/^(?:.*\/)?\.claude\/worktrees\/[^/]+\//, '');
  return p.replace(/^\.\//, '');
}

// ── classification ───────────────────────────────────────────────────────────

/**
 * Classify ONE path. Pure: same input, same answer, no disk access.
 * @returns {{inScope: boolean, tier: 'critical'|'shared'|null, rule: string|null,
 *            label: string|null, why: string|null, path: string}}
 */
function classifyPath(filePath, opts = {}) {
  const path = toRepoRelative(filePath, opts);
  const miss = { inScope: false, tier: null, rule: null, label: null, why: null, path };
  if (!path) return miss;
  if (EXEMPT_RE.test(path)) return miss;
  for (const rule of SHARED_INFRA_RULES) {
    if (rule.re.test(path)) {
      return { inScope: true, tier: rule.tier, rule: rule.id, label: rule.label, why: rule.why, path };
    }
  }
  return miss;
}

/**
 * Classify a set of paths. The strongest tier present wins — one critical file
 * in a batch makes the batch critical.
 */
function classifyChange(paths, opts = {}) {
  const matched = [];
  for (const p of paths || []) {
    const c = classifyPath(p, opts);
    if (c.inScope) matched.push(c);
  }
  const tier = matched.some((m) => m.tier === 'critical') ? 'critical'
    : matched.length ? 'shared'
      : null;
  return { inScope: matched.length > 0, tier, matched };
}

/**
 * Best-effort extraction of files a shell command would WRITE. Used so the hook
 * can also watch Bash, not just the edit tools. Returns [] for read-only
 * commands.
 */
function bashWriteTargets(command) {
  if (!command) return [];
  command = stripHeredocBodies(command);
  const out = new Set();
  const add = (t) => {
    const v = (t || '').trim();
    // /dev/null, fd duplication, flags and empty operands are not files.
    if (!v || v.startsWith('/dev/') || v.startsWith('-') || v.startsWith('&')) return;
    out.add(v);
  };

  for (const segment of shellSegments(command)) {
    REDIRECT_RE.lastIndex = 0;
    let m;
    while ((m = REDIRECT_RE.exec(segment)) !== null) add(m[1]);

    const tokens = tokenize(segment);
    if (!tokens.length) continue;
    const head = tokens[0].value.replace(/^.*\//, '');
    const rest = tokens.slice(1);
    const mode = WRITE_COMMANDS[head];
    if (!mode) continue;

    // Operands: unquoted, non-flag tokens. Quoting is what distinguishes
    // `sed -i '' 's/a/b/' file` (two quoted args, one operand) from the file.
    const operands = rest.filter((t) => !t.quoted && !t.value.startsWith('-'));
    if (!operands.length) continue;

    if (mode === 'all') operands.forEach((t) => add(t.value));
    else if (mode === 'last') add(operands[operands.length - 1].value);
    else if (mode === 'inplace') {
      // Only in-place invocations write a file; `sed 's/a/b/' f` reads it.
      // Long-form `--in-place` counts too — the short-flag-only check missed it.
      const inPlace = rest.some((t) => !t.quoted
        && (/^-[a-zA-Z]*i/.test(t.value) || /^--in-place\b/.test(t.value)));
      if (!inPlace) continue;
      add(operands[operands.length - 1].value);
    }
  }
  return [...out];
}

/**
 * Patch FILES a command would apply (`git apply f`, `patch -p1 < f`, `patch f`).
 * The caller reads each and passes the text to patchTargets() — this stays pure.
 */
function bashPatchSources(command) {
  if (!command) return [];
  command = stripHeredocBodies(command);
  const out = new Set();
  for (const segment of shellSegments(command)) {
    const tokens = tokenize(segment);
    if (!tokens.length) continue;
    const head = tokens[0].value.replace(/^.*\//, '');
    let rest = tokens.slice(1);
    let isPatch = PATCH_COMMANDS.has(head);
    if (head === 'git' && rest[0] && rest[0].value === 'apply') { isPatch = true; rest = rest.slice(1); }
    if (!isPatch) continue;
    // `patch -p1 < f` puts the file after a redirect, which shellSegments keeps
    // in this segment; both forms are just non-flag operands here.
    for (const t of rest) {
      if (t.quoted || t.value.startsWith('-')) continue;
      const v = t.value.replace(/^<+/, '').trim();
      if (v && !v.startsWith('/dev/')) out.add(v);
    }
  }
  return [...out];
}

/**
 * Files a unified diff would WRITE. Pure — the caller supplies the patch text.
 *
 * Reads BOTH `+++ b/<path>` hunk headers AND `rename to <path>` lines. A pure
 * rename (`git diff -M`, similarity index 100%) emits NO `+++` line at all —
 * verified against real `git diff -M` output — so a patch that renames
 * scripts/lib/backlog-drain.js was invisible to a `+++`-only parser.
 */
function patchTargets(patchText) {
  if (!patchText) return [];
  const out = new Set();
  for (const raw of String(patchText).split('\n')) {
    const line = raw.replace(/\r$/, '');           // tolerate CRLF patches
    // `+++ b/path`, `+++ path` (--no-prefix), optionally followed by a tab +
    // timestamp, which `diff -u` emits and git does not.
    const plus = /^\+\+\+ (?:b\/)?([^\t]+?)(?:\t.*)?\s*$/.exec(line);
    if (plus && plus[1] !== '/dev/null') { out.add(plus[1]); continue; }
    const ren = /^rename to (.+?)\s*$/.exec(line);
    if (ren) out.add(ren[1]);
  }
  return [...out];
}

// ── the gate decision ────────────────────────────────────────────────────────

/**
 * Decide what a hook should do about an edit.
 *
 * Pure by construction: the caller passes the verdict list and the clock, so
 * the test needs no fixtures on disk (the idiom used by non-review-gate.js and
 * the other scripts/lib decision helpers).
 *
 * @param {object}   a
 * @param {string[]} a.paths        paths this tool call would write
 * @param {object[]} a.verdicts     ledger entries (review-gate.mjs readLedger())
 * @param {string}   a.sessionId    current session id
 * @param {number}   a.now          Date.now()
 * @param {number}   a.priorBlocks  times this session was already blocked on this file
 * @param {boolean}  a.bypass       a NO-PLAN-REVIEW token is present in the turn
 * @param {string}   a.repoRoot     repo root, so absolute/worktree paths normalise
 * @returns {{action:'allow'|'warn'|'block', gated:boolean, tier:string|null,
 *            reason:string, matched:object[]}}
 */
function evaluateInfraReviewGate({
  paths = [],
  verdicts = [],
  sessionId = null,
  now = 0,
  priorBlocks = 0,
  bypass = false,
  repoRoot = null,
} = {}) {
  // repoRoot MUST reach classifyPath: the hook hands over absolute paths, and
  // without the root they never normalise to the repo-relative form the rules
  // match on — the gate then classifies nothing while reporting "allow", i.e.
  // silently decorative. Caught by the scratch-repo integration test, not by
  // the unit tests, which pass repo-relative paths directly.
  const { inScope, tier, matched } = classifyChange(paths, { repoRoot });
  if (!inScope) {
    return { action: 'allow', gated: false, tier: null, reason: 'not shared infrastructure', matched: [] };
  }

  const fresh = findFreshPlanVerdict({ verdicts, sessionId, now });
  if (fresh) {
    return {
      action: 'allow',
      gated: true,
      tier,
      reason: `pre-implementation review on record (${fresh.reviewer}, ${fresh.result})`,
      matched,
    };
  }

  // 'shared' tier never blocks. It records a would-have-blocked event so the
  // base rate this policy was built on (n=1) becomes a measured number before
  // anyone widens the blocking tier.
  if (tier !== 'critical') {
    return { action: 'warn', gated: true, tier, reason: 'shared-infra edit with no recorded review (observed, not blocked)', matched };
  }

  if (bypass) {
    return { action: 'warn', gated: true, tier, reason: 'NO-PLAN-REVIEW bypass claimed — recorded for the digest', matched };
  }

  if (priorBlocks >= MAX_BLOCKS_PER_FILE) {
    return {
      action: 'warn',
      gated: true,
      tier,
      reason: `blocked ${priorBlocks}x already on this file — failing open so a headless session cannot spin`,
      matched,
    };
  }

  return {
    action: 'block',
    gated: true,
    tier,
    reason: 'critical shared infrastructure with no pre-implementation review on record',
    matched,
  };
}

/**
 * The freshest usable plan-phase verdict for this session, or null.
 * A 'fail' verdict does NOT unlock the gate — the reviewer wins by default.
 * Overturning a fail is an owner call, recorded as a verdict with
 * reviewer='owner-override' (the devil's-advocate reviewer's answer to open
 * question 3: without this, "reviewer said no" becomes the self-classification
 * dodge one level up).
 */
function findFreshPlanVerdict({ verdicts = [], sessionId = null, now = 0 }) {
  let best = null;
  for (const v of verdicts) {
    if (!v || v.phase !== 'plan') continue;
    if (v.result !== 'pass') continue;
    if (sessionId && v.sessionId && v.sessionId !== sessionId) continue;
    if (!v.sessionId) continue; // an unattributed verdict can't cover a session
    const ts = Date.parse(v.ts || '');
    if (!Number.isFinite(ts)) continue;
    if (now && now - ts > VERDICT_TTL_MS) continue;
    if (!best || ts > Date.parse(best.ts)) best = v;
  }
  return best;
}

module.exports = {
  SHARED_INFRA_RULES,
  EXEMPT_RE,
  KNOWN_GAPS,
  VERDICT_TTL_MS,
  MAX_BLOCKS_PER_FILE,
  // Exported for review-gate.mjs's merge-ingress parser (task #1304). It needs
  // exactly this "split a command into simple commands, then tokenize with
  // quote awareness" primitive; a second copy there would be two divergent
  // definitions of where one command ends and the next begins — the same
  // split-brain the plan-verdict ledger comment (review-gate.mjs) refuses for
  // verdict storage. One tokenizer, two callers.
  shellSegments,
  tokenize,
  stripHeredocBodies,
  toRepoRelative,
  classifyPath,
  classifyChange,
  bashWriteTargets,
  bashPatchSources,
  patchTargets,
  evaluateInfraReviewGate,
  findFreshPlanVerdict,
};
