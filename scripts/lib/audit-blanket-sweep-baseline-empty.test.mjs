// BRO-4751: the blanket-sweep audit baseline is burned down to zero. Every
// remaining unregistered data/audit write ahead of a blanket stage-data-changes.sh
// sweep must carry a step-level `# blanket-sweep-audit-ok: <path> <reason>`,
// so the next one is a visible decision in the workflow, not a baseline entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BASELINE, auditAllWorkflows, auditBlanketSweeps } = require('./audit-blanket-sweep-audit-writes.js');

test('BASELINE is empty (shrink-only list stays at zero)', () => {
  assert.equal(BASELINE.size, 0, `re-baselined: ${[...BASELINE].join(', ')}`);
});

test('no unexempt finding exists in the real workflows', () => {
  const f = auditAllWorkflows();
  assert.deepEqual(f.map((x) => `${x.file}|${x.path}`), []);
});

test('an unexempt write is found, an annotated one is not (annotation form the workflows use)', () => {
  const wf = (extra) => `name: t\njobs:\n  j:\n    steps:\n      - name: W\n        run: |\n${extra}          node scripts/validate-data.js\n      - name: C\n        run: |\n          bash scripts/lib/stage-data-changes.sh\n`;
  const opts = { readSrc: () => "fs.writeFileSync(path.join(DATA_DIR, 'audit', 'tony-coverage-gaps.json'), x)", isIgnored: () => false };
  const bad = auditBlanketSweeps(wf(''), 't.yml', opts);
  assert.ok(bad.some((x) => x.path === 'data/audit/tony-coverage-gaps.json'));
  const ok = auditBlanketSweeps(wf('          # blanket-sweep-audit-ok: data/audit/tony-coverage-gaps.json reason\n'), 't.yml', opts);
  assert.ok(!ok.some((x) => x.path === 'data/audit/tony-coverage-gaps.json'));
});
