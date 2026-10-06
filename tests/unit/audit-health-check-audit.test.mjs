// BRO-2199: every health-check.js row that reads a gitignored/per-machine
// ledger must either be folded locally in send-morning-digest.js or carry an
// explicit CI-ONLY-OK justification, so a CI-blind 'error' (task #1648's bug)
// cannot be added silently. Reads the real sources; no logic is copied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const healthSrc = readFileSync(path.join(root, 'scripts/health-check.js'), 'utf8');
const digestSrc = readFileSync(path.join(root, 'scripts/send-morning-digest.js'), 'utf8');

// Anchored on the real fold code (a call plus the push into health.errors),
// not bare names: those also appear in imports and comments.
const AUDITED = [
  { fn: 'checkPushRetryDeadman', disposition: 'ci-only' },
  { fn: 'checkInfraReviewGate', disposition: 'ci-only' },
  { fn: 'checkDispatchOutcomes', disposition: 'ci-only' },
  { fn: 'checkAutofixCanary', disposition: 'fold', digestTokens: ['assessCanaryRow({', 'autofix-canary-ledger.jsonl\');', 'sections.health.errors.push'] },
  { fn: 'checkAutofixThroughput', disposition: 'fold', digestTokens: ['assessThroughputRow({ digestLedgerEntries: rows', 'throughputDeathMessage(t', 'BACKLOG_LEDGER_PATH = path.join'] },
  { fn: 'checkDigestInvariantFail', disposition: 'fold', digestTokens: ['assessDigestInvariantFailRow(entries)', 'digest-invariant-fail-ledger.jsonl\');'] },
  { fn: 'checkSharedCheckoutShallow', disposition: 'fold', digestTokens: ['shallowDigestRow({ fromDir: REPO })', 'sections.health.errors.push'] },
  { fn: 'checkDispatchHealth', disposition: 'fold', digestTokens: ['computeDispatchHealthDigest({ entries: dispatchEntries', 'computeHeadlessDispatchDigest({ entries: dispatchEntries', 'sections.health.errors.push'] },
];

// Guard for NEW rows: any check* function in health-check.js that reads a
// gitignored data/audit/*.jsonl must be in AUDITED above.
test('every check* reading a gitignored audit ledger is in the audit table', () => {
  const audited = new Set(AUDITED.map((a) => a.fn));
  const parts = healthSrc.split(/\n(?=(?:async )?function )/);
  const offenders = [];
  for (const body of parts) {
    const name = body.match(/^(?:async )?function (check\w+)\(/)?.[1];
    if (!name || audited.has(name)) continue;
    const ledgers = [...body.matchAll(/'([\w-]+\.jsonl)'/g)].map((m) => m[1])
      .filter((f) => body.includes('AUDIT_DIR') || body.includes("'audit'"));
    for (const f of new Set(ledgers)) {
      const ignored = spawnSync('git', ['check-ignore', '-q', `data/audit/${f}`], { cwd: root }).status === 0;
      if (ignored) offenders.push(`${name} reads gitignored data/audit/${f}`);
    }
  }
  assert.deepEqual(offenders, [], 'add each to AUDITED with a LOCAL-FOLD or CI-ONLY-OK marker (BRO-2199)');
});

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
  for (const n of [0, 1, 5, 500]) {
    const ev = Array.from({ length: n }, () => ({ ts: new Date(now).toISOString(), tier: 'shared', action: 'block', reason: 'x' }));
    assert.ok(['pass', 'warn'].includes(computeInfraReviewDigest({ gateEvents: ev, planVerdicts: [], now }).status));
  }
});
