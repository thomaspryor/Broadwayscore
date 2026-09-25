/**
 * land-gate-delta.test.mjs — the new-failures-vs-base rule land.yml's checks
 * job applies (BRO-3873). Drives the REAL decideGateDelta()/parsers/CLI via
 * require() (rule 15), never a copy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  GATES, decideGateDelta, decideAllGates, firstFailingGate, parseGateFailures, parseTscFailures,
  parseNextLintFailures, parseLintWorkflowsFailures, parseBashIntegrationFailures, computeCodeTreeHash, formatSummary, main, addWithMultiplicity, isCacheKeyRelevant,
} = require('./land-gate-delta.js');

const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), 'land-gate-delta.js');

// A TAP transcript with `location:` diagnostics, the shape node --test
// --test-reporter=tap emits and tap-failure-parser.js keys on.
function tap(root, failures, { unlocated = [] } = {}) {
  const lines = ['TAP version 13'];
  let n = 0;
  for (const [file, name, failureType = 'testCodeFailure'] of failures) {
    n++;
    lines.push(`not ok ${n} - ${name}`, '  ---', '  duration_ms: 1', `  location: '${path.join(root, file)}:10:1'`, `  failureType: '${failureType}'`, '  ...');
  }
  for (const name of unlocated) {
    n++;
    lines.push(`not ok ${n} - ${name}`, '  ---', '  duration_ms: 1', '  ...');
  }
  n++;
  lines.push(`ok ${n} - something that passes`, `# tests ${n}`, `# pass 1`, `# fail ${n - 1}`);
  return lines.join('\n');
}

const ROOT = '/work/repo';
// Keys as the delta sees them, minus the failureType suffix the TAP re-keying adds.
const keys = (list) => list.map((f) => `${f.file}::${f.name}`.replace(/ \[[a-zA-Z]+\]$/, '')).sort();

test('same failures in base and branch → pass, all reported pre-existing, none new', () => {
  const both = [['tests/unit/a.test.mjs', 'image self-heal'], ['tests/unit/b.test.mjs', 'venue guard baseline']];
  const d = decideGateDelta({
    gate: 'unit-tests-node',
    base: { exit: 1, text: tap(ROOT, both), root: ROOT },
    branch: { exit: 1, text: tap(ROOT, both), root: ROOT },
  });
  assert.equal(d.verdict, 'pass');
  assert.equal(d.mode, 'delta');
  assert.deepEqual(d.newFailures, []);
  assert.deepEqual(keys(d.preExisting), ['tests/unit/a.test.mjs::image self-heal', 'tests/unit/b.test.mjs::venue guard baseline']);
  assert.deepEqual(d.fixed, []);
  assert.match(d.reason, /0 new, 2 pre-existing, 0 fixed/);
});

test('a NEW failure on the branch → fail, and the verdict names it (pre-existing ones still listed, not blocking)', () => {
  const base = [['tests/unit/a.test.mjs', 'image self-heal']];
  const branch = [['tests/unit/a.test.mjs', 'image self-heal'], ['scripts/lib/land-branch.test.mjs', 'push seam is push-only']];
  const d = decideGateDelta({
    gate: 'unit-tests-node',
    base: { exit: 1, text: tap(ROOT, base), root: ROOT },
    branch: { exit: 1, text: tap(ROOT, branch), root: ROOT },
  });
  assert.equal(d.verdict, 'fail');
  assert.equal(d.mode, 'delta');
  assert.deepEqual(keys(d.newFailures), ['scripts/lib/land-branch.test.mjs::push seam is push-only']);
  assert.deepEqual(keys(d.preExisting), ['tests/unit/a.test.mjs::image self-heal']);
});

test('a base failure fixed by the branch → pass and reported as fixed (branch green)', () => {
  const d = decideGateDelta({
    gate: 'unit-tests-node',
    base: { exit: 1, text: tap(ROOT, [['tests/unit/a.test.mjs', 'image self-heal']]), root: ROOT },
    branch: { exit: 0, text: tap(ROOT, []), root: ROOT },
  });
  assert.equal(d.verdict, 'pass');
  assert.equal(d.mode, 'green');
  assert.deepEqual(keys(d.fixed), ['tests/unit/a.test.mjs::image self-heal']);
  assert.match(d.reason, /1 base failure\(s\) fixed/);
});

test('a base failure fixed while another pre-existing one remains → pass, fixed AND pre-existing both reported', () => {
  const base = [['tests/unit/a.test.mjs', 'image self-heal'], ['tests/unit/b.test.mjs', 'venue guard baseline']];
  const branch = [['tests/unit/b.test.mjs', 'venue guard baseline']];
  const d = decideGateDelta({
    gate: 'unit-tests-node',
    base: { exit: 1, text: tap(ROOT, base), root: ROOT },
    branch: { exit: 1, text: tap(ROOT, branch), root: ROOT },
  });
  assert.equal(d.verdict, 'pass');
  assert.deepEqual(keys(d.fixed), ['tests/unit/a.test.mjs::image self-heal']);
  assert.deepEqual(keys(d.preExisting), ['tests/unit/b.test.mjs::venue guard baseline']);
  assert.deepEqual(d.newFailures, []);
});

test('base green + branch red → STRICT fail (tsc/lint-workflows "stay strict while green on base")', () => {
  const d = decideGateDelta({
    gate: 'tsc',
    base: { exit: 0, text: '' },
    branch: { exit: 2, text: "src/lib/x.ts(12,5): error TS2304: Cannot find name 'y'.\n" },
  });
  assert.equal(d.verdict, 'fail');
  assert.equal(d.mode, 'strict');
  assert.deepEqual(keys(d.newFailures), ["src/lib/x.ts::TS2304 Cannot find name 'y'."]);
  assert.match(d.reason, /base is green/);
});

test('no base result at all → strict, never a silent pass', () => {
  const d = decideGateDelta({ gate: 'lint-workflows', base: null, branch: { exit: 1, text: '::error::lint-workflows gate failed: audit-venue-write-guard (exit 1)\n' } });
  assert.equal(d.verdict, 'fail');
  assert.equal(d.mode, 'strict');
  assert.deepEqual(keys(d.newFailures), ['lint-workflows::audit-venue-write-guard']);
});

test('lint-workflows: the same red audit on base and branch is pre-existing (the live 2026-09-20 case); a second red audit is new', () => {
  const baseText = '::error::lint-workflows gate failed: audit-venue-write-guard (exit 1)\n::error::lint-workflows failures:\n  - audit-venue-write-guard\n';
  const same = decideGateDelta({ gate: 'lint-workflows', base: { exit: 1, text: baseText }, branch: { exit: 1, text: baseText } });
  assert.equal(same.verdict, 'pass');
  assert.deepEqual(keys(same.preExisting), ['lint-workflows::audit-venue-write-guard']);
  const extra = decideGateDelta({ gate: 'lint-workflows', base: { exit: 1, text: baseText }, branch: { exit: 1, text: `${baseText}::error::lint-workflows gate failed: actionlint (exit 1)\n` } });
  assert.equal(extra.verdict, 'fail');
  assert.deepEqual(keys(extra.newFailures), ['lint-workflows::actionlint']);
});

test('fail-safe: a red branch run that parses to zero failures is refused, not passed', () => {
  const d = decideGateDelta({
    gate: 'unit-tests-node',
    base: { exit: 1, text: tap(ROOT, [['tests/unit/a.test.mjs', 'x']]), root: ROOT },
    branch: { exit: 1, text: 'Segmentation fault\n', root: ROOT },
  });
  assert.equal(d.verdict, 'fail');
  assert.equal(d.mode, 'fail-safe');
  assert.match(d.reason, /no individual failure could be parsed from the branch/);
});

test('fail-safe: a red base run that parses to zero failures cannot vouch for anything → refused', () => {
  const d = decideGateDelta({
    gate: 'unit-tests-node',
    base: { exit: 1, text: 'killed\n', root: ROOT },
    branch: { exit: 1, text: tap(ROOT, [['tests/unit/a.test.mjs', 'x']]), root: ROOT },
  });
  assert.equal(d.verdict, 'fail');
  assert.equal(d.mode, 'fail-safe');
  assert.match(d.reason, /base run/);
});

test('unlocated TAP failures (?::name) are always NEW even when the base has the same title', () => {
  const d = decideGateDelta({
    gate: 'scripts-lib-tests',
    base: { exit: 1, text: tap(ROOT, [], { unlocated: ['flaky title'] }), root: ROOT },
    branch: { exit: 1, text: tap(ROOT, [], { unlocated: ['flaky title'] }), root: ROOT },
  });
  assert.equal(d.verdict, 'fail');
  assert.deepEqual(keys(d.newFailures), ['?::flaky title']);
});

test('a test file red on base through a failing subtest that the branch breaks AT LOAD is NEW, not "fixed" (nested and flat TAP shapes)', () => {
  const X = 'tests/unit/x.test.mjs';
  const absX = path.join(ROOT, X);
  // nested shape (Node 22+): file wrapper + subtest on base; only the wrapper, now a load crash, on the branch
  const nestedBase = tap(ROOT, [[X, 'sub assertion'], [X, absX, 'subtestsFailed']]);
  const crash = tap(ROOT, [[X, absX, 'testCodeFailure']]);
  const nested = decideGateDelta({ gate: 'unit-tests-node', base: { exit: 1, text: nestedBase, root: ROOT }, branch: { exit: 1, text: crash, root: ROOT } });
  assert.equal(nested.verdict, 'fail');
  assert.deepEqual(nested.newFailures.map((f) => `${f.file}::${f.name}`), [`${X}::${absX} [testCodeFailure]`]);
  // flat shape (Node 20 in CI): just the subtest on base
  const flat = decideGateDelta({ gate: 'unit-tests-node', base: { exit: 1, text: tap(ROOT, [[X, 'sub assertion']]), root: ROOT }, branch: { exit: 1, text: crash, root: ROOT } });
  assert.equal(flat.verdict, 'fail');
  // and the same plain assertion failure on both sides is still the same key
  const same = decideGateDelta({ gate: 'unit-tests-node', base: { exit: 1, text: tap(ROOT, [[X, 'sub assertion']]), root: ROOT }, branch: { exit: 1, text: tap(ROOT, [[X, 'sub assertion']]), root: ROOT } });
  assert.equal(same.verdict, 'pass');
  assert.equal(same.preExisting[0].name, 'sub assertion [testCodeFailure]');
});

test('a missing branch result (the gate never ran) is a fail-safe refusal', () => {
  const d = decideGateDelta({ gate: 'tsc', base: { exit: 0, text: '' }, branch: null });
  assert.equal(d.verdict, 'fail');
  assert.equal(d.mode, 'fail-safe');
});

test('tsc keys drop line:col so a shifted line is the same error, and multi-line messages key on the first line', () => {
  const a = parseTscFailures("src/a.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.\n  Types of x are incompatible.\n");
  const b = parseTscFailures("src/a.ts(40,7): error TS2322: Type 'string' is not assignable to type 'number'.\n");
  assert.deepEqual([...a.keys()], [...b.keys()]);
  assert.equal(a.size, 1);
});

test('next-lint keys on file::rule message, errors only — warnings never fail next lint so they never fail this gate', () => {
  const text = [
    './src/app/page.tsx',
    "12:5  Error: 'x' is defined but never used.  @typescript-eslint/no-unused-vars",
    '20:1  Warning: Unexpected console statement.  no-console',
    '',
    './src/lib/y.ts',
    '3:9  Error: Do not use the img element.  @next/next/no-img-element',
    '',
    'info  - Need to disable some ESLint rules? Learn more here: https://nextjs.org/docs/basic-features/eslint#disabling-rules',
  ].join('\n');
  const m = parseNextLintFailures(text);
  assert.deepEqual([...m.keys()].sort(), [
    "src/app/page.tsx::@typescript-eslint/no-unused-vars 'x' is defined but never used.",
    'src/lib/y.ts::@next/next/no-img-element Do not use the img element.',
  ]);
});

test('parseGateFailures dispatches per gate and refuses an unknown gate', () => {
  assert.equal(parseGateFailures('lint-workflows', '::error::lint-workflows gate failed: actionlint (exit 1)').size, 1);
  assert.equal(parseLintWorkflowsFailures('unrelated ::error:: line').size, 0);
  for (const g of ['unit-tests-node', 'unit-tests-tsx', 'scripts-lib-tests']) assert.equal(parseGateFailures(g, tap(ROOT, [['t.test.mjs', 'n']]), ROOT).size, 1);
  assert.equal(GATES.includes('unit-tests'), false, 'the two unit batches are separate gates');
  assert.equal(GATES.includes('bash-integration'), true, 'BRO-4150: land.yml must run test.yml\'s bash integration tests too');
  assert.equal(parseGateFailures('bash-integration', '::error::bash-integration gate failed: scripts/lib/x.test.sh (exit 1)').size, 1);
  assert.throws(() => parseGateFailures('nope', ''), /no parser/);
});

test('bash-integration (BRO-4150): keyed by failing FILE, so a NEW file failing on the branch refuses even while base is red on a different file', () => {
  const base = '── scripts/lib/a.test.sh\nboom\n::error::bash-integration gate failed: scripts/lib/a.test.sh (exit 1)\n::error::bash-integration failures:\n  - scripts/lib/a.test.sh\n';
  const branch = '── scripts/lib/a.test.sh\nboom\n::error::bash-integration gate failed: scripts/lib/a.test.sh (exit 1)\n── scripts/lib/b.test.sh\nboom\n::error::bash-integration gate failed: scripts/lib/b.test.sh (exit 1)\n::error::bash-integration failures:\n  - scripts/lib/a.test.sh\n  - scripts/lib/b.test.sh\n';
  assert.deepEqual([...parseBashIntegrationFailures(base).keys()], ['bash-integration::scripts/lib/a.test.sh']);
  const d = decideGateDelta({ gate: 'bash-integration', base: { exit: 1, text: base }, branch: { exit: 1, text: branch } });
  assert.equal(d.verdict, 'fail');
  assert.deepEqual(keys(d.newFailures), ['bash-integration::scripts/lib/b.test.sh']);
  assert.deepEqual(keys(d.preExisting), ['bash-integration::scripts/lib/a.test.sh']);
});

test('bash-integration: a file that stops failing on the branch is reported fixed, not new', () => {
  const base = '::error::bash-integration gate failed: scripts/lib/a.test.sh (exit 1)\n';
  const d = decideGateDelta({ gate: 'bash-integration', base: { exit: 1, text: base }, branch: { exit: 0, text: '' } });
  assert.equal(d.verdict, 'pass');
  assert.deepEqual(keys(d.fixed), ['bash-integration::scripts/lib/a.test.sh']);
});

test('multiplicity: a second identical tsc diagnostic in the same file is a NEW key (base had one, branch has two)', () => {
  const one = "src/a.ts(3,1): error TS2322: bad.\n";
  const two = `${one}src/a.ts(9,1): error TS2322: bad.\n`;
  assert.deepEqual([...parseTscFailures(two).keys()], ['src/a.ts::TS2322 bad.', 'src/a.ts::TS2322 bad. #2']);
  const d = decideGateDelta({ gate: 'tsc', base: { exit: 2, text: one }, branch: { exit: 2, text: two } });
  assert.equal(d.verdict, 'fail');
  assert.deepEqual(keys(d.newFailures), ['src/a.ts::TS2322 bad. #2']);
  const m = new Map(); addWithMultiplicity(m, 'f', 'n'); addWithMultiplicity(m, 'f', 'n'); addWithMultiplicity(m, 'f', 'n');
  assert.deepEqual([...m.keys()], ['f::n', 'f::n #2', 'f::n #3']);
});

test('lint-workflows: actionlint diagnostics are keyed individually (line:col dropped, ANSI stripped) so a NEW workflow error is new even while base is red on actionlint', () => {
  const base = '\x1b[36m.github/workflows/a.yml\x1b[0m:12:5: property "foo" is not defined [expression]\n::error::lint-workflows gate failed: actionlint (exit 1)\n';
  const branch = '.github/workflows/a.yml:14:5: property "foo" is not defined [expression]\n.github/workflows/land.yml:3:1: unexpected key "on" [syntax-check]\n::error::lint-workflows gate failed: actionlint (exit 1)\n';
  assert.deepEqual([...parseLintWorkflowsFailures(base).keys()], ['lint-workflows::actionlint .github/workflows/a.yml: property "foo" is not defined [expression]', 'lint-workflows::actionlint']);
  const d = decideGateDelta({ gate: 'lint-workflows', base: { exit: 1, text: base }, branch: { exit: 1, text: branch } });
  assert.equal(d.verdict, 'fail');
  assert.deepEqual(keys(d.newFailures), ['lint-workflows::actionlint .github/workflows/land.yml: unexpected key "on" [syntax-check]']);
  assert.equal(d.preExisting.length, 2);
});

test('decideAllGates + firstFailingGate: verdict order is GATES order and the first non-pass names the digest line', () => {
  const read = (dir, gate) => {
    if (dir === 'base') return { exit: 0, text: '' };
    if (gate === 'next-lint') return { exit: 1, text: "./src/a.ts\n1:1  Error: bad.  rule-x\n" };
    if (gate === 'lint-workflows') return { exit: 1, text: '::error::lint-workflows gate failed: actionlint (exit 1)\n' };
    return { exit: 0, text: '' };
  };
  const decisions = decideAllGates({ base: 'base', branch: 'branch', read });
  assert.deepEqual(decisions.map((d) => d.gate), GATES);
  assert.equal(firstFailingGate(decisions), 'next-lint');
  assert.equal(firstFailingGate(decisions.map((d) => ({ ...d, verdict: 'pass' }))), '');
});

test('formatSummary prints both sets (new + pre-existing) and the fixed set, with base/branch wall times', () => {
  const decisions = [{
    gate: 'unit-tests-node', verdict: 'fail', mode: 'delta', reason: 'r',
    newFailures: [{ file: 'a.test.mjs', name: 'new one' }],
    preExisting: [{ file: 'b.test.mjs', name: 'old one' }],
    fixed: [{ file: 'c.test.mjs', name: 'gone one' }],
  }];
  const md = formatSummary({ decisions, baseMeta: { sha: 'a'.repeat(40), wallMs: 400000 }, branchMeta: { sha: 'b'.repeat(40), wallMs: 380000 }, baseSource: 'cache hit' });
  assert.match(md, /NEW on the branch \(blocking\)[\s\S]*a\.test\.mjs::new one/);
  assert.match(md, /pre-existing on origin\/main[\s\S]*b\.test\.mjs::old one/);
  assert.match(md, /fixed by the branch[\s\S]*c\.test\.mjs::gone one/);
  assert.match(md, /base gauntlet: cache hit — sha `aaaaaaaaaa`, 400s wall/);
  assert.match(md, /branch gauntlet: ran now — sha `bbbbbbbbbb`, 380s wall/);
});

// ── the CLI over real result dirs (the shape scripts/lib/land-gauntlet.sh writes) ──

function resultDir(root, name, results, meta = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [gate, r] of Object.entries(results)) {
    fs.writeFileSync(path.join(dir, `${gate}.exit`), `${r.exit}\n`);
    fs.writeFileSync(path.join(dir, `${gate}.log`), r.text);
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ sha: 'c'.repeat(40), root: ROOT, wallMs: 1000, ...meta }));
  return dir;
}

function runCli(args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
}

test('CLI: same red gates on base and branch → exit 0, gate= empty, summary appended, GITHUB_OUTPUT written', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land-gate-delta-'));
  try {
    const red = { 'unit-tests-node': { exit: 1, text: tap(ROOT, [['tests/unit/a.test.mjs', 'image self-heal']]) }, 'lint-workflows': { exit: 1, text: '::error::lint-workflows gate failed: audit-venue-write-guard (exit 1)\n' } };
    const base = resultDir(tmp, 'base', red);
    const branch = resultDir(tmp, 'branch', red);
    const summary = path.join(tmp, 'summary.md');
    const ghout = path.join(tmp, 'out.txt');
    const r = runCli(['--base-dir', base, '--branch-dir', branch, '--gates', 'unit-tests-node,lint-workflows', '--summary-file', summary, '--github-output', ghout, '--base-source', 'cache hit']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS {2}unit-tests/);
    assert.match(r.stdout, /pre-existing .*tests\/unit\/a\.test\.mjs::image self-heal/);
    assert.doesNotMatch(r.stdout, /::error::/);
    assert.match(fs.readFileSync(ghout, 'utf8'), /^gate=\nnew_failures=0\npre_existing=2\nfixed=0\n$/m);
    assert.match(fs.readFileSync(summary, 'utf8'), /base gauntlet: cache hit/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI: a new failure → exit 1, gate=<first failing>, ::error:: annotation naming it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land-gate-delta-'));
  try {
    const base = resultDir(tmp, 'base', { 'unit-tests-node': { exit: 1, text: tap(ROOT, [['tests/unit/a.test.mjs', 'old']]) } });
    const branch = resultDir(tmp, 'branch', { 'unit-tests-node': { exit: 1, text: tap(ROOT, [['tests/unit/a.test.mjs', 'old'], ['tests/unit/z.test.mjs', 'brand new']]) } });
    const ghout = path.join(tmp, 'out.txt');
    const r = runCli(['--base-dir', base, '--branch-dir', branch, '--gates', 'unit-tests-node', '--github-output', ghout]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /::error::unit-tests-node: NEW failure on the branch .*tests\/unit\/z\.test\.mjs::brand new/);
    assert.match(fs.readFileSync(ghout, 'utf8'), /^gate=unit-tests-node$/m);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI: --strict / LAND_STRICT_GATES=1 ignores an existing base dir (the rollback switch)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land-gate-delta-'));
  try {
    const red = { tsc: { exit: 2, text: 'src/a.ts(1,1): error TS1: x\n' } };
    const base = resultDir(tmp, 'base', red);
    const branch = resultDir(tmp, 'branch', red);
    assert.equal(runCli(['--base-dir', base, '--branch-dir', branch, '--gates', 'tsc']).status, 0, 'delta: same failure → pass');
    const strict = runCli(['--base-dir', base, '--branch-dir', branch, '--gates', 'tsc', '--strict']);
    assert.equal(strict.status, 1, 'strict: any red → refuse');
    assert.match(strict.stdout, /strict mode \(LAND_STRICT_GATES=1\)/);
    const env = { ...process.env, LAND_STRICT_GATES: '1' }; delete env.NODE_TEST_CONTEXT;
    assert.equal(spawnSync(process.execPath, [CLI, '--base-dir', base, '--branch-dir', branch, '--gates', 'tsc'], { encoding: 'utf8', env }).status, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI: no base dir (never ran, cache miss AND run failed) → strict: branch red refuses; branch green passes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land-gate-delta-'));
  try {
    const red = resultDir(tmp, 'branch-red', { tsc: { exit: 2, text: 'src/a.ts(1,1): error TS1: x\n' } });
    const green = resultDir(tmp, 'branch-green', { tsc: { exit: 0, text: '' } });
    assert.equal(runCli(['--base-dir', path.join(tmp, 'missing'), '--branch-dir', red, '--gates', 'tsc']).status, 1);
    assert.equal(runCli(['--base-dir', path.join(tmp, 'missing'), '--branch-dir', green, '--gates', 'tsc']).status, 0);
    // main() in-process too (the exported entry point)
    assert.equal(main(['--base-dir', path.join(tmp, 'missing'), '--branch-dir', green, '--gates', 'tsc']), 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── the base cache key ───────────────────────────────────────────────────────

test('computeCodeTreeHash ignores INERT paths (bot data churn) and changes on any code path', () => {
  const sha = 'd'.repeat(40);
  const listing = (extra) => ['100644 blob aaaa\tscripts/lib/x.js', '100644 blob bbbb\t.github/workflows/land.yml', `100644 blob cccc\tdata/audit/ledger.json`, ...extra].join('\n');
  const a = computeCodeTreeHash(sha, { lsTree: () => listing([]) });
  const churn = computeCodeTreeHash(sha, { lsTree: () => listing(['100644 blob ffff\tdata/shows.json', '100644 blob eeee\tmemory/x.md', '100644 blob 1111\tpublic/data/shows/foo.json']) });
  const code = computeCodeTreeHash(sha, { lsTree: () => listing(['100644 blob 9999\tscripts/lib/y.js']) });
  const blobChange = computeCodeTreeHash(sha, { lsTree: () => listing([]).replace('aaaa', 'a2a2') });
  assert.equal(a.hash, churn.hash);
  assert.equal(a.kept, 2);
  assert.notEqual(a.hash, code.hash);
  assert.notEqual(a.hash, blobChange.hash);
  // "inert" by land-branch.js's rule but load-bearing for a gate verdict: in the key anyway
  for (const f of ['tests/unit-test-manifest.txt', 'tests/unit-test-manifest-tsx.txt', 'CLAUDE.md', 'tests/unit/foo.test.mjs', 'scripts/lib/claude-md-anchors.json']) {
    assert.equal(isCacheKeyRelevant(f), true, f);
    assert.notEqual(a.hash, computeCodeTreeHash(sha, { lsTree: () => listing([`100644 blob 7777\t${f}`]) }).hash, f);
  }
  for (const f of ['data/shows.json', 'memory/notes.md', 'docs/x.txt', 'data/audit/x.jsonl']) assert.equal(isCacheKeyRelevant(f), false, f);
  assert.throws(() => computeCodeTreeHash('short'), /40-hex/);
});

test('computeCodeTreeHash against a real git repo: a data-only commit keeps the key, a code commit changes it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land-gate-delta-git-'));
  const git = (args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['init', '-q', '--initial-branch=main']);
    git(['config', 'user.email', 't@e.st']); git(['config', 'user.name', 'test']);
    fs.mkdirSync(path.join(tmp, 'scripts')); fs.mkdirSync(path.join(tmp, 'data'));
    fs.writeFileSync(path.join(tmp, 'scripts', 'a.js'), '1\n'); fs.writeFileSync(path.join(tmp, 'data', 'd.json'), '{}\n');
    git(['add', '-A']); git(['commit', '-qm', 'c1']);
    const c1 = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(tmp, 'data', 'd.json'), '{"x":1}\n'); git(['add', '-A']); git(['commit', '-qm', 'churn']);
    const c2 = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(tmp, 'scripts', 'a.js'), '2\n'); git(['add', '-A']); git(['commit', '-qm', 'code']);
    const c3 = git(['rev-parse', 'HEAD']);
    const h1 = computeCodeTreeHash(c1, { cwd: tmp }), h2 = computeCodeTreeHash(c2, { cwd: tmp }), h3 = computeCodeTreeHash(c3, { cwd: tmp });
    assert.equal(h1.hash, h2.hash);
    assert.notEqual(h2.hash, h3.hash);
    const cli = runCli(['--code-hash', c2, '--cwd', tmp]);
    assert.equal(cli.status, 0);
    assert.equal(cli.stdout.trim(), h2.hash);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
