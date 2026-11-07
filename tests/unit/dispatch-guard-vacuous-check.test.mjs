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
 *
 * Uses INJECTED fetchOriginMain/pathExistsOnOriginMain deps throughout,
 * never a real `git fetch` — a first version of this file drove
 * resolveVacuousCheck's real git path and hit an intermittent CI failure
 * (ship-check finding): `node --test`'s default file-level parallelism runs
 * many files concurrently against the SAME shared .git directory, and a
 * mutating `git fetch` from one file can race whatever another concurrent
 * file does to the same repo at that instant. classifyVacuousCheck's own
 * correctness against real existence facts is already covered by
 * tests/unit/card-premises-auditor.test.mjs; this file's job is to prove
 * resolveVacuousCheck/vacuousCheckGuard WIRE that classifier correctly at
 * the dispatch boundary, which dependency injection tests without touching
 * git at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveVacuousCheck, vacuousCheckGuard } = require('../../scripts/lib/dispatch-guards.js');
const { VACUOUS_TEST_F_SATISFIED, VACUOUS_TEST_F_UNRESOLVED } = require('../../scripts/lib/card-premises-auditor.js');

// Deterministic stand-ins for the real git-backed oracle — no fetch, no
// network, no shared-checkout mutation.
const FETCH_OK = () => true;
const FETCH_FAILS = (opts) => { (opts && opts.log ? opts.log : () => {})('WARN could not fetch origin/main: simulated failure'); return false; };
const THROWS_IF_CALLED = () => { throw new Error('must not be called'); };

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

// ── resolveVacuousCheck: the I/O-wiring half, driven with injected deps ────

test('resolveVacuousCheck: null gate / missing cmd / non-test-f command never even asks the oracle', () => {
  assert.equal(resolveVacuousCheck(null, {}, { fetchOriginMain: THROWS_IF_CALLED }), null);
  assert.equal(resolveVacuousCheck({}, {}, { fetchOriginMain: THROWS_IF_CALLED }), null);
  assert.equal(resolveVacuousCheck({ cmd: 'npx tsc --noEmit' }, {}, { fetchOriginMain: THROWS_IF_CALLED }), null);
  assert.equal(resolveVacuousCheck({ cmd: 'node --test tests/unit/foo.test.mjs' }, {}, { fetchOriginMain: THROWS_IF_CALLED }), null);
});

test('resolveVacuousCheck: a test -f naming a file the injected oracle reports present is vacuous', () => {
  const verdict = resolveVacuousCheck(
    { cmd: 'test -f scripts/opening-night-poller.js' },
    {},
    { fetchOriginMain: FETCH_OK, pathExistsOnOriginMain: (p) => p === 'scripts/opening-night-poller.js' },
  );
  assert.equal(verdict.kind, VACUOUS_TEST_F_SATISFIED);
  assert.equal(verdict.polarity, 'never-fails');
});

test('resolveVacuousCheck: naming a to-be-created file is NOT vacuous (NEW-ARTIFACT ALLOWANCE)', () => {
  const verdict = resolveVacuousCheck(
    { cmd: 'test -f docs/bro-3394-does-not-exist-yet.md' },
    {},
    { fetchOriginMain: FETCH_OK, pathExistsOnOriginMain: () => false },
  );
  assert.equal(verdict, null);
});

test('resolveVacuousCheck: a failed fetch fails OPEN to null rather than trusting a stale local ref, AND is logged (not silent)', () => {
  // Codex finding: the guard previously disabled itself on a network blip
  // with zero visible evidence. Proven here with an injected fetch that
  // fails and asserts the caller's `log` was actually invoked.
  const logs = [];
  const verdict = resolveVacuousCheck(
    { cmd: 'test -f scripts/opening-night-poller.js' },
    { log: (msg) => logs.push(msg) },
    { fetchOriginMain: FETCH_FAILS, pathExistsOnOriginMain: THROWS_IF_CALLED },
  );
  assert.equal(verdict, null);
  assert.ok(logs.length > 0, 'a fetch failure must be logged, not silent');
});

test('resolveVacuousCheck: a multi-operand test -f (arity error) is refused WITHOUT ever consulting the oracle', () => {
  // Codex adversarial finding (BRO-3394): the first version fetched
  // unconditionally before classifying, making an offline-decidable defect
  // (classifyVacuousCheck's arity branch never consults existsFn) needlessly
  // network-dependent. Proven here with an oracle that throws if invoked.
  const verdict = resolveVacuousCheck(
    { cmd: 'test -f docs/a.md docs/b.md' },
    {},
    { fetchOriginMain: THROWS_IF_CALLED, pathExistsOnOriginMain: THROWS_IF_CALLED },
  );
  assert.equal(verdict.kind, 'test-f-arity');
  assert.equal(verdict.polarity, 'never-passes');
});

// ── The dispatch boundary itself: resolve + guard, chained ─────────────────

test('DISPATCH BOUNDARY: a vacuous test -f command is refused end-to-end, and --allow-vacuous-check bypasses it', () => {
  const gate = { cmd: 'test -f scripts/opening-night-poller.js' };
  const task = { id: 'BRO-live' };
  const deps = { fetchOriginMain: FETCH_OK, pathExistsOnOriginMain: (p) => p === 'scripts/opening-night-poller.js' };

  const verdict = resolveVacuousCheck(gate, {}, deps);
  const refusal = vacuousCheckGuard(task, verdict, {});
  assert.match(refusal, /REFUSING to dispatch #BRO-live/);
  assert.match(refusal, /allow-vacuous-check/);

  const bypassed = vacuousCheckGuard(task, verdict, { 'allow-vacuous-check': true });
  assert.equal(bypassed, null);
});

test('DISPATCH BOUNDARY: a real, falsifiable acceptance command is never touched by this guard', () => {
  const gate = { cmd: 'node --test tests/unit/dispatch-guard-vacuous-check.test.mjs' };
  const task = { id: 'BRO-live2' };
  const verdict = resolveVacuousCheck(gate, {}, { fetchOriginMain: THROWS_IF_CALLED });
  assert.equal(vacuousCheckGuard(task, verdict, {}), null);
});
