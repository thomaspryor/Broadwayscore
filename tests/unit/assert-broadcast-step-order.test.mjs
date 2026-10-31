// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — the regex-detector under
// test never reads data/*.json; workflow YAML appears only as synthetic
// fixtures and via the real opening-night-broadcast.yml structure check.
/**
 * Regression test for the same `^run:` anchor bug fixed in
 * scripts/audit-workflow-hygiene.js (task #1474): findNodeInstallLine used an
 * identical unfixed copy of the regex, which would have made it blind to a
 * `- run: npm ci` or `- run: |` list-item shorthand install step. Not
 * currently exercised by opening-night-broadcast.yml (no live workflow uses
 * the shorthand there today), but the same bug class — caught and fixed here
 * before it could bite, rather than after (task #1474 what-else pass).
 *
 * Pattern: require() the real function; never copy logic into tests
 * (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { findNodeInstallLine, findChecklistGateLine, findCheckoutLine } = require(
  '../../scripts/assert-broadcast-step-order.js',
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = path.join(__dirname, '..', '..', '.github', 'workflows', 'opening-night-broadcast.yml');

describe('findNodeInstallLine — inline `- run:` shorthand', () => {
  test('finds `- run: npm ci` list-item shorthand', () => {
    const lines = [
      'jobs:',
      '  broadcast:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - run: npm ci',
    ];
    const idx = findNodeInstallLine(lines);
    assert.strictEqual(idx, 4);
  });

  test('finds a `- run: |` block-scalar shorthand opener with npm ci inside', () => {
    const lines = [
      'jobs:',
      '  broadcast:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - run: |',
      '          npm ci',
      '          echo done',
    ];
    const idx = findNodeInstallLine(lines);
    assert.strictEqual(idx, 5);
  });

  test('still finds the standard `- name: X` + indented `run: |` style', () => {
    const lines = [
      'jobs:',
      '  broadcast:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - name: Install',
      '        run: |',
      '          npm ci',
    ];
    const idx = findNodeInstallLine(lines);
    assert.strictEqual(idx, 6);
  });

  test('still finds the setup-node composite action', () => {
    const lines = [
      'jobs:',
      '  broadcast:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: ./.github/actions/setup-node',
    ];
    const idx = findNodeInstallLine(lines);
    assert.strictEqual(idx, 4);
  });
});

describe('assert-broadcast-step-order against the real opening-night-broadcast.yml', () => {
  test('checkout < node install < checklist_gate holds on the live workflow', () => {
    const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const lines = raw.split('\n');
    const checkoutLine = findCheckoutLine(lines);
    const installLine = findNodeInstallLine(lines);
    const gateLine = findChecklistGateLine(lines);
    assert.notStrictEqual(checkoutLine, -1);
    assert.notStrictEqual(installLine, -1);
    assert.notStrictEqual(gateLine, -1);
    assert.ok(installLine >= checkoutLine, 'node install must not run before checkout');
    assert.ok(installLine <= gateLine, 'node install must run before checklist_gate');
  });
});
