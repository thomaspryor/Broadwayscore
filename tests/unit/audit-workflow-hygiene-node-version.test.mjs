// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — the detector under test
// never reads data/*.json; it only parses workflow YAML text.
/**
 * Unit tests for findEolNodeVersions (rule (ac), BRO-6398): no runner pins a
 * Node line below NODE_MIN_MAJOR (22). Node 20 is EOL and missed the
 * 2026-10-21 security release. Pattern: require() the real function (CLAUDE.md
 * rule 15). The last test sweeps the real .github (workflows AND composites).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findEolNodeVersions, NODE_MIN_MAJOR } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');
const ROOT = path.resolve(import.meta.dirname, '../..');

describe('findEolNodeVersions', () => {
  test('flags 20 in every quoting style, 20.x, v20, a matrix list item and 18', () => {
    const raw = `  node-version: '20'\n  node-version: "20"\n  node-version: 20\n  node-version: 20.x\n  node-version: v20\n  - node-version: '20.11'\n  node-version: 18.19.0\n`;
    assert.deepEqual(findEolNodeVersions(raw).map((h) => h.major), [20, 20, 20, 20, 20, 20, 18]);
  });
  test(`accepts ${NODE_MIN_MAJOR} and newer, and node-version-file`, () => {
    assert.equal(findEolNodeVersions(`  node-version: '22'\n  node-version: 24\n  node-version-file: .nvmrc\n`).length, 0);
  });
  test('ignores commented-out lines', () => {
    assert.equal(findEolNodeVersions(`  # node-version: '20'\n`).length, 0);
  });
  test('no file under .github pins a Node line below the minimum', () => {
    const files = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.ya?ml$/.test(e.name)) files.push(p);
    });
    walk(path.join(ROOT, '.github/workflows'));
    walk(path.join(ROOT, '.github/actions'));
    const offenders = files.filter((f) => {
      const raw = fs.readFileSync(f, 'utf8');
      return !raw.includes('hygiene-node-ok:') && findEolNodeVersions(raw).length > 0;
    }).map((f) => path.relative(ROOT, f));
    assert.deepEqual(offenders, []);
  });
});
