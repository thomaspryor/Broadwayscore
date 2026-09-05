// Colocated (scripts/lib/*.test.mjs is globbed by test.yml — no
// tests/unit-test-manifest.txt entry needed).
//
// Pins BEHAVIOUR, not shape: every assertion here fails if the exit contract in
// named-show-verdict.js is loosened back toward "unresolved is benign". The
// v38 handoff's defect 11 was a guard that asserted an IMPORT rather than a
// call and stayed green with the fix removed; these assert the returned
// exitCode and validated flag, which is the thing production reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyNamedShowRun,
  DEFINITIVE_RESULTS,
  NOT_VALIDATED_REASONS,
  EXIT_MISMATCH,
  EXIT_NOT_VALIDATED,
} = require('./named-show-verdict.js');

test('a sweep is untouched: no showFilter always validates, whatever the rows say', () => {
  const rows = [
    { id: 'a', result: 'no-playbill-url' },
    { id: 'b', result: 'serp-error' },
    { id: 'c', result: 'mismatch' },
  ];
  const v = classifyNamedShowRun({ showFilter: undefined, results: rows, targetCount: 9 });
  assert.equal(v.validated, true, 'a sweep keeps its own gates — this module must not add a second one');
  assert.equal(v.exitCode, 0);
  assert.equal(v.message, null);
});

test('a named show that MATCHED is validated and exits 0', () => {
  const v = classifyNamedShowRun({ showFilter: 'giant-2026', results: [{ id: 'giant-2026', result: 'match' }], targetCount: 1 });
  assert.equal(v.validated, true);
  assert.equal(v.exitCode, 0);
});

test('THE SECOND HOLE: bare --show on a real MISMATCH must exit 1, not 0', () => {
  // The mismatch gate in validate-show-venue.js is `if (failOnMismatch && ...)`,
  // and the command CLAUDE.md rule 3 documents does not pass that flag — so the
  // documented pre-commit check printed "Mismatches: ..." and exited 0 for a
  // wrong venue or a wrong year. Found by adversarial review (Codex) on the
  // first cut of this module, which classified mismatch as "validated".
  const v = classifyNamedShowRun({ showFilter: 'giant-2026', results: [{ id: 'giant-2026', result: 'mismatch' }], targetCount: 1 });
  assert.equal(v.validated, false);
  assert.equal(v.exitCode, EXIT_MISMATCH);
  assert.equal(v.exitCode, 1, 'must reuse the --fail-on-mismatch code so the flagged and bare forms agree');
  assert.notEqual(v.exitCode, EXIT_NOT_VALIDATED, '"your show is wrong" must not be reported as "I could not check it"');
  assert.match(v.message, /MISMATCHES Playbill/);
});

test('THE FIRST HOLE: a named show with no Playbill page is NOT a pass', () => {
  const v = classifyNamedShowRun({ showFilter: 'made-up-stub-2026', results: [{ id: 'made-up-stub-2026', result: 'no-playbill-url' }], targetCount: 1 });
  assert.equal(v.validated, false);
  assert.equal(v.exitCode, EXIT_NOT_VALIDATED);
  assert.notEqual(v.exitCode, 0, 'exit 0 here is the exact silence BRO-2821 suggestion 1 exists to remove');
  assert.equal(v.retryable, false, 'no page found is not fixed by re-running the same command');
  assert.match(v.message, /made-up-stub-2026/);
  assert.match(v.message, /NOT validated/);
  // The message must not claim absence is authoritative: SERP recall is
  // fallible, so "the search may simply have missed it" has to survive.
  assert.match(NOT_VALIDATED_REASONS['no-playbill-url'].why, /failed to surface a page that exists/);
});

test('THE THIRD HOLE: a named show the run never REACHED is not a pass either', () => {
  // `if (timeBudget.exceeded()) break;` in validate-show-venue.js's loop is not
  // gated on --all-provisional, so a named run under a budget can produce zero
  // rows. The first cut of this module returned "validated" for an empty result
  // set, which made that read as a clean pass (adversarial review, Codex).
  const v = classifyNamedShowRun({ showFilter: 'x-2026', results: [], targetCount: 1 });
  assert.equal(v.validated, false);
  assert.equal(v.exitCode, EXIT_NOT_VALIDATED);
  assert.equal(v.result, 'not-reached');
  assert.match(v.message, /never reached/);
  assert.match(v.message, /x-2026/);
});

test('every transient class is non-benign too, and is marked retryable', () => {
  for (const result of ['serp-error', 'fetch-error', 'short-response', 'infra-unavailable']) {
    const v = classifyNamedShowRun({ showFilter: 'x-2026', results: [{ id: 'x-2026', result }], targetCount: 1 });
    assert.equal(v.validated, false, `${result} must not read as a pass for a named show`);
    assert.equal(v.exitCode, EXIT_NOT_VALIDATED, `${result} must exit 3`);
    assert.equal(v.retryable, true, `${result} is transient and the operator must be told to retry`);
    assert.equal(v.result, result);
  }
});

test('an UNRECOGNISED non-definitive result fails closed, rather than falling through as validated', () => {
  const v = classifyNamedShowRun({ showFilter: 'x-2026', results: [{ id: 'x-2026', result: 'some-future-class' }], targetCount: 1 });
  assert.equal(v.validated, false);
  assert.equal(v.exitCode, EXIT_NOT_VALIDATED);
  assert.match(v.message, /some-future-class/);
});

test('a missing/undefined/null row is not definitive, and is NOT mislabelled as never-reached', () => {
  for (const row of [{ id: 'x-2026' }, { id: 'x-2026', result: undefined }, null]) {
    const v = classifyNamedShowRun({ showFilter: 'x-2026', results: [row], targetCount: 1 });
    assert.equal(v.validated, false, `row ${JSON.stringify(row)} must not read as validated`);
    assert.equal(v.exitCode, EXIT_NOT_VALIDATED);
    // The run DID reach this show — it just produced an unusable row. Saying
    // "the run ended before checking this show" would be a false explanation
    // (Claude review).
    assert.notEqual(v.result, 'not-reached', `row ${JSON.stringify(row)} was reached; do not claim otherwise`);
    assert.doesNotMatch(v.message, /never reached/);
  }
});

test('targetCount 0 with no rows stays exit 0 — "show not found" already exits earlier and must not gain a second failure mode', () => {
  assert.equal(classifyNamedShowRun({ showFilter: 'x-2026', results: [], targetCount: 0 }).validated, true);
  // Omitting targetCount entirely falls back to results.length, so an empty
  // run with no stated intent is still treated as "nothing to check".
  assert.equal(classifyNamedShowRun({ showFilter: 'x-2026', results: [] }).validated, true);
  assert.equal(classifyNamedShowRun({ showFilter: 'x-2026', results: undefined }).validated, true);
});

test('a mismatch outranks an unresolved row in the same run', () => {
  const v = classifyNamedShowRun({
    showFilter: 'x-2026',
    results: [{ id: 'a', result: 'serp-error' }, { id: 'b', result: 'mismatch' }],
    targetCount: 2,
  });
  assert.equal(v.exitCode, EXIT_MISMATCH, 'the most actionable finding wins');
});

test('exit codes are distinct and stable', () => {
  assert.equal(EXIT_MISMATCH, 1);
  assert.equal(EXIT_NOT_VALIDATED, 3);
  assert.notEqual(EXIT_NOT_VALIDATED, 2, '2 is reserved for main()\'s fatal catch');
});

test('the definitive set is exactly match+mismatch — widening it silently re-opens a hole', () => {
  assert.deepEqual([...DEFINITIVE_RESULTS].sort(), ['match', 'mismatch']);
});

test('every reason carries a what/why/retryable triple, so no class can be added with an empty explanation', () => {
  for (const [k, r] of Object.entries(NOT_VALIDATED_REASONS)) {
    assert.ok(r.what && r.what.length > 10, `${k}.what`);
    assert.ok(r.why && r.why.length > 10, `${k}.why`);
    assert.equal(typeof r.retryable, 'boolean', `${k}.retryable`);
  }
  assert.ok(NOT_VALIDATED_REASONS['not-reached'], 'the never-reached class must carry an explanation too');
});
