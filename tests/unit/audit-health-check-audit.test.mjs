// BRO-2199: every health-check.js row that reads a gitignored/per-machine
// ledger must either be folded locally in send-morning-digest.js or carry an
// explicit CI-ONLY-OK justification, so a CI-blind 'error' (task #1648's bug)
// cannot be added silently. Reads the real sources; no logic is copied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const healthSrc = readFileSync(path.join(root, 'scripts/health-check.js'), 'utf8');
const digestSrc = readFileSync(path.join(root, 'scripts/send-morning-digest.js'), 'utf8');

const AUDITED = [
  { fn: 'checkPushRetryDeadman', disposition: 'ci-only' },
  { fn: 'checkInfraReviewGate', disposition: 'ci-only' },
  { fn: 'checkAutofixCanary', disposition: 'fold', digestTokens: ['assessCanaryRow', 'autofix-canary-ledger.jsonl'] },
  { fn: 'checkAutofixThroughput', disposition: 'fold', digestTokens: ['assessThroughputRow', 'digest-autofix-ledger.jsonl', 'backlog-drain-ledger.jsonl'] },
];

for (const { fn, disposition, digestTokens } of AUDITED) {
  test(`${fn}: ${disposition} is implemented and documented`, () => {
    assert.ok(healthSrc.includes(`function ${fn}(`), `${fn} no longer exists in health-check.js; update the audit table`);
    if (disposition === 'fold') {
      assert.ok(healthSrc.includes(`LOCAL-FOLD(${fn})`), `${fn}: missing LOCAL-FOLD marker in health-check.js`);
      for (const t of digestTokens) {
        assert.ok(digestSrc.includes(t), `${fn}: send-morning-digest.js has no local fold (missing "${t}")`);
      }
    } else {
      const m = healthSrc.match(new RegExp(`CI-ONLY-OK\\(${fn}\\):([^]*?)\\nfunction ${fn}\\(`));
      assert.ok(m, `${fn}: missing CI-ONLY-OK(${fn}) justification directly above the function`);
      assert.ok(m[1].trim().length > 80, `${fn}: CI-ONLY-OK justification too short to be real`);
    }
  });
}

test('folded checks are CI-skipped (return [] when isCI)', () => {
  const require = createRequire(import.meta.url);
  const hc = require(path.join(root, 'scripts/health-check.js'));
  assert.deepEqual(hc.checkAutofixCanary(true), []);
  assert.deepEqual(hc.checkAutofixThroughput(true), []);
});

test('infra-review digest never returns error (the premise of its CI-ONLY-OK)', () => {
  const require = createRequire(import.meta.url);
  const { computeInfraReviewDigest } = require(path.join(root, 'scripts/lib/infra-review-digest.js'));
  const now = Date.now();
  const gateEvents = Array.from({ length: 50 }, () => ({ ts: new Date(now).toISOString(), tier: 'critical', action: 'warn', reason: 'NO-PLAN-REVIEW: x' }));
  assert.equal(computeInfraReviewDigest({ gateEvents, planVerdicts: [], now }).status, 'warn');
});
