// BRO-2718: verifies the Linear-side undispatchable-backlog remediation
// actually landed, the same way BRO-2188 verified the Notion side. Read-only
// against Linear (never calls writeReport) — a live network check, not a
// fixture test, because the thing being verified IS live Linear state.
//
// Deliberately NOT registered in test.yml's manifest/push-path allowlist:
// this asserts a FUTURE state (the backlog swept) and fails against today's
// real Linear board by design — wiring it into CI now would turn the suite
// red for something no code change fixes. It exists to be run directly as
// BRO-2718's acceptance-criteria command once that sweep is done.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchLinearOpenIssuesWithDescriptions,
  evaluateLinearIssue,
} from '../audit-card-verifiability.js';

const REFUSED_RATIO_CEILING = 0.5; // BRO-2718 evidence: 84% refused (253/300) before remediation.

test('Linear backlog: refused ratio has materially improved and no shape/basename refusals remain', { timeout: 60_000 }, async () => {
  const issues = await fetchLinearOpenIssuesWithDescriptions();
  assert.ok(issues.length > 0, 'expected at least one open Linear issue to evaluate');

  const evaluated = issues.map(evaluateLinearIssue);
  const refused = evaluated.filter(e => !e.armed);
  const ratio = refused.length / evaluated.length;

  const shapeOrBasename = refused.filter(e => e.kind === 'shape' || e.kind === 'basename');

  assert.ok(
    ratio < REFUSED_RATIO_CEILING,
    `refused ratio ${(ratio * 100).toFixed(1)}% (${refused.length}/${evaluated.length}) is not materially below the pre-remediation 84% baseline`,
  );
  assert.equal(
    shapeOrBasename.length,
    0,
    `${shapeOrBasename.length} issue(s) still refused as shape/basename (a real command rejected by safe-form): ${shapeOrBasename.slice(0, 5).map(e => e.id).join(', ')}`,
  );
});
