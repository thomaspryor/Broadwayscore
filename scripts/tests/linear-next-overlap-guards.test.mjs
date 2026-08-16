// Acceptance test for task #1696 — linear-next.js had zero cross-task
// duplicate-dispatch protection: dispatch-guards.js's exactTitleOverlapGuard
// and sessionTrackingCloneGuard (added for bsc-next.js by task #1672) were
// never wired into the Linear-issue dispatcher, so two different Linear
// issues (or a Linear issue + a Notion-mirror task) describing the same
// underlying work could both be dispatched with nothing to catch it.
//
// Per CLAUDE.md rule 15 the decision logic is NOT copied here: every
// assertion runs the real exported wiring from scripts/linear-next.js, so a
// regression in the production wiring (not just the underlying guards, which
// have their own coverage via bsc-next.js) fails this test.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const {
  buildOverlapComparisonPool,
  checkLinearOverlapGuards,
} = require(path.join(REPO, 'scripts', 'linear-next.js'));

describe('buildOverlapComparisonPool', () => {
  test('includes live (started) Linear issues, excludes the dispatch\'s own issue', () => {
    const pool = buildOverlapComparisonPool(
      [
        { identifier: 'BRO-1', title: 'Live issue', description: 'x', state: { type: 'started' } },
        { identifier: 'BRO-2', title: 'Backlog issue', description: 'y', state: { type: 'unstarted' } },
        { identifier: 'BRO-3', title: 'This dispatch itself', description: 'z', state: { type: 'started' } },
      ],
      [],
      'BRO-3',
    );
    assert.deepStrictEqual(pool.map((c) => c.id), ['BRO-1']);
    assert.strictEqual(pool[0].status, 'in_progress');
  });

  test('includes in_progress Notion-mirror tasks, excludes pending/completed ones', () => {
    const pool = buildOverlapComparisonPool(
      [],
      [
        { id: 10, subject: 'A', description: '', status: 'in_progress' },
        { id: 11, subject: 'B', description: '', status: 'pending' },
        { id: 12, subject: 'C', description: '', status: 'completed' },
      ],
      'BRO-99',
    );
    assert.deepStrictEqual(pool.map((c) => c.id), [10]);
  });

  test('combines both pools (a duplicate can live on either side of the Notion<->Linear mirror)', () => {
    const pool = buildOverlapComparisonPool(
      [{ identifier: 'BRO-1', title: 'Linear-side', description: '', state: { type: 'started' } }],
      [{ id: 10, subject: 'Notion-side', description: '', status: 'in_progress' }],
      'BRO-99',
    );
    assert.strictEqual(pool.length, 2);
    assert.ok(pool.some((c) => c.id === 'BRO-1'));
    assert.ok(pool.some((c) => c.id === 10));
  });
});

describe('checkLinearOverlapGuards — exact-title duplicate (task #1672 class)', () => {
  test('refuses a Linear issue whose title exactly matches a live Linear issue', () => {
    const pool = buildOverlapComparisonPool(
      [{ identifier: 'BRO-9', title: 'Extract pushCookieSecretWithMeta() helper for reuse', description: '', state: { type: 'started' } }],
      [],
      'BRO-10',
    );
    const { refusal } = checkLinearOverlapGuards(
      { id: 'linear:BRO-10', subject: 'Extract pushCookieSecretWithMeta() helper for reuse', description: '' },
      pool,
      {},
    );
    assert.match(refusal, /REFUSING to dispatch #linear:BRO-10/);
    assert.match(refusal, /BRO-9/);
  });

  test('refuses a Linear issue whose title exactly matches an in_progress Notion-mirror task', () => {
    const pool = buildOverlapComparisonPool(
      [],
      [{ id: 1662, subject: 'Extract pushCookieSecretWithMeta() helper for reuse', description: '', status: 'in_progress' }],
      'BRO-10',
    );
    const { refusal } = checkLinearOverlapGuards(
      { id: 'linear:BRO-10', subject: 'Extract pushCookieSecretWithMeta() helper for reuse', description: '' },
      pool,
      {},
    );
    assert.match(refusal, /REFUSING to dispatch #linear:BRO-10/);
    assert.match(refusal, /1662/);
  });

  test('does not refuse on a short/coincidental title match', () => {
    const pool = buildOverlapComparisonPool(
      [{ identifier: 'BRO-9', title: 'Fix bug', description: '', state: { type: 'started' } }],
      [],
      'BRO-10',
    );
    const { refusal } = checkLinearOverlapGuards(
      { id: 'linear:BRO-10', subject: 'Fix bug', description: '' },
      pool,
      {},
    );
    assert.strictEqual(refusal, null);
  });

  test('non-blocking similar-title overlap warns but does not refuse', () => {
    const pool = buildOverlapComparisonPool(
      [{ identifier: 'BRO-9', title: 'Extract pushCookieSecretWithMeta() helper for reuse across scrapers everywhere', description: '', state: { type: 'started' } }],
      [],
      'BRO-10',
    );
    const { refusal, warnings } = checkLinearOverlapGuards(
      { id: 'linear:BRO-10', subject: 'Extract pushCookieSecretWithMeta() helper for reuse across scrapers', description: '' },
      pool,
      {},
    );
    assert.strictEqual(refusal, null);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /near-identical title/);
  });
});

describe('checkLinearOverlapGuards — session-tracking clone (task #1672 defect 2)', () => {
  test('refuses a Linear issue that self-declares as a clone of a live Notion-mirror parent', () => {
    const pool = buildOverlapComparisonPool(
      [],
      [{ id: 1660, subject: 'Fix the underlying bug', description: '', status: 'in_progress' }],
      'BRO-20',
    );
    const { refusal } = checkLinearOverlapGuards(
      { id: 'linear:BRO-21', subject: 'Session tracking for the fix', description: 'Working parent card (P1 #1660)' },
      pool,
      {},
    );
    assert.match(refusal, /REFUSING to dispatch #linear:BRO-21/);
    assert.match(refusal, /session-tracking clone/);
    assert.match(refusal, /1660/);
  });

  test('does not refuse when the referenced parent is not live (finished/unresolved)', () => {
    const pool = buildOverlapComparisonPool(
      [],
      [{ id: 1660, subject: 'Fix the underlying bug', description: '', status: 'completed' }],
      'BRO-20',
    );
    const { refusal } = checkLinearOverlapGuards(
      { id: 'linear:BRO-21', subject: 'Session tracking for the fix', description: 'Working parent card (P1 #1660)' },
      pool,
      {},
    );
    assert.strictEqual(refusal, null);
  });

  // Second-opinion review, task #1696: confirms buildOverlapComparisonPool
  // correctly normalizes a live Linear issue's pool entry to
  // status: 'in_progress' (dispatch-guards.js's LIVE_TASK_STATUSES only ever
  // recognizes that literal string, not Linear's raw 'started' state.type).
  // sessionTrackingCloneGuard's own extractCloneParentRef only resolves a
  // bare `#<digits>` or a `[notion:<uuid>]`-shaped reference (dispatch-
  // guards.js's own "per\s+(?:task|card)\s*#\d+" / UUID regex) — never a
  // Linear identifier like "BRO-9" — so a clone-phrase naming a live LINEAR
  // parent by its own identifier is a documented, pre-existing gap in the
  // reused guard, not something task #1696 introduces or is scoped to close.
  // exactTitleOverlapGuard still catches the SAME pairing when the titles
  // are byte-for-byte duplicates (a separate, already-tested guard), so the
  // combined wiring is not blind to this case even though the clone guard
  // alone is.
  test('a clone-phrase naming a live Linear parent by identifier is not caught by the clone guard, but an exact-title duplicate between the two still refuses via the title guard', () => {
    const pool = buildOverlapComparisonPool(
      [{ identifier: 'BRO-9', title: 'Fix the underlying bug', description: '', state: { type: 'started' } }],
      [],
      'BRO-21',
    );
    assert.strictEqual(pool[0].status, 'in_progress');

    const clonePhraseOnly = checkLinearOverlapGuards(
      { id: 'linear:BRO-21', subject: 'Session tracking for BRO-9', description: 'session-tracking card for BRO-9' },
      pool,
      {},
    );
    assert.strictEqual(clonePhraseOnly.refusal, null);

    const exactTitleDup = checkLinearOverlapGuards(
      { id: 'linear:BRO-21', subject: 'Fix the underlying bug', description: 'session-tracking card for BRO-9' },
      pool,
      {},
    );
    assert.match(exactTitleDup.refusal, /exact match/);
  });
});

describe('checkLinearOverlapGuards — bypasses', () => {
  test('--force bypasses both the exact-title and clone refusals', () => {
    const pool = buildOverlapComparisonPool(
      [{ identifier: 'BRO-9', title: 'Extract pushCookieSecretWithMeta() helper for reuse', description: '', state: { type: 'started' } }],
      [],
      'BRO-10',
    );
    const { refusal } = checkLinearOverlapGuards(
      { id: 'linear:BRO-10', subject: 'Extract pushCookieSecretWithMeta() helper for reuse', description: '' },
      pool,
      { force: true },
    );
    assert.strictEqual(refusal, null);
  });

  test('--dry-run bypasses the hard refusal but the overlap is still discoverable via warnings', () => {
    const pool = buildOverlapComparisonPool(
      [{ identifier: 'BRO-9', title: 'Extract pushCookieSecretWithMeta() helper for reuse', description: '', state: { type: 'started' } }],
      [],
      'BRO-10',
    );
    const { refusal, warnings } = checkLinearOverlapGuards(
      { id: 'linear:BRO-10', subject: 'Extract pushCookieSecretWithMeta() helper for reuse', description: '' },
      pool,
      { 'dry-run': true },
    );
    assert.strictEqual(refusal, null);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /exact title match/);
  });
});
