/**
 * audit-stale-open-premises.test.mjs — colocated tests for the open-card
 * premise re-check.
 *
 * Per CLAUDE.md rule 15 these require() the REAL functions, and the real
 * verify-gate underneath them: the fixtures below are card descriptions in the
 * shapes evaluateVerifiability() actually arms on, not a local re-implementation
 * of card parsing. If the gate's arming contract changes, these go red — which
 * is the point.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectAuditableCards, classifyPremiseOutcome, parseArgs } =
  require('./audit-stale-open-premises.js');

const ARMED = '## Acceptance criteria\n\nRun:\n`node scripts/validate-data.js`\n';
const ARMED_TEST = 'VERIFY: node --test tests/unit/foo.test.mjs';
const OWNER = 'VERIFY: owner-judgment';
const UNARMED = 'Just prose describing a problem, with nothing runnable in it.';

const card = (identifier, state, title, description) => ({
  identifier,
  title,
  description,
  state: { name: state },
});

describe('selectAuditableCards', () => {
  it('selects unstarted cards that name a runnable command', () => {
    const { selected } = selectAuditableCards([
      card('BRO-1', 'Backlog', 'P1: main red — thing is broken', ARMED),
      card('BRO-2', 'Todo', 'P0: other thing', ARMED_TEST),
    ]);
    assert.equal(selected.length, 2);
    assert.deepEqual(selected.map((s) => s.identifier), ['BRO-1', 'BRO-2']);
    assert.equal(selected[0].cmd, 'node scripts/validate-data.js');
    assert.equal(selected[1].cmd, 'node --test tests/unit/foo.test.mjs');
  });

  it('skips cards somebody is already working — In Progress and In Review are not re-checked', () => {
    const { selected, skipped } = selectAuditableCards([
      card('BRO-3', 'In Progress', 'P1: being worked right now', ARMED),
      card('BRO-4', 'In Review', 'P1: already in review', ARMED),
    ]);
    assert.equal(selected.length, 0);
    assert.deepEqual(skipped.map((s) => s.reason), ['not-unstarted', 'not-unstarted']);
  });

  it('skips a card with no safe-form command, carrying the gate refusal kind through', () => {
    const { selected, skipped } = selectAuditableCards([
      card('BRO-5', 'Backlog', 'P1: unrunnable', UNARMED),
    ]);
    assert.equal(selected.length, 0);
    assert.equal(skipped[0].reason, 'no-safe-command');
    assert.equal(skipped[0].kind, 'no-section');
  });

  it('skips an owner-judgment card: it arms the dispatch gate but names nothing to run', () => {
    const { selected, skipped } = selectAuditableCards([
      card('BRO-6', 'Backlog', 'P1: needs the owner', OWNER),
    ]);
    assert.equal(selected.length, 0);
    assert.equal(skipped[0].reason, 'owner-judgment');
  });

  it('applies --filter to titles, case-insensitively', () => {
    const { selected } = selectAuditableCards(
      [
        card('BRO-7', 'Backlog', 'P1: MAIN RED — registry collision', ARMED),
        card('BRO-8', 'Backlog', 'P1: unrelated cleanup', ARMED),
      ],
      { filter: /main red/i }
    );
    assert.deepEqual(selected.map((s) => s.identifier), ['BRO-7']);
  });

  it('applies --limit without silently dropping the overflow from the report', () => {
    const { selected, skipped } = selectAuditableCards(
      [
        card('BRO-9', 'Backlog', 'a', ARMED),
        card('BRO-10', 'Backlog', 'b', ARMED),
        card('BRO-11', 'Backlog', 'c', ARMED),
      ],
      { limit: 2 }
    );
    assert.equal(selected.length, 2);
    assert.deepEqual(
      skipped.filter((s) => s.reason === 'over-limit').map((s) => s.identifier),
      ['BRO-11']
    );
  });

  it('tolerates a non-array and malformed rows rather than throwing mid-audit', () => {
    assert.deepEqual(selectAuditableCards(null).selected, []);
    const { selected } = selectAuditableCards([{ title: 'no identifier', state: { name: 'Backlog' } }]);
    assert.equal(selected.length, 0);
  });
});

describe('classifyPremiseOutcome', () => {
  it('a pass means the state the card was filed to reach is already reached', () => {
    assert.equal(
      classifyPremiseOutcome({ status: 'pass', detail: null }).verdict,
      'premise-stale-candidate'
    );
  });

  it('a fail means the premise is still live', () => {
    assert.equal(
      classifyPremiseOutcome({ status: 'fail', detail: 'assertion failed' }).verdict,
      'premise-live'
    );
  });

  // THE LOAD-BEARING ASSERTION. runVerify() reports a timeout, a missing
  // binary, an unprepared checkout and exit 3 all as 'unverifiable' — the
  // ABSENCE of an answer. If any of those were ever folded in with 'pass'
  // (e.g. by rewriting this as `status !== 'fail' ? stale : live`), a busy
  // machine or a typo in a card's verify string would nominate a REAL,
  // unfixed bug for closure. Every non-pass status must fail open.
  for (const detail of [
    'check killed by SIGTERM after 900000ms (timeout — no verdict)',
    'command could not be started (ENOENT): node',
    'checkout has no node_modules — any result would measure the environment, not the card',
    'check exited 3 (cannot verify — evidence unavailable)',
  ]) {
    it(`never nominates a card as stale on no-verdict: ${detail.slice(0, 40)}`, () => {
      const out = classifyPremiseOutcome({ status: 'unverifiable', detail });
      assert.equal(out.verdict, 'unverifiable');
      assert.notEqual(out.verdict, 'premise-stale-candidate');
    });
  }

  it('an unrecognised status is treated as no verdict, not as a pass', () => {
    assert.equal(classifyPremiseOutcome({ status: 'weird' }).verdict, 'unverifiable');
    assert.equal(classifyPremiseOutcome(null).verdict, 'unverifiable');
    assert.equal(classifyPremiseOutcome(undefined).verdict, 'unverifiable');
  });
});

describe('parseArgs', () => {
  it('parses the documented flags', () => {
    const o = parseArgs(['--dry-run', '--limit=5', '--filter=main red', '--json']);
    assert.equal(o.dryRun, true);
    assert.equal(o.json, true);
    assert.equal(o.limit, 5);
    assert.ok(o.filter.test('P1: MAIN RED — x'));
  });

  it('rejects a non-positive --limit rather than silently checking everything', () => {
    assert.throws(() => parseArgs(['--limit=0']), /positive integer/);
    assert.throws(() => parseArgs(['--limit=abc']), /positive integer/);
  });

  it('defaults to checking nothing destructively: no limit, no filter, not dry-run', () => {
    const o = parseArgs([]);
    assert.equal(o.limit, null);
    assert.equal(o.filter, null);
    assert.equal(o.dryRun, false);
  });
});
