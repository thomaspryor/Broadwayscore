/**
 * BRO-3394 — the vacuous-check twin of BRO-2569's phantom-path guard.
 *
 * BRO-3378 shipped classifyVacuousCheck() (a `test -f <path>` acceptance
 * command that already exists on origin/main can never fail, so it proves
 * nothing when re-run at Done time) but wired it into only two places: the
 * read-only audit (audit-card-verifiability.js) and the enricher's own
 * guardrail 2b (enrich-card-acceptance.js, blocking only its OWN LLM drafts).
 * The live board found 31 open cards with a vacuous check; only ~11 traced to
 * the enricher's log — the other ~20 arrived via a hand-written description,
 * `linear-brain.js create`, the plan-tasks skill, or a Notion import, and
 * nothing at the actual DISPATCH boundary ever caught them.
 *
 * This proves the fix lives where BRO-2569 put the phantom-path guard:
 * dispatch-guards.js's resolveVacuousCheck/vacuousCheckGuard, requiring the
 * REAL functions (CLAUDE.md rule 15) rather than restating the decision here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveVacuousCheck, vacuousCheckGuard } = require('../../scripts/lib/dispatch-guards.js');
const { VACUOUS_TEST_F_SATISFIED, VACUOUS_TEST_F_UNRESOLVED } = require('../../scripts/lib/card-premises-auditor.js');

const SATISFIED_VERDICT = {
  kind: VACUOUS_TEST_F_SATISFIED,
  polarity: 'never-fails',
  paths: ['scripts/opening-night-poller.js'],
  reason: '`test -f scripts/opening-night-poller.js` already passes on origin/main, so re-running it at Done time cannot distinguish finished work from untouched work',
};

// ── vacuousCheckGuard: pure decision over a pre-computed verdict ───────────

test('vacuousCheckGuard: REFUSES a dispatch on a vacuous test -f verdict', () => {
  const err = vacuousCheckGuard({ id: 42 }, SATISFIED_VERDICT, {});
  assert.match(err, /REFUSING to dispatch #42/);
  assert.match(err, /vacuous/);
  assert.match(err, /already passes on origin\/main/);
});

test('vacuousCheckGuard: --allow-vacuous-check bypasses the refusal', () => {
  const err = vacuousCheckGuard({ id: 42 }, SATISFIED_VERDICT, { 'allow-vacuous-check': true });
  assert.equal(err, null);
});

test('vacuousCheckGuard: --force bypasses it too, matching every sibling guard in this file', () => {
  const err = vacuousCheckGuard({ id: 42 }, SATISFIED_VERDICT, { force: true });
  assert.equal(err, null);
});

test('vacuousCheckGuard: --dry-run and --print-prompt bypass it, matching pathVerifiabilityGuard', () => {
  assert.equal(vacuousCheckGuard({ id: 42 }, SATISFIED_VERDICT, { 'dry-run': true }), null);
  assert.equal(vacuousCheckGuard({ id: 42 }, SATISFIED_VERDICT, { 'print-prompt': true }), null);
});

test('vacuousCheckGuard: a null verdict (not vacuous, or not a test -f command) never refuses', () => {
  assert.equal(vacuousCheckGuard({ id: 42 }, null, {}), null);
});

test('vacuousCheckGuard: fails OPEN on an UNRESOLVED verdict even with no bypass flag set', () => {
  // Mirrors the read-only audit's own choice (auditVacuousChecks drops
  // UNRESOLVED), not the enricher's (guardrail 2b defers-not-writes) — a
  // dispatch guard runs on every dispatch attempt, and a transient git/fetch
  // blip must not be able to block real work. Same asymmetry every other
  // guard in this file resolves in favor of failing open on ambiguous data.
  const unresolved = {
    kind: VACUOUS_TEST_F_UNRESOLVED,
    polarity: 'unknown',
    paths: ['scripts/whatever.js'],
    reason: 'could not resolve `scripts/whatever.js` against origin/main this run, so whether `test -f scripts/whatever.js` can ever fail is unknown',
  };
  assert.equal(vacuousCheckGuard({ id: 42 }, unresolved, {}), null);
});

// ── resolveVacuousCheck: the I/O half, exercised against this real repo ────

test('resolveVacuousCheck: null gate / missing cmd / non-test-f command never triggers a fetch', () => {
  // No repo override — if this reached fetchOriginMain for a shape it can't
  // possibly need, it would shell out to real git for nothing.
  assert.equal(resolveVacuousCheck(null, {}), null);
  assert.equal(resolveVacuousCheck({}, {}), null);
  assert.equal(resolveVacuousCheck({ cmd: 'npx tsc --noEmit' }, {}), null);
  assert.equal(resolveVacuousCheck({ cmd: 'node --test tests/unit/foo.test.mjs' }, {}), null);
});

test('resolveVacuousCheck: end-to-end against this repo — a test -f naming a file already on origin/main is vacuous', () => {
  // Exercises the REAL fetchOriginMain + pathExistsOnOriginMain path (this
  // repo's own origin/main, same convention as
  // tests/unit/card-premises-auditor.test.mjs's pathExistsOnOriginMain test)
  // — this is the exact shape a dispatcher passes at the real call site: a
  // {cmd} gate plus a {repo} opts object built from resolveCanonicalRepoRoot.
  const repo = path.resolve(process.cwd());
  const verdict = resolveVacuousCheck({ cmd: 'test -f scripts/opening-night-poller.js' }, { repo, log: () => {} });
  assert.equal(verdict.kind, VACUOUS_TEST_F_SATISFIED);
  assert.equal(verdict.polarity, 'never-fails');
});

test('resolveVacuousCheck: naming a to-be-created file is NOT vacuous (NEW-ARTIFACT ALLOWANCE)', () => {
  // `null` here is ambiguous by itself — it is also what a FAILED fetch
  // returns (see the next test) — so a log spy proves this null came from a
  // genuine "confirmed absent" verdict, not a silently-swallowed fetch
  // failure masquerading as one (ship-check/Codex finding, BRO-3394: the
  // first version of this test could not tell the two apart).
  const logs = [];
  const repo = path.resolve(process.cwd());
  const verdict = resolveVacuousCheck(
    { cmd: 'test -f docs/bro-3394-does-not-exist-yet.md' },
    { repo, log: (msg) => logs.push(msg) },
  );
  assert.equal(verdict, null);
  assert.deepEqual(logs, [], 'a genuine absence must not log a fetch-failure WARN');
});

test('resolveVacuousCheck: a failed fetch fails OPEN to null rather than trusting a stale local ref, AND is logged (not silent)', () => {
  // A real (non-git) directory makes fetchOriginMain's `git fetch` fail
  // deterministically, no network mocking needed — same pattern as
  // card-premises-auditor.test.mjs's own fetch-failure coverage. Asserting
  // the log fired is the other half of the previous test's proof: a fetch
  // failure and a genuine absence must both return null, but must be
  // DISTINGUISHABLE to anything watching the dispatcher's own output
  // (Codex finding: the guard previously disabled itself on a network blip
  // with zero visible evidence).
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-guard-vacuous-not-a-repo-'));
  const logs = [];
  const verdict = resolveVacuousCheck(
    { cmd: 'test -f scripts/opening-night-poller.js' },
    { repo: notARepo, log: (msg) => logs.push(msg) },
  );
  assert.equal(verdict, null);
  assert.ok(logs.length > 0, 'a fetch failure must be logged, not silent');
});

test('resolveVacuousCheck: a multi-operand test -f (arity error) is refused WITHOUT any network fetch', () => {
  // Codex adversarial finding (BRO-3394): the first version fetched
  // unconditionally before classifying, making an offline-decidable defect
  // (classifyVacuousCheck's arity branch never consults existsFn) needlessly
  // network-dependent. Proven here by pointing `repo` at a non-git directory
  // — if this reached fetchOriginMain it would fail and return null instead
  // of the arity verdict.
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-guard-vacuous-arity-offline-'));
  const verdict = resolveVacuousCheck(
    { cmd: 'test -f docs/a.md docs/b.md' },
    { repo: notARepo, log: () => { throw new Error('must not attempt a fetch for an arity error'); } },
  );
  assert.equal(verdict.kind, 'test-f-arity');
  assert.equal(verdict.polarity, 'never-passes');
});

// ── The dispatch boundary itself: resolve + guard, chained ─────────────────

test('DISPATCH BOUNDARY: a vacuous test -f command is refused end-to-end, and --allow-vacuous-check bypasses it', () => {
  const repo = path.resolve(process.cwd());
  const gate = { cmd: 'test -f scripts/opening-night-poller.js' };
  const task = { id: 'BRO-live' };

  const verdict = resolveVacuousCheck(gate, { repo, log: () => {} });
  const refusal = vacuousCheckGuard(task, verdict, {});
  assert.match(refusal, /REFUSING to dispatch #BRO-live/);
  assert.match(refusal, /allow-vacuous-check/);

  const bypassed = vacuousCheckGuard(task, verdict, { 'allow-vacuous-check': true });
  assert.equal(bypassed, null);
});

test('DISPATCH BOUNDARY: a real, falsifiable acceptance command is never touched by this guard', () => {
  const repo = path.resolve(process.cwd());
  const gate = { cmd: 'node --test tests/unit/dispatch-guard-vacuous-check.test.mjs' };
  const task = { id: 'BRO-live2' };
  const verdict = resolveVacuousCheck(gate, { repo, log: () => {} });
  assert.equal(vacuousCheckGuard(task, verdict, {}), null);
});
