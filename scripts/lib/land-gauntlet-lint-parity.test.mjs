/**
 * land-gauntlet.sh's lint-workflows gate must run every script test.yml's
 * lint-workflows job runs (BRO-4737).
 *
 * The gauntlet keeps a hand-copied list of test.yml's lint/audit steps so land
 * can refuse a branch before it reaches main. BRO-3908 added
 * lint-autoclear-invalidate to test.yml but not to the gauntlet; on 2026-10-05
 * the BRO-3482 fix script landed through the gauntlet with three
 * lint-autoclear-invalidate violations and turned main red (test.yml run
 * 37332751709). This test derives the list from test.yml's executable
 * (non-comment) lint-workflows lines and fails when the gauntlet is missing a
 * `node scripts/X.js` script, drops a `--flag` test.yml passes it (the gauntlet
 * ran audit-push-retry-budgets without --fail-on-job-timeout), or misses a
 * `bash scripts/X.sh <mode>` mode. Inline `node -e` blocks are not compared.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { readWorkflowJobBlocks } = require('./audit-workflow-hygiene-rules.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A test.yml lint-workflows script the gauntlet deliberately does not run
// needs a one-line reason here, not a silent skip.
const EXEMPT = new Map([]);

const stripComments = (lines) => lines.filter((l) => !/^\s*#/.test(l));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function lintWorkflowsText(testYml) {
  const block = readWorkflowJobBlocks(testYml)['lint-workflows'];
  assert.ok(block, 'test.yml has no lint-workflows job');
  return stripComments(block).join('\n');
}

function lintWorkflowsScripts(testYml) {
  const text = lintWorkflowsText(testYml);
  return [...new Set([...text.matchAll(/node (?:--test )?scripts\/([\w./-]+?)\.(?:js|mjs)\b/g)].map((m) => m[1]))];
}

function missingFromGauntlet(names, gauntlet) {
  const text = stripComments(gauntlet.split('\n')).join('\n');
  return names.filter((n) => !new RegExp(`(^|[\\s/"])${esc(n)}(\\.m?js)?(?=[\\s"\\\\;]|$)`, 'm').test(text));
}

// [script, --flag] pairs test.yml passes to `node scripts/X.js`.
function nodeFlags(testYml) {
  const out = [];
  for (const m of lintWorkflowsText(testYml).matchAll(/node scripts\/([\w./-]+?)\.m?js\b([^\n|&;>)"]*)/g)) {
    for (const flag of m[2].split(/\s+/).filter((t) => t.startsWith('--'))) out.push([m[1], flag]);
  }
  return out;
}

function missingFlags(pairs, gauntlet) {
  const text = stripComments(gauntlet.split('\n')).join('\n');
  return pairs.filter(([name, flag]) => !new RegExp(`scripts/${esc(name)}\\.m?js\\b[^\\n]*\\s${esc(flag)}(?=[\\s)"]|$)`, 'm').test(text));
}

// [script, mode] pairs for `bash scripts/X.sh <mode>`.
function bashModes(testYml) {
  return [...lintWorkflowsText(testYml).matchAll(/bash scripts\/([\w./-]+?\.sh)[ \t]+([\w-]+)/g)].map((m) => [m[1], m[2]]);
}

// A gauntlet mode counts when it is called literally, or listed in the
// `for x in ...; do` loop whose next line calls that script.
function missingModes(pairs, gauntlet) {
  const lines = stripComments(gauntlet.split('\n'));
  const have = new Set();
  lines.forEach((l, i) => {
    const lit = l.match(/scripts\/([\w./-]+?\.sh)[ \t]+([\w-]+)/);
    if (lit) have.add(`${lit[1]}::${lit[2]}`);
    const loop = l.match(/^\s*for \w+ in (.+?); do\s*$/);
    const call = loop && (lines[i + 1] || '').match(/scripts\/([\w./-]+?\.sh)/);
    if (call) for (const mode of loop[1].trim().split(/\s+/)) have.add(`${call[1]}::${mode}`);
  });
  return pairs.filter(([s, m]) => !have.has(`${s}::${m}`));
}

const testYml = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
const gauntlet = fs.readFileSync(path.join(ROOT, 'scripts/lib/land-gauntlet.sh'), 'utf8');

// Execute the shipped function with unrelated audits stubbed, so the tests
// cover tool selection and lwgate's real failure reporting together.
const lintWorkflowsStart = gauntlet.indexOf('lint_workflows() {');
const lintWorkflowsEnd = gauntlet.indexOf('\ngate lint-workflows lint_workflows');
assert.ok(lintWorkflowsStart >= 0 && lintWorkflowsEnd > lintWorkflowsStart);
const lintWorkflows = gauntlet.slice(lintWorkflowsStart, lintWorkflowsEnd);
const gateStart = gauntlet.indexOf('\ngate() {');
const gateEnd = gauntlet.indexOf('\n}\n', gateStart) + 2;
assert.ok(gateStart >= 0 && gateEnd > gateStart);
const gate = gauntlet.slice(gateStart, gateEnd);

for (const [name, ci, available, exit, expected] of [
  ['local missing actionlint warns', '', false, 127, 0],
  ['CI missing actionlint fails', 'true', false, 127, 1],
  ['installed actionlint runs locally', '', true, 0, 0],
  ['installed actionlint failures stay blocking', '', true, 1, 1],
  ['installed actionlint runs in CI', 'true', true, 0, 0],
]) {
  test(name, (t) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-tools-'));
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    const run = spawnSync('bash', ['-c', `
      ${lintWorkflows}
      ${gate}
      want_gate() { :; }
      git() { :; }
      node() { :; }
      bash() { :; }
      command() {
        if [ "$1" = -v ] && [ "$2" = actionlint ]; then return ${available ? 0 : 1}; fi
        builtin command "$@"
      }
      actionlint() { echo actionlint-invoked; return ${exit}; }
      gate lint-workflows lint_workflows
    `], { encoding: 'utf8', env: { ...process.env, CI: ci, LAND_BASE: '', BG_GATES: '', OUT: out } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(Number(fs.readFileSync(path.join(out, 'lint-workflows.exit'), 'utf8')), expected);
    const skipped = !ci && !available;
    assert.equal(run.stdout.includes('actionlint-invoked'), !skipped);
    assert.equal(run.stdout.includes('::warning::actionlint not installed here; CI runs it'), skipped);
    assert.equal(run.stderr.includes('::warning::actionlint not installed here; CI runs it'), skipped,
      'missing tools must be visible when land-local-check hides gauntlet stdout');
    assert.equal(run.stdout.includes('::error::lint-workflows gate failed: actionlint'), expected !== 0);
  });
}

test('gate forwards the named rsync skip when its stdout is hidden', (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-tools-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const run = spawnSync('bash', ['-c', `
    ${gate}
    want_gate() { :; }
    gate unit-tests-node printf '%s\\n' 'ok 1 - copy fallback # SKIP rsync not installed here; CI runs the copy fallback test'
  `], { encoding: 'utf8', env: { ...process.env, BG_GATES: '', OUT: out } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(path.join(out, 'unit-tests-node.exit'), 'utf8').trim(), '0');
  assert.match(run.stderr, /^::warning::rsync not installed here; CI runs the copy fallback test\n$/);
});

test('parallel lane preserves tool warnings when the local caller hides stdout', (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-tools-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const child = path.join(out, 'child.sh');
  fs.writeFileSync(child, `
    BG_GATES=""
    ${gate}
    want_gate() { :; }
    missing_tool() { echo '::warning::actionlint not installed here; CI runs it'; }
    gate lint-workflows missing_tool
  `);
  const start = gauntlet.indexOf('BG_GATES=""\nif');
  const end = gauntlet.indexOf('\n# ', start);
  assert.ok(start >= 0 && end > start);
  const run = spawnSync('bash', ['-c', `
    want_gate() { [ "$1" = lint-workflows ]; }
    ${gauntlet.slice(start, end)}
    wait "$BG_PID"
  `], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CI: '', GAUNTLET_PARALLEL: '1', GAUNTLET_CHILD: '', BG_GATES: '', SCOPE_DIR: '', OUT: out, SELF: child },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /^::warning::actionlint not installed here; CI runs it\n$/);
  assert.equal(fs.readFileSync(path.join(out, 'lint-workflows.exit'), 'utf8').trim(), '0');
});

test('every script test.yml lint-workflows runs is also run by land-gauntlet.sh', () => {
  const names = lintWorkflowsScripts(testYml);
  assert.ok(names.length >= 20, `parsed only ${names.length} scripts from lint-workflows; parser drift?`);
  const missing = missingFromGauntlet(names, gauntlet).filter((n) => !EXEMPT.has(n));
  assert.deepEqual(missing, [], `land-gauntlet.sh lint-workflows gate is missing: ${missing.join(', ')}. Add each to its audit list (or EXEMPT with a reason).`);
});

test('every --flag test.yml passes a lint-workflows node script, the gauntlet passes too', () => {
  const pairs = nodeFlags(testYml);
  assert.ok(pairs.some(([n, f]) => n === 'audit-push-retry-budgets' && f === '--fail-on-job-timeout'), 'parser drift: expected audit-push-retry-budgets --fail-on-job-timeout');
  const missing = missingFlags(pairs, gauntlet).filter(([n]) => !EXEMPT.has(n));
  assert.deepEqual(missing, [], `land-gauntlet.sh runs these without the flag test.yml uses: ${missing.map((p) => p.join(' ')).join(', ')}`);
  assert.deepEqual(missingFlags([['audit-x', '--strict']], 'lwgate audit-x node scripts/audit-x.js\n'), [['audit-x', '--strict']]);
  assert.deepEqual(missingFlags([['audit-x', '--strict']], 'lwgate audit-x node scripts/audit-x.js --strict\n'), []);
});

test('every bash lint mode test.yml runs is run by the gauntlet', () => {
  const pairs = bashModes(testYml);
  assert.ok(pairs.length >= 10, `parsed only ${pairs.length} bash lint modes; parser drift?`);
  assert.deepEqual(missingModes(pairs, gauntlet), []);
  const dropped = gauntlet.replace(/ theatr-token /, ' ');
  assert.notEqual(dropped, gauntlet, 'fixture: gauntlet loop no longer lists theatr-token');
  assert.deepEqual(missingModes(pairs, dropped), [['lint-workflow-guards.sh', 'theatr-token']]);
});

test('the check catches a script dropped from the gauntlet (lint-autoclear-invalidate, the BRO-4737 regression)', () => {
  const names = lintWorkflowsScripts(testYml);
  assert.ok(names.includes('lint-autoclear-invalidate'));
  const dropped = gauntlet.replace(/^\s*lint-autoclear-invalidate \\\n/m, '');
  assert.notEqual(dropped, gauntlet, 'fixture: gauntlet no longer lists lint-autoclear-invalidate in the loop form');
  assert.deepEqual(missingFromGauntlet(['lint-autoclear-invalidate'], dropped), ['lint-autoclear-invalidate']);
});

test('a script named only in a gauntlet comment does not count as run', () => {
  assert.deepEqual(missingFromGauntlet(['audit-foo'], '# audit-foo is great\nlwgate x node scripts/bar.js\n'), ['audit-foo']);
  assert.deepEqual(missingFromGauntlet(['audit-foo'], 'lwgate audit-foo node scripts/audit-foo.js --strict\n'), []);
});
