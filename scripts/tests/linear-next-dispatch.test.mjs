// Acceptance test for BRO-2569 — no dispatcher path-checked the command it
// was about to run before this: evaluateVerifiability only validates a
// card's acceptance command SHAPE, never whether the paths it names exist on
// disk. BRO-2546 closed that hole for LLM-drafted acceptance criteria only
// (enrich-card-acceptance.js); a hand-written, imported, or plan-tasks-
// authored command reached both real dispatchers unchecked and could arm a
// card on a phantom path that can never pass (the #171 class).
//
// Per CLAUDE.md rule 15 the decision logic is NOT copied here: the pure
// halves (resolvePathCheck/pathVerifiabilityGuard) are require()'d from the
// real scripts/lib/dispatch-guards.js, and the end-to-end tests drive the
// real exported scripts/linear-next.js main() — same DI pattern already used
// throughout tests/unit/linear-next.test.mjs — so a regression in the
// production wiring, not just the underlying guard, fails this test.
import { test, describe, afterEach } from 'node:test';
// Same class as tests/unit/linear-next.test.mjs: this file stubs process.exit,
// but code under test can also signal failure with `process.exitCode = 1`,
// which a per-test finally cannot restore because it lives on the runner's own
// process. node --test then fails the whole FILE with no named failing subtest.
// Resetting after each test clears only that leak; a genuinely failing test
// still fails the file (verified).
afterEach(() => {
  process.exitCode = 0;
});

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { main } from '../linear-next.js';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { resolvePathCheck, pathVerifiabilityGuard } = require(path.join(REPO, 'scripts', 'lib', 'dispatch-guards.js'));

// A no-op Linear client for any main() test whose launch path reaches
// reportDispatchOnIssue() — without this, main()'s default `deps.linear`
// falls through to the REAL scripts/lib/linear-client.js and makes a genuine
// network call to the live Linear workspace (same invariant
// tests/unit/linear-next.test.mjs's own noopLinearDeps() protects — mirrored
// here rather than imported since it isn't exported from that test file).
function noopLinearDeps() {
  return {
    linear: {
      createComment: async () => {},
      getTeam: async () => ({ states: [] }),
      getIssue: async () => null,
      updateIssue: async () => {},
      TEAM_KEY: 'BRO',
    },
  };
}

// ── resolvePathCheck (pure over a gate + repoRoot) ──────────────────────────

describe('resolvePathCheck', () => {
  test('returns null when the gate has no command (unarmed or owner-judgment)', () => {
    assert.equal(resolvePathCheck({ cmd: null }, REPO), null);
    assert.equal(resolvePathCheck(null, REPO), null);
  });

  test('ok:true for a command naming a path whose parent directory exists (new-artifact allowance)', () => {
    // The exact fixture string reused as the synthetic "armed" acceptance
    // command across 9+ tests in tests/unit/linear-next.test.mjs — the file
    // itself does not exist on disk, but tests/unit/ does, so this MUST stay
    // ok:true or this guard would break every one of those existing tests.
    const result = resolvePathCheck({ cmd: 'node --test tests/unit/some-fixture.test.mjs' }, REPO);
    assert.equal(result.ok, true);
  });

  test('ok:false for a command naming a path inside a directory that does not exist (the #171 phantom class)', () => {
    const result = resolvePathCheck({ cmd: 'node --test tests/nosuchdir-bro2569/ghost.test.mjs' }, REPO);
    assert.equal(result.ok, false);
    assert.match(result.reason, /does not exist on disk/);
  });

  test('ok:true + corrected:true for a near-match rewrite (a real file exists at the corrected path)', () => {
    // tests/plan-ready.test.mjs does not exist; tests/unit/plan-ready.test.mjs
    // does — this is BRO-2546's own near-match correction, card #171's class.
    const result = resolvePathCheck({ cmd: 'node --test tests/plan-ready.test.mjs' }, REPO);
    assert.equal(result.ok, true);
    assert.equal(result.corrected, true);
    assert.equal(result.checkableDone, 'node --test tests/unit/plan-ready.test.mjs');
  });
});

// ── pathVerifiabilityGuard (pure over a pre-computed pathCheck + opts) ─────

describe('pathVerifiabilityGuard', () => {
  test('passes when pathCheck is null (nothing to check)', () => {
    assert.equal(pathVerifiabilityGuard({ id: 't1' }, null, {}), null);
  });

  test('passes when pathCheck.ok is true and uncorrected', () => {
    assert.equal(pathVerifiabilityGuard({ id: 't1' }, { ok: true, corrected: false }, {}), null);
  });

  test('refuses when pathCheck.ok is true but corrected — a dispatcher must not record a different command than the one it checked (Codex adversarial review, BRO-2569)', () => {
    const err = pathVerifiabilityGuard(
      { id: 'linear:BRO-2569' },
      { ok: true, corrected: true, checkableDone: 'node --test tests/unit/plan-ready.test.mjs' },
      {},
    );
    assert.match(err, /REFUSING to dispatch #linear:BRO-2569/);
    assert.match(err, /tests\/unit\/plan-ready\.test\.mjs/);
    assert.match(err, /--allow-phantom-path/);
  });

  test('a corrected refusal is bypassed by the same flags as a not-ok refusal', () => {
    const pathCheck = { ok: true, corrected: true, checkableDone: 'node --test tests/unit/plan-ready.test.mjs' };
    assert.equal(pathVerifiabilityGuard({ id: 't1' }, pathCheck, { force: true }), null);
    assert.equal(pathVerifiabilityGuard({ id: 't1' }, pathCheck, { 'allow-phantom-path': true }), null);
  });

  test('refuses when pathCheck.ok is false, naming the reason and the task id', () => {
    const err = pathVerifiabilityGuard({ id: 'linear:BRO-2569' }, { ok: false, reason: 'checkableDone references a path in a directory that does not exist on disk: tests/nosuchdir-bro2569/ghost.test.mjs' }, {});
    assert.match(err, /REFUSING to dispatch #linear:BRO-2569/);
    assert.match(err, /tests\/nosuchdir-bro2569\/ghost\.test\.mjs/);
    assert.match(err, /--allow-phantom-path/);
  });

  for (const bypass of ['force', 'allow-phantom-path', 'dry-run', 'print-prompt']) {
    test(`--${bypass} bypasses the refusal`, () => {
      const opts = { [bypass]: true };
      assert.equal(pathVerifiabilityGuard({ id: 't1' }, { ok: false, reason: 'x' }, opts), null);
    });
  }

  test('--allow-unverifiable does NOT bypass a phantom-path refusal (distinct flag, distinct meaning)', () => {
    const err = pathVerifiabilityGuard({ id: 't1' }, { ok: false, reason: 'x' }, { 'allow-unverifiable': true });
    assert.match(err, /REFUSING/);
  });
});

// ── end-to-end: the real linear-next.js main() (BRO-2569 wiring) ──────────

function makePhantomPathIssue() {
  return {
    id: 'issue-uuid-2569', identifier: 'BRO-25690', title: 'Some issue with a phantom acceptance path',
    description: '## Acceptance criteria\n`node --test tests/nosuchdir-bro2569/ghost.test.mjs`',
    url: 'https://linear.app/broadway-scorecard/issue/BRO-25690/some-issue',
    priority: 2,
    state: { id: 'state-1', name: 'Todo', type: 'unstarted' },
    labels: { nodes: [] }, comments: { nodes: [] },
  };
}

test('main(): refuses to dispatch an issue whose acceptance command names a phantom path (BRO-2569)', async () => {
  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => { exitCode = code; throw new Error('EXIT'); };
  const origError = console.error;
  const errors = [];
  console.error = (msg) => errors.push(String(msg));
  try {
    await assert.rejects(() => main(['--id', 'BRO-25690'], {
      getIssue: async () => makePhantomPathIssue(),
      launchCmux: () => { throw new Error('launchCmux must not be called'); },
      appendLedgerEntry: () => { throw new Error('appendLedgerEntry must not be called for a phantom-path issue'); },
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
      // Task #1898: without this, main() (no --force here) falls through to
      // the REAL acquireClaim(DISPATCH_CLAIM_DIR, ...) and touches
      // data/audit/linear-dispatch-claims/BRO-25690.claim/ on disk — a stray
      // leftover claim dir (from a prior local run, or a concurrent process
      // touching the same path in CI) makes acquireClaim() return 'error'
      // instead of true, which fails BEFORE the phantom-path check this test
      // is actually about ever runs. Every sibling test in this file that
      // reaches main() without --force/--dry-run mocks this same way.
      acquireDispatchClaim: () => true,
      releaseDispatchClaim: () => {},
    }), /EXIT/);
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
  assert.equal(exitCode, 1);
  assert.match(errors.join('\n'), /can never pass/);
  assert.match(errors.join('\n'), /tests\/nosuchdir-bro2569\/ghost\.test\.mjs/);
});

test('main(): --allow-phantom-path overrides the refusal and proceeds to launch', async () => {
  const origError = console.error;
  console.error = () => {};
  let launched = false;
  try {
    await main(['--id', 'BRO-25690', '--allow-phantom-path', '--force'], {
      getIssue: async () => makePhantomPathIssue(),
      launchCmux: () => { launched = true; return { ok: true, ref: 'workspace:1', adoptedLate: false }; },
      cmuxAvailable: () => false,
      readLedgerEntries: () => [],
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
      ...noopLinearDeps(),
    });
  } finally {
    console.error = origError;
  }
  assert.equal(launched, true);
});

test('main(): --dry-run skips the phantom-path check entirely, even for an issue whose command IS phantom (no fs I/O for a preview)', async () => {
  const origLog = console.log;
  const logs = [];
  console.log = (msg) => logs.push(msg);
  try {
    await main(['--id', 'BRO-25690', '--dry-run'], {
      getIssue: async () => makePhantomPathIssue(),
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    });
  } finally {
    console.log = origLog;
  }
  assert.match(logs.join('\n'), /would launch/);
});

test('main(): an issue with a real/creatable acceptance path is unaffected by the guard (dry-run reaches the seed print)', async () => {
  const origLog = console.log;
  const logs = [];
  console.log = (msg) => logs.push(msg);
  try {
    await main(['--id', 'BRO-25690', '--dry-run'], {
      getIssue: async () => ({
        ...makePhantomPathIssue(),
        description: '## Acceptance criteria\n`node --test tests/unit/some-fixture.test.mjs`',
      }),
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    });
  } finally {
    console.log = origLog;
  }
  assert.match(logs.join('\n'), /would launch/);
});
