import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractJobLines,
  findStrictGateSteps,
  hasBaselineDiffPath,
  hasScheduledFixWorkflow,
  evaluateGate,
  auditDataValidationGates,
} = require('./data-gate-heal-paths.js');

test('extractJobLines slices from the named job to the next top-level job key', () => {
  const yml = [
    'jobs:',
    '  unit-tests:',
    '    steps:',
    '      - run: echo one',
    '  data-validation:',
    '    steps:',
    '      - run: node scripts/foo.js --gate',
    '  e2e-tests:',
    '    steps:',
    '      - run: echo two',
  ].join('\n');
  const lines = extractJobLines(yml, 'data-validation');
  assert.equal(lines[0], '  data-validation:');
  assert.ok(lines.some((l) => l.includes('scripts/foo.js')));
  assert.ok(!lines.some((l) => l.includes('echo one')));
  assert.ok(!lines.some((l) => l.includes('echo two')));
});

test('extractJobLines returns empty for a missing job', () => {
  assert.deepEqual(extractJobLines('jobs:\n  unit-tests:\n    steps: []\n', 'data-validation'), []);
});

test('findStrictGateSteps only matches --strict/--gate run lines, ignoring bare invocations', () => {
  const lines = [
    '  data-validation:',
    '    steps:',
    '      - name: Bare audit',
    '        run: node scripts/audit-bare.js',
    '      - name: Strict audit',
    '        run: node scripts/audit-strict.js --strict',
    '      - name: Gated audit',
    '        run: node scripts/audit-gated.js --gate --max=0',
  ];
  const gates = findStrictGateSteps(lines);
  assert.equal(gates.length, 2);
  assert.equal(gates[0].script, 'audit-strict');
  assert.equal(gates[1].script, 'audit-gated');
  assert.equal(gates[1].flags, '--gate --max=0');
});

test('findStrictGateSteps captures a heal-exempt reason from a comment between step start and run line', () => {
  const lines = [
    '  data-validation:',
    '    steps:',
    '      - name: Gated audit',
    '        if: always()',
    '        # heal-exempt: needs human judgment per hit',
    '        run: node scripts/audit-gated.js --gate',
  ];
  const gates = findStrictGateSteps(lines);
  assert.equal(gates.length, 1);
  assert.equal(gates[0].healExemptReason, 'needs human judgment per hit');
});

test('findStrictGateSteps does not leak a heal-exempt comment from a PRIOR step', () => {
  const lines = [
    '  data-validation:',
    '    steps:',
    '      - name: Unrelated exempt audit',
    '        # heal-exempt: unrelated reason',
    '        run: node scripts/audit-other.js --gate',
    '      - name: This one has no exemption',
    '        run: node scripts/audit-target.js --gate',
  ];
  const gates = findStrictGateSteps(lines);
  const target = gates.find((g) => g.script === 'audit-target');
  assert.equal(target.healExemptReason, null);
});

test('hasBaselineDiffPath matches a literal path and a path.join-built filename', () => {
  assert.equal(hasBaselineDiffPath("const P = 'data/audit/foo-baseline.json';"), true);
  assert.equal(
    hasBaselineDiffPath("const P = path.join(__dirname, '..', 'data', 'audit', 'foo-baseline.json');"),
    true
  );
  assert.equal(hasBaselineDiffPath('const P = path.join(__dirname, "..", "data", "audit", "foo.json");'), false);
  assert.equal(hasBaselineDiffPath(''), false);
});

test('hasScheduledFixWorkflow requires BOTH a schedule trigger and a non-comment fix-flag invocation, and excludes test.yml', () => {
  const scheduled = { filename: 'heal-foo.yml', content: 'on:\n  schedule:\n    - cron: "0 0 * * *"\nrun: node scripts/foo.js --fix\n' };
  const scheduledNoFix = { filename: 'monitor-foo.yml', content: 'on:\n  schedule:\n    - cron: "0 0 * * *"\nrun: node scripts/foo.js --strict\n' };
  const unscheduledWithFix = { filename: 'manual-foo.yml', content: 'on:\n  workflow_dispatch:\nrun: node scripts/foo.js --fix\n' };
  const commentedOut = { filename: 'commented-foo.yml', content: 'on:\n  schedule:\n    - cron: "0 0 * * *"\n# node scripts/foo.js --fix (manual only)\n' };
  const testYmlItself = { filename: 'test.yml', content: 'on:\n  schedule:\n    - cron: "0 0 * * *"\nrun: node scripts/foo.js --fix\n' };

  assert.equal(hasScheduledFixWorkflow('foo', [scheduled]), true);
  assert.equal(hasScheduledFixWorkflow('foo', [scheduledNoFix]), false);
  assert.equal(hasScheduledFixWorkflow('foo', [unscheduledWithFix]), false);
  assert.equal(hasScheduledFixWorkflow('foo', [commentedOut]), false);
  assert.equal(hasScheduledFixWorkflow('foo', [testYmlItself]), false);
  assert.equal(hasScheduledFixWorkflow('foo', [scheduledNoFix, unscheduledWithFix, scheduled]), true);
});

test('hasScheduledFixWorkflow recognizes --write as a fix flag (audit-cast-changes.js convention)', () => {
  const wf = { filename: 'heal-bar.yml', content: 'on:\n  schedule:\n    - cron: "0 0 * * *"\nrun: node scripts/bar.js --write\n' };
  assert.equal(hasScheduledFixWorkflow('bar', [wf]), true);
});

test('evaluateGate: baseline-diff path wins even if heal-exempt reason is also present', () => {
  const gate = { script: 'foo', flags: '--strict', healExemptReason: 'ignored' };
  const result = evaluateGate(gate, { scriptSource: "'foo-baseline.json'", workflowFiles: [] });
  assert.equal(result.compliant, true);
  assert.equal(result.healPath, 'baseline-diff');
});

test('evaluateGate: scheduled-fix-workflow path wins when no baseline', () => {
  const gate = { script: 'foo', flags: '--gate', healExemptReason: null };
  const wf = { filename: 'heal-foo.yml', content: 'on:\n  schedule:\n    - cron: "0 0 * * *"\nrun: node scripts/foo.js --fix\n' };
  const result = evaluateGate(gate, { scriptSource: '', workflowFiles: [wf] });
  assert.equal(result.compliant, true);
  assert.equal(result.healPath, 'scheduled-fix-workflow');
});

test('evaluateGate: heal-exempt reason is the last resort', () => {
  const gate = { script: 'foo', flags: '--gate', healExemptReason: 'needs human judgment' };
  const result = evaluateGate(gate, { scriptSource: '', workflowFiles: [] });
  assert.equal(result.compliant, true);
  assert.equal(result.healPath, 'heal-exempt: needs human judgment');
});

test('evaluateGate: no heal path at all is a violation', () => {
  const gate = { script: 'foo', flags: '--gate', healExemptReason: null };
  const result = evaluateGate(gate, { scriptSource: '', workflowFiles: [] });
  assert.equal(result.compliant, false);
  assert.equal(result.healPath, null);
});

test('auditDataValidationGates: end-to-end against a small fixture workflow set', () => {
  const testYml = [
    'jobs:',
    '  data-validation:',
    '    steps:',
    '      - name: Baselined audit',
    '        run: node scripts/audit-baselined.js --strict',
    '      - name: Scheduled-heal audit',
    '        run: node scripts/audit-scheduled.js --gate',
    '      - name: Exempted audit',
    '        # heal-exempt: contamination guard, needs human judgment',
    '        run: node scripts/audit-exempted.js --gate',
    '      - name: New unhealed audit',
    '        run: node scripts/audit-new.js --gate',
    '  unit-tests:',
    '    steps:',
    '      - run: echo unrelated',
  ].join('\n');
  const sources = {
    'audit-baselined': "path.join('data', 'audit', 'audit-baselined-baseline.json')",
    'audit-scheduled': '',
    'audit-exempted': '',
    'audit-new': '',
  };
  const readScriptSource = (name) => sources[name] || '';
  const workflowFiles = [
    { filename: 'heal-scheduled.yml', content: 'on:\n  schedule:\n    - cron: "0 0 * * *"\nrun: node scripts/audit-scheduled.js --fix\n' },
  ];

  const { gates, violations } = auditDataValidationGates(testYml, readScriptSource, workflowFiles);
  assert.equal(gates.length, 4);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].script, 'audit-new');
});
