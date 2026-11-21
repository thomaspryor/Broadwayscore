// BRO-6674: a workflow whose failure alert is severity low (digest only) let a real
// failure sit 2 days (BRO-6666). Each one must document why a silent 2-day failure is
// fine (`# severity-low-ok: <reason>`) or file a fix card (scripts/file-workflow-failure-card.js).
// Parsing lives in scripts/lib/low-severity-workflows.js (required here, not copied).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const lib = require('./lib/low-severity-workflows.js');
const cards = require('./lib/workflow-failure-card.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('every severity low workflow is justified or escalated', () => {
  const audit = lib.auditWorkflows(join(root, '.github/workflows'));

  test('finds the known low-severity workflows', () => {
    assert.ok(audit.length >= 10, `only ${audit.length} found; the parser likely broke`);
  });

  test('none is unresolved', () => {
    const bad = audit.filter((a) => a.status === 'unresolved').map((a) => a.file);
    assert.deepEqual(bad, [], `add "# severity-low-ok: <reason, ${lib.MIN_REASON}+ chars>" or a file-workflow-failure-card.js step to: ${bad.join(', ')}`);
  });

  test('every escalated workflow has a card definition', () => {
    for (const a of audit.filter((x) => x.status === 'escalated')) {
      const m = /file-workflow-failure-card\.js\s+([\w-]+)/.exec(
        require('node:fs').readFileSync(join(root, '.github/workflows', a.file), 'utf8'));
      assert.ok(m && cards.CARDS[m[1]], `${a.file} files a card with no definition in workflow-failure-card.js`);
    }
  });
});

describe('parser', () => {
  const step = (extra) => `      - name: Notify on failure\n        uses: ./.github/actions/notify-failure\n        with:\n          severity: 'low'\n${extra || ''}`;
  test('counts only YAML severity keys, not comments or strings', () => {
    assert.equal(lib.countLowSeverity(step()), 1);
    assert.equal(lib.countLowSeverity("# severity: low\nhint: `severity:low/email:false`"), 0);
    assert.equal(lib.countLowSeverity("          severity: 'warning'"), 0);
  });
  test('reason must be substantive', () => {
    assert.equal(lib.lowSeverityReason('# severity-low-ok: fine'), null);
    assert.ok(lib.lowSeverityReason('# severity-low-ok: manual dispatch only, the dispatcher watches the run'));
    assert.equal(lib.lowSeverityReason('hint: severity-low-ok: manual dispatch only, the dispatcher watches'), null);
  });
  test('escalation requires continue-on-error on the same step', () => {
    const run = '      - name: File card\n        continue-on-error: true\n        run: node scripts/file-workflow-failure-card.js x\n      - name: Next\n        run: echo';
    assert.equal(lib.hasEscalationStep(run), true);
    assert.equal(lib.hasEscalationStep(run.replace('continue-on-error: true', 'if: always()')), false);
    // continue-on-error on a neighbouring step must not count
    assert.equal(lib.hasEscalationStep('      - name: A\n        continue-on-error: true\n        run: echo\n      - name: B\n        run: node scripts/file-workflow-failure-card.js x'), false);
    assert.equal(lib.hasEscalationStep('        # run: node scripts/file-workflow-failure-card.js x'), false);
  });
});
