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

test('scanFile resolves a severity variable from a nearby literal assignment', () => {
  // The check-opening-night-completeness.js / verify-all-scored.js pattern
  // (card #532): severity held in a const so shouldEmailAlert() can reuse it.
  // A resolved 'warning' is policy-suppressed → not a direct sender.
  const findings = scanFixture('scripts/cooldown-stamper.js', [
    "const alertSeverity = 'warning';",
    'const delivered = await sendAlert({',
    "  title: 'Drop Alert',",
    '  severity: alertSeverity,',
    '  email: true,',
    '});',
    'const notifyOk = !shouldEmailAlert(alertSeverity) || delivered;',
  ].join('\n'));
  assert.strictEqual(findings.length, 0);
});

test('scanFile still flags a severity variable that resolves to an emailable literal', () => {
  const findings = scanFixture('scripts/loud-cron.js', [
    "const sev = 'error';",
    'await sendAlert({',
    '  severity: sev,',
    '  email: true,',
    '});',
  ].join('\n'));
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].classification, 'direct');
  assert.strictEqual(findings[0].severity, 'error');
});

test('scanFile flags a reassigned severity variable instead of resolving to the first literal', () => {
  // Second-opinion blocker: first-match resolution would pick 'warning' here
  // and silently SKIP a call that emails when bad=true. Disagreeing
  // assignments must leave severity unresolved → flagged.
  const findings = scanFixture('scripts/escalating-cron.js', [
    "let sev = 'warning';",
    "if (somethingBad) sev = 'error';",
    'await sendAlert({',
    '  severity: sev,',
    '  email: true,',
    '});',
  ].join('\n'));
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].classification, 'direct');
  assert.strictEqual(findings[0].severity, null);
});

test('scanFile flags a ternary severity (leading quote never matches, ident never resolves)', () => {
  const findings = scanFixture('scripts/ternary-cron.js', [
    'await sendAlert({',
    "  severity: ok ? 'warning' : 'error',",
    '  email: true,',
    '});',
  ].join('\n'));
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].classification, 'direct');
});

test('scanFile flags an unresolvable severity variable (fail-noisy default)', () => {
  const findings = scanFixture('scripts/opaque-cron.js', [
    'await sendAlert({',
    '  severity: pickSeverity(result),',
    '  email: true,',
    '});',
  ].join('\n'));
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].classification, 'direct');
  assert.strictEqual(findings[0].severity, null);
});

test('scanFile ignores trailing-comment mentions but keeps real calls and https:// intact', () => {
  const findings = scanFixture('scripts/trailing.js', [
    "registerPath('foo.js'); // sendAlert() path, email: true when severity: 'error'",
    "const url = 'https://example.com'; sendAlert({ email: true, severity: 'critical', url });",
  ].join('\n'));
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].line, 2);
  assert.strictEqual(findings[0].classification, 'direct');
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

test('compareToBaseline drops malformed baseline values so they block instead of silently passing', () => {
  // A non-integer value would make both > and < comparisons false — the file
  // must fall back to un-baselined (blocking), not silently accept any count.
  const r = compareToBaseline(
    { 'scripts/a.js': 5, 'scripts/b.js': 1 },
    { 'scripts/a.js': 'unknown', 'scripts/b.js': 1, 'scripts/c.js': null },
  );
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.newFiles, ['scripts/a.js']);
});

test('compareToBaseline tolerates a null/undefined baseline (everything blocks)', () => {
  const r = compareToBaseline({ 'scripts/a.js': 1 }, null);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.newFiles, ['scripts/a.js']);
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
