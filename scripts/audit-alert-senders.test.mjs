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
const { scanFile, buildDirectCounts, buildHumanDigestCounts, compareToBaseline, DIGEST_OR_REVIEWED } =
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

// Card #616: routeAlert(disposition:'human') callers that branch on
// result.action but never mention 'digest' (the page-worthy gate, card #611,
// can silently downgrade 'human' to 'digest').
test('scanFile flags a same-line-assigned result that checks .action without mentioning digest', () => {
  const findings = scanFixture('scripts/human-caller.js', [
    "const result = await routeAlert({",
    "  conditionKey: 'x',",
    "  title: 'y',",
    "  disposition: 'human',",
    '});',
    "if (result.action === 'human' && result.delivered) { console.log('told'); }",
  ].join('\n'));
  const digestFindings = findings.filter(f => f.kind === 'human-caller-ignores-digest');
  assert.strictEqual(digestFindings.length, 1);
  assert.strictEqual(digestFindings[0].resultVar, 'result');
});

test('scanFile does not flag a caller that mentions digest in the branch', () => {
  const findings = scanFixture('scripts/digest-aware-caller.js', [
    "const result = await routeAlert({",
    "  conditionKey: 'x',",
    "  title: 'y',",
    "  disposition: 'human',",
    '});',
    "// action === 'digest' means the page-worthy gate downgraded this",
    "if ((result.action === 'human' && result.delivered) || result.action === 'digest') { console.log('told'); }",
  ].join('\n'));
  assert.strictEqual(findings.filter(f => f.kind === 'human-caller-ignores-digest').length, 0);
});

test('scanFile does not flag a fire-and-forget routeAlert call (no result captured)', () => {
  const findings = scanFixture('scripts/fire-and-forget.js', [
    "routeAlert({",
    "  conditionKey: 'x',",
    "  title: 'y',",
    "  disposition: 'human',",
    "}).catch(e => console.error(e.message));",
  ].join('\n'));
  assert.strictEqual(findings.filter(f => f.kind === 'human-caller-ignores-digest').length, 0);
});

test('scanFile does not flag a result that is captured but never inspects .action', () => {
  const findings = scanFixture('scripts/unused-result.js', [
    "const result = await routeAlert({",
    "  conditionKey: 'x',",
    "  title: 'y',",
    "  disposition: 'human',",
    '});',
    "console.log('sent', result.cardId);",
  ].join('\n'));
  assert.strictEqual(findings.filter(f => f.kind === 'human-caller-ignores-digest').length, 0);
});

test('scanFile does not flag a disposition other than human', () => {
  const findings = scanFixture('scripts/auto-caller.js', [
    "const result = await routeAlert({",
    "  conditionKey: 'x',",
    "  title: 'y',",
    "  disposition: 'auto',",
    '});',
    "if (result.action === 'auto') { console.log('dispatched'); }",
  ].join('\n'));
  assert.strictEqual(findings.filter(f => f.kind === 'human-caller-ignores-digest').length, 0);
});

test('scanFile flags a .then() promise-chain caller that checks .action without digest', () => {
  const findings = scanFixture('scripts/then-caller.js', [
    "routeAlert({",
    "  conditionKey: 'x',",
    "  title: 'y',",
    "  disposition: 'human',",
    "}).then((result) => {",
    "  const informed = result.action === 'silent' || (result.action === 'human' && result.delivered);",
    "  if (!informed) console.error('not informed');",
    '});',
  ].join('\n'));
  const digestFindings = findings.filter(f => f.kind === 'human-caller-ignores-digest');
  assert.strictEqual(digestFindings.length, 1);
  assert.strictEqual(digestFindings[0].resultVar, 'result');
});

test('scanFile checks the raw (unstripped) lines for "digest", not the comment-blanked ones', () => {
  // stripTrailingComment blanks whole `//`-only comment lines (it treats
  // leading whitespace + `//` as a trailing-comment marker at index 0) — the
  // digest-mention search must use the pre-strip text or it would never see
  // an explanatory comment like this one (regression check for the bug this
  // card's implementation hit).
  const findings = scanFixture('scripts/comment-only-digest-mention.js', [
    "const result = await routeAlert({",
    "  conditionKey: 'x',",
    "  title: 'y',",
    "  disposition: 'human',",
    '});',
    "// a downgraded 'digest' result counts as informed too",
    "if (result.action === 'human' && result.delivered) { console.log('told'); }",
  ].join('\n'));
  assert.strictEqual(findings.filter(f => f.kind === 'human-caller-ignores-digest').length, 0);
});

// Adversarial-review fixes (card #616, post-implementation second pass).
test('scanFile recognizes a double-quoted disposition (yaml-embedded-JS pattern)', () => {
  // Real miss: .github/workflows/check-cron-health.yml and
  // update-show-status.yml both write `disposition: "human"` (double quotes)
  // inside their embedded `node -e` scripts — a single-quote-only regex
  // classified these as disposition:'unknown' and the #616 check never ran.
  const findings = scanFixture('scripts/double-quote-caller.js', [
    'const result = await routeAlert({',
    '  conditionKey: "x",',
    '  title: "y",',
    '  disposition: "human",',
    '});',
    'if (result.action === "human" && result.delivered) { console.log("told"); }',
  ].join('\n'));
  const routeFinding = findings.find(f => f.kind === 'routeAlert');
  assert.strictEqual(routeFinding.disposition, 'human');
  assert.strictEqual(findings.filter(f => f.kind === 'human-caller-ignores-digest').length, 1);
});

test('scanFile recognizes a reassignment to a pre-declared result variable (no const/let/var)', () => {
  // The injectable-for-tests pattern (scripts/lib/opening-night-sla.js style):
  // `res = await routeAlert(...)` with `res` declared/destructured earlier.
  const findings = scanFixture('scripts/reassigned-result.js', [
    'let res;',
    'res = await routeAlert({',
    "  conditionKey: 'x',",
    "  title: 'y',",
    "  disposition: 'human',",
    '});',
    "if (res.action === 'human' && res.delivered) { console.log('told'); }",
  ].join('\n'));
  const digestFindings = findings.filter(f => f.kind === 'human-caller-ignores-digest');
  assert.strictEqual(digestFindings.length, 1);
  assert.strictEqual(digestFindings[0].resultVar, 'res');
});

test('scanFile recognizes a destructured { action } binding', () => {
  const findings = scanFixture('scripts/destructured-action.js', [
    'const { action } = await routeAlert({',
    "  conditionKey: 'x',",
    "  title: 'y',",
    "  disposition: 'human',",
    '});',
    "if (action === 'human') { console.log('told'); }",
  ].join('\n'));
  assert.strictEqual(findings.filter(f => f.kind === 'human-caller-ignores-digest').length, 1);
});

test('scanFile does not let a LATER unrelated routeAlert call bleed its digest mention into an earlier undispositioned call', () => {
  // False positive found by adversarial review: a fixed-size forward window
  // from the call's OPENING line could pick up the disposition (and later,
  // the digest mention) of a DIFFERENT call that follows soon after.
  const findings = scanFixture('scripts/window-bleed.js', [
    'const first = await routeAlert({',
    "  conditionKey: 'first',",
    "  title: 'y',",
    '});', // no disposition — should classify 'unknown', not inherit 'human' from below
    "if (first.action === 'human') { console.log('x'); }",
    "const second = await routeAlert({",
    "  conditionKey: 'second',",
    "  title: 'z',",
    "  disposition: 'human',",
    '});',
    "// digest handled here for 'second'",
    "if (second.action === 'human') { console.log('y'); }",
  ].join('\n'));
  const routerFindings = findings.filter(f => f.kind === 'routeAlert');
  assert.strictEqual(routerFindings.length, 2);
  assert.strictEqual(routerFindings[0].disposition, 'unknown');
  assert.strictEqual(routerFindings[1].disposition, 'human');
  assert.strictEqual(findings.filter(f => f.kind === 'human-caller-ignores-digest').length, 0);
});

test('scanFile ignores an incidental "digest" substring in the call\'s OWN arguments (conditionKey/title)', () => {
  // False negative found by adversarial review: searching the whole window
  // (including the call's own arg lines) for "digest" let an unrelated
  // conditionKey like 'daily-digest-missing' silence a real finding.
  const findings = scanFixture('scripts/incidental-digest-in-args.js', [
    'const result = await routeAlert({',
    "  conditionKey: 'daily-digest-missing',",
    "  title: 'y',",
    "  disposition: 'human',",
    '});',
    "if (result.action === 'human' && result.delivered) { console.log('told'); }",
  ].join('\n'));
  assert.strictEqual(findings.filter(f => f.kind === 'human-caller-ignores-digest').length, 1);
});

test('scanFile resolves calls through a thin pass-through wrapper function to routeAlert', () => {
  // Real pattern: scripts/opening-night-monitor-launch.js's local
  // `alert(opts) { return routeAlert(opts); }` — invisible to a literal
  // `routeAlert(` regex, so the whole scan (not just this check) missed it.
  const findings = scanFixture('scripts/wrapper-passthrough.js', [
    'async function alert(opts) {',
    '  return await routeAlert(opts);',
    '}',
    'const result = await alert({',
    "  conditionKey: 'x',",
    "  title: 'y',",
    "  disposition: 'human',",
    '});',
    "if (result.action === 'human' && result.delivered) { console.log('told'); }",
  ].join('\n'));
  const routeFindings = findings.filter(f => f.kind === 'routeAlert' && f.disposition === 'human');
  assert.strictEqual(routeFindings.length, 1);
  assert.strictEqual(findings.filter(f => f.kind === 'human-caller-ignores-digest').length, 1);
});

test('scanFile resolves calls through an injectable-for-tests default parameter wrapper', () => {
  // Real pattern: scripts/lib/opening-night-sla.js's `route = routeAlert`
  // default param (injectable for test doubles) — a different alias shape
  // than the pass-through-function pattern above.
  const findings = scanFixture('scripts/wrapper-default-param.js', [
    'async function dispatch(opts, { route = routeAlert } = {}) {',
    '  const res = await route({',
    "    conditionKey: 'x',",
    "    title: 'y',",
    "    disposition: 'human',",
    '  });',
    "  if (res.action === 'human' && res.delivered) { console.log('told'); }",
    '}',
  ].join('\n'));
  const routeFindings = findings.filter(f => f.kind === 'routeAlert' && f.disposition === 'human');
  assert.strictEqual(routeFindings.length, 1);
  assert.strictEqual(findings.filter(f => f.kind === 'human-caller-ignores-digest').length, 1);
});

test('buildHumanDigestCounts counts only human-caller-ignores-digest findings, per file', () => {
  const counts = buildHumanDigestCounts([
    { file: 'scripts/a.js', kind: 'human-caller-ignores-digest' },
    { file: 'scripts/a.js', kind: 'human-caller-ignores-digest' },
    { file: 'scripts/a.js', kind: 'routeAlert' },
    { file: 'scripts/b.js', kind: 'sendAlert-direct' },
    { file: 'scripts/c.js', kind: 'human-caller-ignores-digest' },
  ]);
  assert.deepStrictEqual(counts, { 'scripts/a.js': 2, 'scripts/c.js': 1 });
});
