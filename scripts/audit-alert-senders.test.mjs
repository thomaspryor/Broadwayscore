// Tests for the alert-sender CI gate (scripts/audit-alert-senders.js).
// Requires the REAL scanFile/buildDirectCounts/compareToBaseline per
// CLAUDE.md §15 — no logic copies. Registered explicitly in test.yml's
// unit-test `node --test` list (top-level scripts/*.test.mjs is not globbed).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanFile, buildDirectCounts, compareToBaseline, DIGEST_OR_REVIEWED } =
  require('./audit-alert-senders.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-gate-test-'));

function scanFixture(relPath, content) {
  const abs = path.join(tmpDir, relPath.replace(/\//g, '__'));
  fs.writeFileSync(abs, content);
  return scanFile(abs, relPath);
}

test('scanFile classifies an emailable sendAlert in a normal script as direct', () => {
  const findings = scanFixture('scripts/some-new-cron.js', [
    'async function notify() {',
    "  await sendAlert({",
    "    email: true,",
    "    severity: 'error',",
    "    subject: 'boom',",
    '  });',
    '}',
  ].join('\n'));
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].classification, 'direct');
  assert.strictEqual(findings[0].severity, 'error');
});

test('scanFile classifies the same call in a DIGEST_OR_REVIEWED file as digest', () => {
  const digestPath = [...DIGEST_OR_REVIEWED][0];
  const findings = scanFixture(digestPath, [
    "sendAlert({ email: true, severity: 'critical' });",
  ].join('\n'));
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].classification, 'digest');
});

test('scanFile classifies routeAlert calls as router', () => {
  const findings = scanFixture('scripts/routed.js', [
    'await routeAlert({',
    "  disposition: 'action',",
    '});',
  ].join('\n'));
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].classification, 'router');
  assert.strictEqual(findings[0].disposition, 'action');
});

test('scanFile skips warning-severity and comment-line sendAlert mentions', () => {
  const findings = scanFixture('scripts/quiet.js', [
    "sendAlert({ email: true, severity: 'warning' });",
    "// sendAlert({ email: true, severity: 'error' }) — prose about a past bug",
    "sendAlert({ severity: 'error' }); // log-only, never emailed",
  ].join('\n'));
  assert.strictEqual(findings.length, 0);
});

test('buildDirectCounts counts only direct findings, per file', () => {
  const counts = buildDirectCounts([
    { file: 'scripts/a.js', classification: 'direct' },
    { file: 'scripts/a.js', classification: 'direct' },
    { file: 'scripts/a.js', classification: 'router' },
    { file: 'scripts/b.js', classification: 'digest' },
    { file: 'scripts/c.js', classification: 'direct' },
  ]);
  assert.deepStrictEqual(counts, { 'scripts/a.js': 2, 'scripts/c.js': 1 });
});

test('compareToBaseline passes when counts match the baseline exactly', () => {
  const r = compareToBaseline({ 'scripts/a.js': 2 }, { 'scripts/a.js': 2 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.newFiles, []);
  assert.deepStrictEqual(r.grown, []);
});

test('compareToBaseline fails on a direct sender in a non-baselined file', () => {
  const r = compareToBaseline(
    { 'scripts/a.js': 2, 'scripts/new-bypass.js': 1 },
    { 'scripts/a.js': 2 },
  );
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.newFiles, ['scripts/new-bypass.js']);
});

test('compareToBaseline fails when a baselined file grows', () => {
  const r = compareToBaseline({ 'scripts/a.js': 3 }, { 'scripts/a.js': 2 });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.grown, [{ file: 'scripts/a.js', baseline: 2, current: 3 }]);
});

test('compareToBaseline treats shrinkage and drained files as warnings, not failures', () => {
  const r = compareToBaseline(
    { 'scripts/a.js': 1 },
    { 'scripts/a.js': 2, 'scripts/drained.js': 1 },
  );
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.shrunk, [{ file: 'scripts/a.js', baseline: 2, current: 1 }]);
  assert.deepStrictEqual(r.stale, ['scripts/drained.js']);
});
