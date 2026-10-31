// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — the detector under test
// never reads data/*.json; it only parses workflow YAML text.
/**
 * Unit tests for findUnpinnedActionUses (rule (ab), BRO-6398): every external
 * `uses: owner/repo@ref` must pin a 40-hex commit SHA, never a movable tag.
 * Pattern: require() the real function (CLAUDE.md rule 15). The last test
 * sweeps the real .github (workflows AND composite actions).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findUnpinnedActionUses } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');
const ROOT = path.resolve(import.meta.dirname, '../..');
const SHA = 'fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09';

describe('findUnpinnedActionUses', () => {
  test('flags a tag pin and a branch pin, naming the action and ref', () => {
    const hits = findUnpinnedActionUses(`steps:\n  - uses: actions/checkout@v5\n  - uses: tj-actions/changed-files@main\n`);
    assert.deepEqual(hits.map((h) => [h.action, h.ref]), [['actions/checkout', 'v5'], ['tj-actions/changed-files', 'main']]);
    assert.equal(hits[0].lineNum, 2);
  });
  test('accepts a 40-hex sha with the tag kept as a comment, and sub-path actions', () => {
    assert.equal(findUnpinnedActionUses(`  - uses: actions/checkout@${SHA} # v5\n  - uses: actions/cache/restore@${SHA}\n`).length, 0);
  });
  test('rejects a short or uppercase sha', () => {
    assert.equal(findUnpinnedActionUses(`  - uses: actions/checkout@${SHA.slice(0, 7)}\n`).length, 1);
    assert.equal(findUnpinnedActionUses(`  - uses: actions/checkout@${SHA.toUpperCase()}\n`).length, 1);
  });
  test('flags a docker:// image by tag and accepts one pinned by digest', () => {
    const digest = 'a'.repeat(64);
    assert.deepEqual(findUnpinnedActionUses(`  - uses: docker://alpine:3.20\n`).map((h) => [h.action, h.ref]), [['docker://alpine', '3.20']]);
    assert.equal(findUnpinnedActionUses(`  - uses: docker://alpine@sha256:${digest}\n`).length, 0);
  });
  test('sees through YAML quotes around the reference', () => {
    assert.equal(findUnpinnedActionUses(`  - uses: "actions/checkout@v4"\n`).length, 1);
    assert.equal(findUnpinnedActionUses(`  - uses: 'actions/checkout@${SHA}' # v5\n`).length, 0);
  });
  test('ignores local composites and commented-out lines', () => {
    assert.equal(findUnpinnedActionUses(`  - uses: ./.github/actions/setup-node\n  # - uses: actions/checkout@v4\n`).length, 0);
  });
  test('every external action under .github is sha-pinned', () => {
    const files = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.ya?ml$/.test(e.name)) files.push(p);
    });
    walk(path.join(ROOT, '.github/workflows'));
    walk(path.join(ROOT, '.github/actions'));
    const offenders = files.filter((f) => {
      const raw = fs.readFileSync(f, 'utf8');
      return !raw.includes('hygiene-pin-ok:') && findUnpinnedActionUses(raw).length > 0;
    }).map((f) => path.relative(ROOT, f));
    assert.deepEqual(offenders, []);
  });
});
