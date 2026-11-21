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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { selectAuditableCards, classifyPremiseOutcome, assessCheckoutData, parseArgs, REQUIRED_CORPORA } =
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
  it('a pass on a data-complete checkout means the filed-for state is already reached', () => {
    assert.equal(
      classifyPremiseOutcome({ status: 'pass', detail: null }, { dataComplete: true }).verdict,
      'premise-stale-candidate'
    );
  });

  // THE SECOND LOAD-BEARING ASSERTION, and the one two independent reviewers
  // converged on. A command that SCANS a corpus exits 0 when the corpus is
  // absent, without examining anything — indistinguishable in the exit code
  // from a real pass. A fresh checkout never has data/review-texts. Nominating
  // that as stale is how a REAL, unfixed bug gets closed, so a pass from an
  // incomplete checkout must land in the weaker bucket, not the actionable one.
  it('a pass on an INCOMPLETE checkout is never nominated as a stale candidate', () => {
    const out = classifyPremiseOutcome({ status: 'pass', detail: null }, { dataComplete: false });
    assert.equal(out.verdict, 'premise-stale-unconfirmed');
    assert.notEqual(out.verdict, 'premise-stale-candidate');
  });

  it('an unknown dataComplete does not silently downgrade a pass', () => {
    assert.equal(classifyPremiseOutcome({ status: 'pass' }).verdict, 'premise-stale-candidate');
    assert.equal(classifyPremiseOutcome({ status: 'pass' }, {}).verdict, 'premise-stale-candidate');
  });

  // Deliberately NOT called 'premise-live'. Measured on BRO-2356: its command
  // failed in the fresh checkout with "scanned 0 review files — data/review-texts
  // is missing or empty" while passing on a main checkout, because the detached
  // checkout carries no private-repo data. The tool cannot tell a live premise
  // from an unprepared checkout, so the verdict must not claim to.
  it('a fail is reported as still-failing, never as a claim about the premise', () => {
    const out = classifyPremiseOutcome({ status: 'fail', detail: 'assertion failed' });
    assert.equal(out.verdict, 'still-failing');
    assert.notEqual(out.verdict, 'premise-stale-candidate');
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

describe('assessCheckoutData', () => {
  it('an empty directory is incomplete, and names every missing corpus', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premise-empty-'));
    try {
      const out = assessCheckoutData(dir);
      assert.equal(out.complete, false);
      assert.deepEqual(out.missing, REQUIRED_CORPORA);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a corpus directory that EXISTS but is EMPTY still counts as missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premise-hollow-'));
    try {
      for (const rel of REQUIRED_CORPORA) fs.mkdirSync(path.join(dir, rel), { recursive: true });
      const out = assessCheckoutData(dir);
      // This is the whole point: `git checkout` can leave an empty directory,
      // and "the path exists" would report a hollow checkout as complete.
      assert.equal(out.complete, false);
      assert.deepEqual(out.missing, REQUIRED_CORPORA);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a checkout carrying all corpora with content is complete', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premise-full-'));
    try {
      for (const rel of REQUIRED_CORPORA) {
        fs.mkdirSync(path.join(dir, rel), { recursive: true });
        fs.writeFileSync(path.join(dir, rel, 'x.json'), '{}');
      }
      const out = assessCheckoutData(dir);
      assert.equal(out.complete, true);
      assert.deepEqual(out.missing, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a nonexistent path is incomplete rather than throwing mid-audit', () => {
    const out = assessCheckoutData('/definitely/not/a/real/path/xyz');
    assert.equal(out.complete, false);
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

  // A silently-ignored flag is the expensive kind of typo here: `--dryrun` or
  // `--limit 10` (space, not `=`) would run the FULL audit — a subprocess per
  // armed open card — when the caller asked for a cheap preview.
  it('refuses an unknown flag instead of silently running the full audit', () => {
    assert.throws(() => parseArgs(['--dryrun']), /unknown argument/);
    assert.throws(() => parseArgs(['--limit', '10']), /unknown argument/);
  });
});
