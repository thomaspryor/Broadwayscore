// BRO-267: the race was already fixed by BRO-2670's serialized writer.
// Exercise that production contract and the swallowed-writer detector here.
// Repository-wide debt still requires the separate swallowed-audit-writers
// lint command; passing this regression suite does not certify that debt is zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { findEntry } = require('../../scripts/lib/core-data-merge-registry.js');
const { checkEntry, extractConcurrencyGroup } = require('../../scripts/lib/api-fallback-writer-drift.js');
const { findSwallowedAuditWriters, splitSteps } = require('../../scripts/lib/swallowed-audit-writer-check.js');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowDir = path.join(repo, '.github/workflows');
const workflows = Object.fromEntries(fs.readdirSync(workflowDir)
  .filter(name => /\.ya?ml$/.test(name))
  .map(name => [name, fs.readFileSync(path.join(workflowDir, name), 'utf8')]));
const checklist = workflows['opening-night-checklist.yml'];
const runStep = splitSteps(checklist)
  .find(lines => lines[0].trim() === '- name: Run opening night checklist').join('\n');
const isAuditWriter = script => fs.readFileSync(path.join(repo, script), 'utf8').includes('data/audit/');

for (const file of ['audit/opening-night-history.json', 'audit/opening-night-sla-state.json', 'audit/remediation-log.jsonl']) {
  test(`${file}: all committing callers use the registered serialization group`, () => {
    const entry = findEntry(file, 'public-repo');
    assert.equal(entry?.apiFallbackSafe, true);
    assert.equal(entry.concurrencyGroup, 'opening-night-checklist');
    const result = checkEntry(entry, workflows);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.writers, ['opening-night-checklist.yml']);
    assert.equal(extractConcurrencyGroup(checklist), entry.concurrencyGroup);
    assert.match(checklist, /^concurrency:\s*\n\s+group: opening-night-checklist\s*\n\s+cancel-in-progress: false/m);

    // Reintroducing the card's original per-run group must fail verification.
    const overlapping = checklist.replace(/^  group: opening-night-checklist$/m, '  group: opening-night-checklist-${{ github.run_id }}');
    assert.equal(extractConcurrencyGroup(overlapping), null);
    // A new independent committer must invalidate the whole-file fallback.
    assert.equal(checkEntry(entry, { ...workflows, 'second-writer.yml': `jobs:\n  write:\n    steps:\n      - run: git add data/${file}\n` }).ok, false);
  });
}

test('real checklist caller is clean; both swallow mechanisms require explicit exemptions', () => {
  assert.equal(isAuditWriter('scripts/opening-night-checklist.js'), true);
  assert.deepEqual(findSwallowedAuditWriters(runStep, isAuditWriter), []);
  for (const command of [
    '        continue-on-error: true\n        run: node scripts/opening-night-checklist.js',
    '        run: node scripts/opening-night-checklist.js || true',
  ]) {
    const unsafe = `      - name: Record history\n${command}\n`;
    assert.equal(findSwallowedAuditWriters(unsafe, isAuditWriter).length, 1);
    const exempt = unsafe.replace('Record history\n', 'Record history\n        # lint-allow-swallow: fixture with a separately checked outcome\n');
    assert.deepEqual(findSwallowedAuditWriters(exempt, isAuditWriter), []);
    // One exemption must not hide an unrelated writer's failure.
    assert.equal(findSwallowedAuditWriters(exempt + unsafe, isAuditWriter).length, 1);
  }
});

test('actual workflow shell accepts designed outcomes and fails on audit-write errors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro267-audit-writer-'));
  try {
    // Stub only the child command's exit code; execute the workflow's real
    // shell rather than copying its rc discrimination into this test.
    fs.writeFileSync(path.join(root, 'node'), '#!/bin/sh\nexit "$AUDIT_TEST_EXIT"\n', { mode: 0o755 });
    const runMatch = runStep.match(/^        run: \|\n([\s\S]*)/m);
    assert.ok(runMatch, 'checklist step must contain a shell run block');
    const shell = runMatch[1].replace(/^          /gm, '')
      .replaceAll('${{ inputs.show_id }}', '')
      .replaceAll('/tmp/checklist.json', path.join(root, 'checklist.json'));
    for (const [code, expected] of [[0, 0], [1, 0], [3, 1], [137, 1]]) {
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', shell], {
        cwd: repo, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, AUDIT_TEST_EXIT: String(code) },
      });
      assert.equal(result.status, expected, `child exit ${code}: ${result.stdout}\n${result.stderr}`);
      if (expected) assert.match(result.stdout, /::error::/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
