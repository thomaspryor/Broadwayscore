// BRO-2688: no scripts/audit-*.js may be an unclassified orphan. Requires the
// real detector (CLAUDE.md §15). Lands as a baseline gate (rule 19): the
// scripts unwired today are listed with a bucket and reason; only a NEW
// unreferenced audit script fails.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { findUnreferencedAuditScripts, isPathTriggerLine } = require('../../scripts/lib/audit-script-wiring.js');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const baseline = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/lib/audit-script-wiring-baseline.json'), 'utf8')).entries;

function fixtureRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-wiring-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('every unreferenced scripts/audit-*.js is classified in the baseline', () => {
  const unlisted = findUnreferencedAuditScripts(REPO).filter((f) => !(f in baseline));
  assert.deepStrictEqual(unlisted, [], `New audit script(s) nothing runs: ${unlisted.join(', ')}. ` +
    'Wire each into a workflow (data-health-check.yml in shadow mode is the BRO-2620 pattern), or add it to ' +
    'scripts/lib/audit-script-wiring-baseline.json with bucket "b" and a reason, and a row in docs/triage-audit-scripts.md.');
});

test('every baseline entry is still unreferenced (delete wired ones)', () => {
  const found = findUnreferencedAuditScripts(REPO);
  const stale = Object.keys(baseline).filter((f) => !found.includes(f));
  assert.deepStrictEqual(stale, [], `Now wired or deleted, remove from the baseline and doc: ${stale.join(', ')}`);
});

test('baseline entries carry a bucket and reason, and appear in the triage doc', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs/triage-audit-scripts.md'), 'utf8');
  for (const [name, e] of Object.entries(baseline)) {
    assert.ok(['a', 'b', 'u'].includes(e.bucket), `${name}: bucket must be a, b or u`);
    assert.ok(typeof e.reason === 'string' && e.reason.length >= 20, `${name}: reason too short`);
    assert.ok(doc.includes(name), `${name} missing from docs/triage-audit-scripts.md`);
  }
});

test('detector: unreferenced audit is listed, workflow/code/package references clear it', () => {
  const root = fixtureRepo({
    'scripts/audit-orphan.js': '',
    'scripts/audit-in-workflow.js': '',
    'scripts/audit-in-package.js': '',
    'scripts/audit-in-lib.js': '',
    'scripts/audit-in-test-only.js': '',
    '.github/workflows/x.yml': 'steps:\n  - run: node scripts/audit-in-workflow.js\n',
    'package.json': '{"scripts":{"a":"node scripts/audit-in-package.js"}}',
    'scripts/runner.js': "require('./audit-in-lib.js')",
    'scripts/audit-in-test-only.test.mjs': "import './audit-in-test-only.js'",
  });
  assert.deepStrictEqual(findUnreferencedAuditScripts(root), ['audit-in-test-only.js', 'audit-orphan.js']);
});

test('detector: a test.yml path-trigger entry alone does not count as wiring', () => {
  const trigger = fixtureRepo({
    'scripts/audit-trigger-only.js': '',
    '.github/workflows/test.yml': "on:\n  push:\n    paths:\n      - 'scripts/audit-trigger-only.js'\n",
  });
  assert.deepStrictEqual(findUnreferencedAuditScripts(trigger), ['audit-trigger-only.js']);
  const ran = fixtureRepo({
    'scripts/audit-trigger-only.js': '',
    '.github/workflows/test.yml': "on:\n  push:\n    paths:\n      - 'scripts/audit-trigger-only.js'\njobs:\n  t:\n    steps:\n      - run: node scripts/audit-trigger-only.js\n",
  });
  assert.deepStrictEqual(findUnreferencedAuditScripts(ran), []);
  assert.strictEqual(isPathTriggerLine("      - 'scripts/x.js'"), true);
  assert.strictEqual(isPathTriggerLine('        run: node scripts/x.js'), false);
});

test('detector: comment-only and JSON-list mentions do not count as wiring', () => {
  const root = fixtureRepo({
    'scripts/audit-commented.js': '',
    'scripts/audit-json-listed.js': '',
    'scripts/lib/helper.js': '// pure helpers behind scripts/audit-commented.js\n',
    'scripts/lint-baseline.json': '["audit-json-listed.js"]',
    '.github/workflows/x.yml': 'steps:\n  # node scripts/audit-commented.js\n  - run: echo hi\n',
  });
  assert.deepStrictEqual(findUnreferencedAuditScripts(root), ['audit-commented.js', 'audit-json-listed.js']);
});
