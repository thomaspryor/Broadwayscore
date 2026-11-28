import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { FUNNEL_CLAUSES, auditDispatchFunnelCoverage } = require('./lib/audit-dispatch-funnel-coverage.js');
const guards = require('./lib/linear-dispatch.js');
const dispatchSource = readFileSync(new URL('./linear-next.js', import.meta.url), 'utf8');

function assertUncovered(guard, options) {
  const results = auditDispatchFunnelCoverage(options);
  assert.deepEqual(results.filter(result => result.errors.length).map(result => result.guard), [guard]);
  return results.find(result => result.guard === guard).errors;
}

test('the documented clauses have exported guards wired into the real dispatcher', () => {
  assert.deepEqual(FUNNEL_CLAUSES.map(result => result.guard).sort(), [
    'autofixFiledIssueGuard', 'checkTerminalStateGuard', 'marketingProjectGuard', 'startedStateGuard',
  ]);
  assert.deepEqual(auditDispatchFunnelCoverage().flatMap(result => result.errors), []);
});

test('the executable audit passes against the checkout from another working directory', () => {
  const cli = fileURLToPath(new URL('./lib/audit-dispatch-funnel-coverage.js', import.meta.url));
  const run = spawnSync(process.execPath, [cli], { cwd: '/tmp', encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Dispatch funnel coverage: 4\/4 clauses covered/);
});

for (const { guard } of FUNNEL_CLAUSES) {
  test(`${guard}: removing or replacing its export fails coverage`, () => {
    for (const replacement of [undefined, 'not a function']) {
      const errors = assertUncovered(guard, { guards: { ...guards, [guard]: replacement }, dispatchSource });
      assert.match(errors.join(), /not exported as a function/);
    }
  });

  test(`${guard}: a remaining comment or string cannot replace the real call`, () => {
    const missingCall = dispatchSource.replaceAll(`ld.${guard}(`, 'ld.unrelatedGuard(');
    assert.notEqual(missingCall, dispatchSource);
    assertUncovered(guard, { guards, dispatchSource: missingCall + `\n// ld.${guard}(issue, args)\n"ld.${guard}(issue, args)";` });
  });
}

test('logging a refusal without exiting is not enforcement', () => {
  const source = dispatchSource.replace(
    'console.error(`[linear-next] ${marketingRefusal}`);\n    process.exit(1);',
    'console.error(marketingRefusal);',
  );
  assert.notEqual(source, dispatchSource);
  assertUncovered('marketingProjectGuard', { dispatchSource: source });
});

test('an exit hidden in an uncalled helper does not enforce a refusal', () => {
  const source = dispatchSource.replace(
    'console.error(`[linear-next] ${marketingRefusal}`);\n    process.exit(1);',
    'console.error(marketingRefusal);\n    function unused() { process.exit(1); }',
  );
  assert.notEqual(source, dispatchSource);
  assertUncovered('marketingProjectGuard', { dispatchSource: source });
});

test('an inverted refusal condition is not enforcement', () => {
  const source = dispatchSource.replace('if (marketingRefusal) {', 'if (!marketingRefusal) {');
  assert.notEqual(source, dispatchSource);
  assertUncovered('marketingProjectGuard', { dispatchSource: source });
});

test('a guard call moved into an uncalled helper or dead branch is not wired', () => {
  const start = dispatchSource.indexOf('  const marketingRefusal =');
  const end = dispatchSource.indexOf('\n\n', start);
  assert.ok(start >= 0 && end > start);
  const block = dispatchSource.slice(start, end);
  for (const wrapper of ['function unused() {', 'if (false) {']) {
    const source = dispatchSource.slice(0, start) + wrapper + '\n' + block + '\n}' + dispatchSource.slice(end);
    assertUncovered('marketingProjectGuard', { dispatchSource: source });
  }
});

test('a guard called with bypass options instead of the real args is not wired', () => {
  const source = dispatchSource.replace('ld.startedStateGuard(issue, args)', 'ld.startedStateGuard(issue, { force: true })');
  assert.notEqual(source, dispatchSource);
  assertUncovered('startedStateGuard', { dispatchSource: source });
});

test('a guard moved below the headless launch branch cannot protect both launch paths', () => {
  const start = dispatchSource.indexOf('  const marketingRefusal =');
  const end = dispatchSource.indexOf('\n\n', start);
  assert.ok(start >= 0 && end > start);
  const block = dispatchSource.slice(start, end);
  const withoutGuard = dispatchSource.slice(0, start) + dispatchSource.slice(end);
  const source = withoutGuard.replace('// cmux tab path', block + '\n  // cmux tab path');
  assert.notEqual(source, withoutGuard);
  assertUncovered('marketingProjectGuard', { dispatchSource: source });
});

test('an unrecognized launch boundary fails closed', () => {
  const source = dispatchSource.replace("if (routing.mode === 'headless') {", 'if (otherCondition) {');
  assert.notEqual(source, dispatchSource);
  assert.equal(auditDispatchFunnelCoverage({ dispatchSource: source }).filter(result => result.errors.length).length, 4);
});

test('a dead terminal wrapper is not its explicit force exemption', () => {
  const source = dispatchSource.replace('if (!args.force) {\n    const terminalRefusal', 'if (false) {\n    const terminalRefusal');
  assert.notEqual(source, dispatchSource);
  assertUncovered('checkTerminalStateGuard', { dispatchSource: source });
});

test('guard-looking calls from a different module cannot satisfy coverage', () => {
  const source = dispatchSource.replace("require('./lib/linear-dispatch.js')", "require('./lib/other.js')");
  assert.notEqual(source, dispatchSource);
  assert.equal(auditDispatchFunnelCoverage({ dispatchSource: source }).filter(result => result.errors.length).length, 4);
});

test('malformed source fails closed', () => {
  assert.throws(() => auditDispatchFunnelCoverage({ dispatchSource: dispatchSource + '\nfunction {' }), SyntaxError);
});
