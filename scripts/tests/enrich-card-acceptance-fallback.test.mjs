// Task #1713: enrich-card-acceptance.js failed 100% of cards on this machine
// because it only ever called ANTHROPIC_API_KEY, which is unset here, and a
// 100%-failure run still exited 0 — looking like a normal report. Also: the
// verify-gate safe-form allowlist rejected this repo's own standard
// validation entry points (shape-2 cards: a real command present, refused
// anyway), which is the OTHER half of why the backlog was stuck. This test
// require()s the real exported functions (CLAUDE.md rule 15) — no logic is
// re-implemented here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectProvider, allFailed, callLLM } = require('../enrich-card-acceptance.js');
const { isSafeCheckCommand } = require('../lib/verify-gate.js');

test('selectProvider: ANTHROPIC_API_KEY set → anthropic, regardless of what else is set', () => {
  assert.equal(selectProvider({ ANTHROPIC_API_KEY: 'x' }), 'anthropic');
  assert.equal(selectProvider({ ANTHROPIC_API_KEY: 'x', OPENROUTER_API_KEY: 'y', GEMINI_API_KEY: 'z' }), 'anthropic');
});

test('selectProvider: ANTHROPIC_API_KEY absent, OPENROUTER_API_KEY set → openrouter (this machine\'s actual case)', () => {
  assert.equal(selectProvider({ OPENROUTER_API_KEY: 'y' }), 'openrouter');
  assert.equal(selectProvider({ OPENROUTER_API_KEY: 'y', GEMINI_API_KEY: 'z' }), 'openrouter');
});

test('selectProvider: only GEMINI_API_KEY set → gemini', () => {
  assert.equal(selectProvider({ GEMINI_API_KEY: 'z' }), 'gemini');
});

test('selectProvider: no provider key set at all → null (the old throw-a-fatal-error case)', () => {
  assert.equal(selectProvider({}), null);
});

test('allFailed: every card failed → true (must exit non-zero)', () => {
  assert.equal(allFailed([{ action: 'failed' }, { action: 'failed' }]), true);
});

test('allFailed: at least one llm-enriched success → false', () => {
  assert.equal(allFailed([{ action: 'failed' }, { action: 'llm-enriched' }]), false);
});

// Adversarial-review finding: skipped/owner-judgment never call the LLM, so
// they can't be evidence the provider chain is healthy — 99 failed + 1
// skipped is still a 100%-of-attempted failure and must exit non-zero, not
// look like a passing run because one card never got attempted.
test('allFailed: every ATTEMPTED card failed, remainder were skipped/owner-judgment → true', () => {
  assert.equal(allFailed([{ action: 'failed' }, { action: 'skipped' }]), true);
  assert.equal(allFailed([{ action: 'failed' }, { action: 'failed' }, { action: 'owner-judgment' }]), true);
});

test('allFailed: nothing attempted at all (all skipped/owner-judgment) → false, not a failure', () => {
  assert.equal(allFailed([{ action: 'skipped' }, { action: 'owner-judgment' }]), false);
});

test('allFailed: empty batch → false (nothing to process is not a failure)', () => {
  assert.equal(allFailed([]), false);
});

// The real-world case that surfaced during implementation: OPENROUTER_API_KEY
// is present and valid but the account is out of funded credits (HTTP 402).
// callLLM must not stop at the first available provider — it must actually
// TRY the next one, not just pick a provider once via selectProvider.
test('callLLM: first available provider fails → falls through to the next, no ANTHROPIC_API_KEY needed', async () => {
  const calledOrder = [];
  const result = await callLLM('prompt text', {
    env: { OPENROUTER_API_KEY: 'or-key', GEMINI_API_KEY: 'gm-key' },
    callers: {
      openrouter: async () => { calledOrder.push('openrouter'); throw new Error('HTTP 402: needs more credits'); },
      gemini: async () => { calledOrder.push('gemini'); return 'drafted acceptance criteria text'; },
    },
  });
  assert.equal(result, 'drafted acceptance criteria text');
  assert.deepEqual(calledOrder, ['openrouter', 'gemini']);
});

test('callLLM: every available provider fails → throws with every provider\'s error folded in', async () => {
  await assert.rejects(
    () => callLLM('prompt text', {
      env: { OPENROUTER_API_KEY: 'or-key', GEMINI_API_KEY: 'gm-key' },
      callers: {
        openrouter: async () => { throw new Error('402 openrouter'); },
        gemini: async () => { throw new Error('404 gemini'); },
      },
    }),
    /openrouter: 402 openrouter.*gemini: 404 gemini/s,
  );
});

// Shape-2 regression: node scripts/validate-data.js was a REAL, correct
// verification command that audit-card-verifiability.js refused outright
// (three P0/P1 cards named it verbatim). It must now pass.
test('isSafeCheckCommand: widened allowlist accepts this repo\'s own validation entry points (shape-2 fix)', () => {
  assert.equal(isSafeCheckCommand('node scripts/validate-data.js'), true);
  assert.equal(isSafeCheckCommand('node scripts/validate-data.js --strict'), true);
  assert.equal(isSafeCheckCommand('node scripts/scoring-delta.js'), true);
  assert.equal(isSafeCheckCommand('node scripts/test-temporal-override-regression.js'), true);
  assert.equal(isSafeCheckCommand('node scripts/audit-stale-flag-after-url-correction.js --gate --max=0'), true);
  assert.equal(isSafeCheckCommand('node scripts/audit-help-flag-safety.js'), true);
  assert.equal(isSafeCheckCommand('node scripts/audit-workflow-hygiene.js'), true);
  assert.equal(isSafeCheckCommand('node scripts/audit-aggregator-archive-integrity.js --strict'), true);
  assert.equal(isSafeCheckCommand('node scripts/audit-sibling-title-misroute.js'), true);
  assert.equal(isSafeCheckCommand('node scripts/audit-orphan-tests.js'), true);
});

// The widening must stay narrow — bare-invocation-only scripts must not
// suddenly accept a mutating flag, and scoring-delta.js's --base= is a real
// shell-injection surface (execSync template interpolation) that must never
// be accepted from untrusted card notes.
test('isSafeCheckCommand: widened forms still refuse the mutating/injectable variants', () => {
  assert.equal(isSafeCheckCommand('node scripts/audit-sibling-title-misroute.js --fix'), false);
  assert.equal(isSafeCheckCommand('node scripts/audit-help-flag-safety.js --update-baseline'), false);
  assert.equal(isSafeCheckCommand('node scripts/scoring-delta.js --base=main; rm -rf /'), false);
  assert.equal(isSafeCheckCommand('node scripts/scoring-delta.js --base=main'), false);
  assert.equal(isSafeCheckCommand('node scripts/extract-show-score-reviews.js'), false);
});
