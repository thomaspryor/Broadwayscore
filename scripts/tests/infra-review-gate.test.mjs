// scripts/tests/infra-review-gate.test.mjs
//
// Acceptance test for task #1079 (owner decision: mandatory pre-implementation
// review before shared-infrastructure changes).
//
// Per CLAUDE.md rule 15 this require()s the REAL decision functions from
// scripts/lib/infra-review-scope.js — it does not restate the rules. Change the
// classifier and this test moves with it or fails; that is the point.
//
// The design under test was redrawn by a six-reviewer /plan-review before any
// code was written (the card's own precondition — the policy had to pass the
// bar it imposes). Reviewers: Codex/GPT-5.x with repo access (production +
// architecture), three independent Claude subagents (structure/devil's
// advocate, pre-mortem, code design), Gemini 2.5 Flash (consistency + gaps),
// and a user-impact/policy-incentives lens. What they changed is recorded in
// the header of scripts/lib/infra-review-scope.js; the cases below are the
// behaviours those changes produced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scope = require('../lib/infra-review-scope.js');

const {
  classifyPath,
  classifyChange,
  toRepoRelative,
  bashWriteTargets,
  bashPatchSources,
  patchTargets,
  evaluateInfraReviewGate,
  findFreshPlanVerdict,
  VERDICT_TTL_MS,
  MAX_BLOCKS_PER_FILE,
  SHARED_INFRA_RULES,
} = scope;

const NOW = Date.parse('2026-08-06T12:00:00Z');
const SESSION = 'sess-1079';

const planVerdict = (over = {}) => ({
  ts: new Date(NOW - 60_000).toISOString(),
  phase: 'plan',
  reviewer: 'plan-review',
  result: 'pass',
  sessionId: SESSION,
  ...over,
});

// ── (a) shared-infra paths are classified IN scope ───────────────────────────

test('(a) shared-infrastructure paths are classified IN scope', () => {
  const cases = [
    ['scripts/lib/backlog-drain.js', 'dispatch', 'critical'],
    ['scripts/bsc-next.js', 'dispatch', 'critical'],
    ['scripts/digest-autofix.js', 'dispatch', 'critical'],
    ['scripts/lib/dispatch-ledger.js', 'dispatch', 'critical'],
    ['scripts/lib/provider-spend-core.js', 'spend', 'critical'],
    ['scripts/lib/outlet-circuit-breaker.js', 'spend', 'critical'],
    ['scripts/lib/run-budget.js', 'spend', 'critical'],
    ['scripts/lib/file-lock.js', 'concurrency', 'critical'],
    ['scripts/lib/push-with-retry.sh', 'concurrency', 'critical'],
    ['scripts/lib/atomic-shows-write.js', 'concurrency', 'critical'],
    // BRO-253 /what-else finding: this file lives at top-level scripts/, not
    // scripts/lib/ — the original regex was anchored under scripts/lib/ only
    // and could never match it, so this "critical" gate silently never
    // covered its own named motivating example.
    ['scripts/merge-worktree-to-main.sh', 'concurrency', 'critical'],
    ['scripts/lib/run-push-audits.sh', 'concurrency', 'critical'],
    // task #1856: the composite actions that actually run the multi-writer
    // push/checkout for CI runners — task #1850 edited three of these
    // without the gate firing because only the scripts/lib/push-* shape
    // was covered.
    ['.github/actions/push-core-data/action.yml', 'concurrency', 'critical'],
    ['.github/actions/push-review-texts/action.yml', 'concurrency', 'critical'],
    ['.github/actions/push-aggregator-archive/action.yml', 'concurrency', 'critical'],
    ['.github/actions/checkout-core-data/action.yml', 'concurrency', 'critical'],
    ['.github/actions/checkout-review-texts/action.yml', 'concurrency', 'critical'],
    ['.github/actions/checkout-aggregator-archive/action.yml', 'concurrency', 'critical'],
    // adversarial review of #1856 (Codex): this action calls
    // push-with-retry.sh under the same concurrent-push race, despite a
    // directory name that doesn't start with push-/checkout- — the reason
    // the rule enumerates exact names instead of guessing at a prefix.
    ['.github/actions/commit-scraper-spend-ledger/action.yml', 'concurrency', 'critical'],
    ['scripts/lib/review-gate.mjs', 'gates', 'critical'],
    ['scripts/lib/review-guards.js', 'gates', 'critical'],
    ['.github/workflows/test.yml', 'ci-gate', 'critical'],
    ['.github/workflows/vercel-deploy.yml', 'ci-gate', 'critical'],
    // its own docstring: the ONLY place a branch the nightly loop produced
    // reaches main — a defect merges a bad branch unattended
    ['.github/workflows/autonomous-merge.yml', 'ci-gate', 'critical'],
    // every OTHER workflow is observed, not blocked — 221 workflows behind a
    // mandatory review is the universal-scope tax the card warns about
    ['.github/workflows/scrape-nysr.yml', 'ci', 'shared'],
    ['.github/workflows/weekly-grosses.yml', 'ci', 'shared'],
    ['/Users/x/.claude/hooks/finish-line-gate.sh', 'hooks', 'critical'],
    ['/Users/x/.claude/settings.json', 'hooks', 'critical'],
    // wider shared surface — in scope, but only the observe tier
    ['scripts/lib/title-match.js', 'shared-lib', 'shared'],
    ['scripts/lib/content-quality.js', 'gates', 'critical'],
    ['scripts/setup-branch-protection.js', 'branch-protection', 'critical'],
  ];
  for (const [path, rule, tier] of cases) {
    const c = classifyPath(path);
    assert.equal(c.inScope, true, `${path} should be in scope`);
    assert.equal(c.rule, rule, `${path} rule`);
    assert.equal(c.tier, tier, `${path} tier`);
    assert.ok(c.why && c.why.length > 20, `${path} must explain itself to the blocked session`);
  }
});

test('(a) task #1856 acceptance: the push/checkout composite actions batch is critical', () => {
  const r = classifyChange([
    '.github/actions/push-core-data/action.yml',
    '.github/actions/push-review-texts/action.yml',
    '.github/actions/push-aggregator-archive/action.yml',
    '.github/actions/checkout-core-data/action.yml',
    '.github/actions/checkout-review-texts/action.yml',
  ]);
  assert.equal(r.inScope, true);
  assert.equal(r.tier, 'critical');
});

test('(a) other .github/actions/ composite actions stay OUT of scope — the enumerated list is not a name-shape guess', () => {
  // Codex adversarial review of #1856: a `(push|checkout)-[a-z-]+` wildcard
  // both under- and over-matches (missed commit-scraper-spend-ledger despite
  // its push-with-retry.sh call; would have silently matched any future
  // push-* dir that isn't actually a push primitive). These are every OTHER
  // real action.yml in the repo as of task #1856 — none should classify.
  for (const p of [
    '.github/actions/check-file-sizes/action.yml',
    '.github/actions/dispatch-deploy/action.yml',
    '.github/actions/notify-failure/action.yml',
    '.github/actions/setup-node/action.yml',
    '.github/actions/setup-playwright/action.yml',
  ]) {
    assert.equal(classifyPath(p).inScope, false, `${p} must NOT be gated`);
  }
});

test('(a) the strongest tier in a batch wins', () => {
  const r = classifyChange(['scripts/lib/title-match.js', 'scripts/lib/file-lock.js', 'data/shows.json']);
  assert.equal(r.inScope, true);
  assert.equal(r.tier, 'critical');
  assert.equal(r.matched.length, 2);
});

// ── (b) data / UI / one-off changes are OUT of scope and never gated ─────────

test('(b) data, UI, content and one-off paths are OUT of scope', () => {
  const out = [
    'data/shows.json',
    'data/reviews.json',
    'data/review-texts/hamilton/nytimes.json',
    'public/data/shows/hamilton.json',
    'src/app/page.tsx',
    'src/components/show-cards/ScoreBadge.tsx',
    'src/lib/scoring.ts',
    'memory/design-system.md',
    'CLAUDE.md',
    'README.md',
    'scripts/one-off-backfill-2026.js',   // scripts/ root, not a named chokepoint
    'scripts/query.js',
    'tailwind.config.js',
  ];
  for (const p of out) {
    const c = classifyPath(p);
    assert.equal(c.inScope, false, `${p} must NOT be gated`);
    assert.equal(c.tier, null);
  }
});

test('(b) an out-of-scope change is allowed with no review on record', () => {
  const d = evaluateInfraReviewGate({
    paths: ['data/shows.json', 'src/app/page.tsx'],
    verdicts: [], sessionId: SESSION, now: NOW,
  });
  assert.equal(d.action, 'allow');
  assert.equal(d.gated, false);
  assert.equal(d.matched.length, 0);
});

test('(b) tests and fixtures are exempt — gating them punishes the wanted behaviour', () => {
  for (const p of [
    'scripts/lib/backlog-drain.test.mjs',
    'scripts/lib/file-lock.test.mjs',
    'scripts/lib/push-with-retry.content-drop.test.sh',
    'scripts/lib/__fixtures__/fake-flag-src/component.tsx',
    'tests/unit/review-gate.test.mjs',
  ]) {
    assert.equal(classifyPath(p).inScope, false, `${p} must be exempt`);
  }
});

test('(b) the gate\'s own files are hard-exempt (no self-gating deadlock)', () => {
  // Pre-mortem PRIMARY scenario: the hook wedges and the only file that can
  // unwedge it is gated by itself.
  for (const p of [
    'scripts/lib/infra-review-scope.js',
    '/Users/x/.claude/hooks/infra-plan-review-gate.sh',
    'scripts/tests/infra-review-gate.test.mjs',
  ]) {
    assert.equal(classifyPath(p).inScope, false, `${p} must never gate itself`);
  }
});

// ── (c) the classifier is a pure function, require()d here ───────────────────

test('(c) the classifier is pure — same input, same answer, no disk or clock', () => {
  const a = classifyPath('scripts/lib/file-lock.js');
  const b = classifyPath('scripts/lib/file-lock.js');
  assert.deepEqual(a, b);
  // and the gate decision takes its verdicts + clock as arguments
  const args = { paths: ['scripts/lib/file-lock.js'], verdicts: [], sessionId: SESSION, now: NOW };
  assert.deepEqual(evaluateInfraReviewGate(args), evaluateInfraReviewGate(args));
});

test('(c) every rule is well-formed', () => {
  for (const r of SHARED_INFRA_RULES) {
    assert.ok(r.id && r.label && r.why, `${r.id}: id/label/why required`);
    assert.ok(['critical', 'shared'].includes(r.tier), `${r.id}: tier must be critical|shared`);
    assert.ok(r.re instanceof RegExp, `${r.id}: re must be a RegExp`);
    assert.equal(r.re.global, false, `${r.id}: a global regex carries lastIndex state between calls`);
  }
});

// ── worktree path resolution ─────────────────────────────────────────────────

test('worktree paths resolve to repo-relative (else ~35 worktrees are invisible)', () => {
  const root = '/Users/x/Broadwayscore';
  const cases = [
    ['/Users/x/Broadwayscore/scripts/lib/file-lock.js', 'scripts/lib/file-lock.js'],
    ['/Users/x/Broadwayscore/.claude/worktrees/job-42/scripts/lib/file-lock.js', 'scripts/lib/file-lock.js'],
    ['.claude/worktrees/job-42/scripts/lib/file-lock.js', 'scripts/lib/file-lock.js'],
    ['./scripts/lib/file-lock.js', 'scripts/lib/file-lock.js'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(toRepoRelative(input, { repoRoot: root }), expected, input);
    assert.equal(classifyPath(input, { repoRoot: root }).inScope, true, input);
  }
});

test('evaluateInfraReviewGate threads repoRoot into the classifier', () => {
  // Regression: the gate took repoRoot but never passed it to classifyChange,
  // so absolute paths from the hook never normalised and every decision came
  // back "not shared infrastructure" — a gate that looks enforced and observes
  // nothing. Only the scratch-repo integration test caught it, because the unit
  // tests hand over repo-relative paths.
  const abs = '/Users/x/Broadwayscore/scripts/lib/backlog-drain.js';
  assert.equal(
    evaluateInfraReviewGate({ paths: [abs], verdicts: [], sessionId: SESSION, now: NOW }).action,
    'allow', 'without repoRoot an absolute path cannot be normalised');
  assert.equal(
    evaluateInfraReviewGate({ paths: [abs], verdicts: [], sessionId: SESSION, now: NOW, repoRoot: '/Users/x/Broadwayscore' }).action,
    'block', 'with repoRoot it must classify and block');
});

test('symlinked and doubled-slash roots still normalise', () => {
  // macOS resolves /var → /private/var, so `git rev-parse --show-toplevel` and
  // tool_input.file_path can name the same directory differently; $TMPDIR-built
  // prefixes add a doubled slash. Both silently blinded the gate.
  const root = '/private/var/folders/ab/T/scratch';
  const p = '/var/folders/ab/T//scratch/scripts/lib/file-lock.js';
  assert.equal(toRepoRelative(p, { repoRoot: root }), 'scripts/lib/file-lock.js');
  assert.equal(classifyPath(p, { repoRoot: root }).tier, 'critical');
});

test('an absolute hook path outside the repo still classifies', () => {
  const c = classifyPath('/Users/x/.claude/hooks/pre-push-review-gate.sh', { repoRoot: '/Users/x/Broadwayscore' });
  assert.equal(c.rule, 'hooks');
  assert.equal(c.tier, 'critical');
});

// ── shell write routes ───────────────────────────────────────────────────────

test('bashWriteTargets catches the common non-Edit write routes', () => {
  const cases = [
    ['cat > scripts/lib/file-lock.js <<EOF', 'scripts/lib/file-lock.js'],
    ['echo x >> scripts/lib/file-lock.js', 'scripts/lib/file-lock.js'],
    ['printf x | tee scripts/lib/file-lock.js', 'scripts/lib/file-lock.js'],
    ["sed -i '' 's/a/b/' scripts/lib/file-lock.js", 'scripts/lib/file-lock.js'],
    ['cp /tmp/new.js scripts/lib/file-lock.js', 'scripts/lib/file-lock.js'],
    ["sed --in-place 's/a/b/' scripts/lib/file-lock.js", 'scripts/lib/file-lock.js'],
  ];
  for (const [cmd, expected] of cases) {
    assert.ok(bashWriteTargets(cmd).includes(expected), `${cmd} → expected ${expected}, got ${JSON.stringify(bashWriteTargets(cmd))}`);
  }
});

test('patch application resolves to the files INSIDE the diff, not the patch file', () => {
  // The first cut returned the patch path itself, which matches no rule — so
  // `git apply p.diff` touching backlog-drain.js came back "allow" while the
  // shipped test asserted that wrong answer and made it look covered.
  assert.deepEqual(bashPatchSources('git apply /tmp/p.diff'), ['/tmp/p.diff']);
  assert.deepEqual(bashPatchSources('patch -p1 < /tmp/p.diff'), ['/tmp/p.diff']);
  assert.deepEqual(bashPatchSources('grep -rn foo scripts/'), []);
  // The patch file is NOT itself a write target.
  assert.equal(bashWriteTargets('git apply /tmp/p.diff').includes('/tmp/p.diff'), false);

  const diff = [
    'diff --git a/scripts/lib/backlog-drain.js b/scripts/lib/backlog-drain.js',
    '--- a/scripts/lib/backlog-drain.js',
    '+++ b/scripts/lib/backlog-drain.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '--- a/gone.txt',
    '+++ /dev/null',
  ].join('\n');
  assert.deepEqual(patchTargets(diff), ['scripts/lib/backlog-drain.js']);

  // A pure rename emits NO `+++` line — verified against real `git diff -M`
  // output. A `+++`-only parser sees an empty target list and allows a patch
  // that renames critical infra out from under the gate.
  const renameOnly = [
    'diff --git a/scripts/lib/backlog-drain.js b/scripts/lib/innocuous.js',
    'similarity index 100%',
    'rename from scripts/lib/backlog-drain.js',
    'rename to scripts/lib/backlog-drain-renamed.js',
  ].join('\n');
  assert.deepEqual(patchTargets(renameOnly), ['scripts/lib/backlog-drain-renamed.js']);

  // `diff -u` (not git) emits a tab + timestamp after the path, and Windows
  // patches carry CRLF. Both must not leak into the classified path.
  assert.deepEqual(
    patchTargets('+++ b/scripts/lib/file-lock.js\t2026-01-01 00:00:00.000\r'),
    ['scripts/lib/file-lock.js']);
  assert.deepEqual(patchTargets('+++ scripts/lib/file-lock.js\r'), ['scripts/lib/file-lock.js']);
  // …and that target lands in the blocking tier, which is the whole point.
  assert.equal(
    evaluateInfraReviewGate({ paths: patchTargets(diff), verdicts: [], sessionId: SESSION, now: NOW }).action,
    'block');
});

test('bashWriteTargets ignores read-only commands and /dev/null', () => {
  assert.deepEqual(bashWriteTargets('grep -rn foo scripts/lib/'), []);
  assert.deepEqual(bashWriteTargets('node scripts/query.js "SELECT 1" 2> /dev/null'), []);
  assert.deepEqual(bashWriteTargets(''), []);
});

// ── the gate decision ────────────────────────────────────────────────────────

test('critical infra with no review on record BLOCKS', () => {
  const d = evaluateInfraReviewGate({
    paths: ['scripts/lib/backlog-drain.js'], verdicts: [], sessionId: SESSION, now: NOW,
  });
  assert.equal(d.action, 'block');
  assert.equal(d.tier, 'critical');
});

test('a fresh pass plan-verdict for this session unblocks it', () => {
  const d = evaluateInfraReviewGate({
    paths: ['scripts/lib/backlog-drain.js'], verdicts: [planVerdict()], sessionId: SESSION, now: NOW,
  });
  assert.equal(d.action, 'allow');
  assert.equal(d.gated, true, 'still reported as gated — it was in scope, it just cleared');
});

test('another session\'s verdict does not unblock this one', () => {
  const d = evaluateInfraReviewGate({
    paths: ['scripts/lib/backlog-drain.js'],
    verdicts: [planVerdict({ sessionId: 'someone-else' })], sessionId: SESSION, now: NOW,
  });
  assert.equal(d.action, 'block');
});

test('a diff-phase verdict does not satisfy the pre-implementation gate', () => {
  // The whole point of the owner decision: /ship-check after the code exists is
  // not the review being demanded. Diff-phase entries have no phase field.
  const diffVerdict = { ts: new Date(NOW - 60_000).toISOString(), reviewer: 'ship-check', result: 'pass', sessionId: SESSION, diffHash: 'abc', head: 'deadbeef' };
  const d = evaluateInfraReviewGate({
    paths: ['scripts/lib/backlog-drain.js'], verdicts: [diffVerdict], sessionId: SESSION, now: NOW,
  });
  assert.equal(d.action, 'block');
});

test('a fail verdict does not unblock — the reviewer wins by default', () => {
  const d = evaluateInfraReviewGate({
    paths: ['scripts/lib/backlog-drain.js'],
    verdicts: [planVerdict({ result: 'fail' })], sessionId: SESSION, now: NOW,
  });
  assert.equal(d.action, 'block');
});

test('an owner-override verdict is how a fail gets overturned', () => {
  const d = evaluateInfraReviewGate({
    paths: ['scripts/lib/backlog-drain.js'],
    verdicts: [planVerdict({ result: 'fail' }), planVerdict({ reviewer: 'owner-override', result: 'pass' })],
    sessionId: SESSION, now: NOW,
  });
  assert.equal(d.action, 'allow');
  assert.match(d.reason, /owner-override/);
});

test('a verdict older than the TTL stops covering new edits', () => {
  const stale = planVerdict({ ts: new Date(NOW - VERDICT_TTL_MS - 1000).toISOString() });
  assert.equal(findFreshPlanVerdict({ verdicts: [stale], sessionId: SESSION, now: NOW }), null);
  const d = evaluateInfraReviewGate({
    paths: ['scripts/lib/backlog-drain.js'], verdicts: [stale], sessionId: SESSION, now: NOW,
  });
  assert.equal(d.action, 'block');
});

test('the shared tier WARNS, never blocks — the base rate is measured, not assumed', () => {
  const d = evaluateInfraReviewGate({
    paths: ['scripts/lib/title-match.js'], verdicts: [], sessionId: SESSION, now: NOW,
  });
  assert.equal(d.action, 'warn');
  assert.equal(d.gated, true);
  assert.equal(d.tier, 'shared');
});

test('repeat blocks on the same file fail open — a headless session must not spin', () => {
  const base = { paths: ['scripts/lib/backlog-drain.js'], verdicts: [], sessionId: SESSION, now: NOW };
  assert.equal(evaluateInfraReviewGate({ ...base, priorBlocks: MAX_BLOCKS_PER_FILE - 1 }).action, 'block');
  const opened = evaluateInfraReviewGate({ ...base, priorBlocks: MAX_BLOCKS_PER_FILE });
  assert.equal(opened.action, 'warn');
  assert.match(opened.reason, /headless/);
});

test('an explicit bypass is downgraded to warn and recorded, not silently honoured', () => {
  const d = evaluateInfraReviewGate({
    paths: ['scripts/lib/backlog-drain.js'], verdicts: [], sessionId: SESSION, now: NOW, bypass: true,
  });
  assert.equal(d.action, 'warn');
  assert.match(d.reason, /NO-PLAN-REVIEW/);
});

// ── self-defending: every composite action that calls a push/concurrency
// primitive must be enumerated in the 'concurrency' rule ──────────────────
//
// /what-else on task #1856 (Codex adversarial review): the fix enumerates
// exact .github/actions/ names rather than a push-/checkout- prefix
// wildcard, because commit-scraper-spend-ledger/action.yml calls
// push-with-retry.sh despite a name that doesn't match that prefix — an
// enumerated list only stays correct as long as a human remembers to update
// it every time a NEW composite action starts calling a gated script. This
// test removes that dependency: it reads the real action.yml files off
// disk and fails if any of them invoke a known concurrency-primitive script
// without being in scope, so the next silent gap is a red test, not a
// missed review.
test('every real .github/actions/*/action.yml that calls a concurrency-primitive script is in scope', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const actionsDir = path.join(repoRoot, '.github', 'actions');
  const WRITE_PRIMITIVE_RE = /push-with-retry\.sh|scripts\/lib\/atomic-[a-z-]+\.(?:js|mjs|cjs)|scripts\/lib\/file-lock\.(?:js|mjs|cjs)/;
  const dirs = fs.readdirSync(actionsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const uncovered = [];
  for (const d of dirs) {
    const ymlPath = ['action.yml', 'action.yaml']
      .map((f) => path.join(actionsDir, d.name, f))
      .find((p) => fs.existsSync(p));
    if (!ymlPath) continue;
    const text = fs.readFileSync(ymlPath, 'utf8');
    // A `push-retry-args` DESCRIPTION line (commit-scraper-spend-ledger's own
    // inputs block) mentions the script name without invoking it — only a
    // `run:` step actually calling it is a real write path. Cheap enough to
    // just require the match not be inside an `inputs:`/`description:` line.
    const callsPrimitive = text.split('\n').some((line) => WRITE_PRIMITIVE_RE.test(line) && !/^\s*description:/.test(line));
    if (!callsPrimitive) continue;
    const rel = path.relative(repoRoot, ymlPath);
    if (!classifyPath(rel).inScope) uncovered.push(rel);
  }
  assert.deepEqual(uncovered, [], `these composite actions call a concurrency-primitive script but are NOT gated: ${uncovered.join(', ')}`);
});

test('the four 2026-08-05 defect sites are all inside the blocking tier', () => {
  // The card's evidence. If a future scope edit drops any of these, the policy
  // no longer covers the incident that created it.
  for (const p of [
    'scripts/lib/backlog-drain.js',      // deliberate oldest-first ordering
    'scripts/digest-autofix.js',         // worktree lock contention at cap 2
    'scripts/lib/provider-spend-core.js', // spend circuit breaker
  ]) {
    const d = evaluateInfraReviewGate({ paths: [p], verdicts: [], sessionId: SESSION, now: NOW });
    assert.equal(d.action, 'block', `${p} must be in the blocking tier`);
  }
});
