import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { sourceRequires, dependencyGraph, commandEvents, conditionCovered, auditWorkflow, auditDirectory } = require('./lib/missing-deps.js');
const { MIN_EXPECTED_WORKFLOWS } = require('./lib/workflow-glob-guard.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(root, '.tmp-missing-deps-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(scratch, 'case-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function workflow(steps, secondJob = '') {
  // hygiene-permissions-ok: fixtures are not real workflows (rule (aa), BRO-6398)
  return `# hygiene-permissions-ok: fixture\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n${secondJob}`;
}

test('AST distinguishes eager, guarded and lazy requires without matching prose', () => {
  const deps = sourceRequires(`
    // require('comment-only')
    const prose = "require('string-only')";
    require('cheerio');
    function later() { require('playwright'); }
    const arrow = () => require('axios');
    try { require('sharp'); } catch { require('catch-dep'); }
    try { require('unguarded'); } finally { require('finally-dep'); }
    if (process.env.FLAG) require('conditional');
    (() => require('iife'))();
    return;
  `);
  assert.deepEqual(deps.map(({ specifier, kind }) => [specifier, kind]), [
    ['cheerio', 'eager'], ['playwright', 'lazy'], ['axios', 'lazy'],
    ['sharp', 'guarded'], ['catch-dep', 'eager'], ['unguarded', 'eager'],
    ['finally-dep', 'eager'], ['conditional', 'eager'], ['iife', 'eager'],
  ]);
});

test('graph follows real local code, cycles, scoped packages and package subpaths', () => {
  const dir = fixture({
    'scripts/main.js': "require('node:fs'); require('fs/promises'); require('./lib/helper'); require('./data.json');",
    'scripts/data.json': '{"message":"not JavaScript"}',
    'scripts/lib/helper.js': "require('../main'); require('@scope/sdk/client'); require('entities/decode');",
  });
  const result = dependencyGraph(path.join(dir, 'scripts/main.js'));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.packages.map(x => x.package), ['@scope/sdk', 'entities']);
  assert.equal(result.packages[0].chain.length, 2);
});

test('a guarded or lazy local import keeps transitive package requires optional', () => {
  const dir = fixture({
    'scripts/main.js': "try { require('./guarded'); } catch {} function f() { require('./lazy'); } require('./eager');",
    'scripts/guarded.js': "require('sharp');",
    'scripts/lazy.js': "require('playwright');",
    'scripts/eager.js': "require('cheerio');",
  });
  assert.deepEqual(dependencyGraph(path.join(dir, 'scripts/main.js')).packages.map(x => [x.package, x.kind]), [
    ['sharp', 'guarded'], ['playwright', 'lazy'], ['cheerio', 'eager'],
  ]);
});

test('ES module imports and reexports load eagerly', () => {
  assert.deepEqual(sourceRequires("import x from 'cheerio'; export { y } from 'axios'; export * from '@scope/sdk';").map(x => x.specifier),
    ['cheerio', 'axios', '@scope/sdk']);
});

test('shell commands exclude echo, comments, inline JS and heredoc issue bodies', () => {
  assert.deepEqual(commandEvents(`
    # node scripts/comment.js
    echo "Running: node scripts/echo.js"
    node -e 'console.log("node scripts/string.js")'
    cat <<'BODY'
    node scripts/issue-body.js
    BODY
    RESULTS=$(node scripts/real.js)
    timeout 600 node './scripts/second.js' | tee out
    npm ci --ignore-scripts && node scripts/third.js
  `), [
    { type: 'script', script: 'scripts/real.js' },
    { type: 'script', script: 'scripts/second.js' },
    { type: 'install' }, { type: 'script', script: 'scripts/third.js' },
  ]);
});

test('raw setup-node and npm cache do not install dependencies; transitive eager requires are reported', () => {
  const dir = fixture({ 'scripts/main.js': "require('./helper');", 'scripts/helper.js': "require('cheerio');" });
  const result = auditWorkflow(workflow(`      - uses: actions/setup-node@v5
        with:
          cache: npm
      - run: node scripts/main.js`), { root: dir });
  assert.deepEqual(result.findings.map(x => ({ job: x.job, packages: x.packages })), [{ job: 'check', packages: ['cheerio'] }]);
  assert.deepEqual(result.errors, []);
});

test('install order is job scoped, and an install afterwards cannot hide a crash', () => {
  const dir = fixture({ 'scripts/main.js': "require('cheerio');" });
  const result = auditWorkflow(workflow(`      - run: node scripts/main.js
      - run: npm ci
      - run: node scripts/main.js`, `  other:
    steps:
      - run: node scripts/main.js`), { root: dir });
  assert.deepEqual(result.findings.map(x => x.job), ['check', 'other']);
});

test('shared setup action, plain npm install and npm ci fallback satisfy the graph', () => {
  const dir = fixture({ 'scripts/main.js': "require('cheerio');" });
  for (const setup of ['uses: ./.github/actions/setup-node', 'run: npm ci', 'run: npm install', 'run: npm ci || npm install', 'run: npm ci\n        continue-on-error: false']) {
    assert.deepEqual(auditWorkflow(workflow(`      - ${setup}\n      - run: node scripts/main.js`), { root: dir }).findings, [], setup);
  }
});

test('conditional installs cover only scripts whose condition implies the install condition', () => {
  assert.equal(conditionCovered("a && b", 'a'), true);
  assert.equal(conditionCovered('a', 'a || b'), true);
  assert.equal(conditionCovered('b', 'a'), false);
  assert.equal(conditionCovered('a || b', 'a'), false);
  const dir = fixture({ 'scripts/main.js': "require('cheerio');" });
  const result = auditWorkflow(workflow(`      - run: npm ci
        if: \${{ steps.find.outputs.has_shows == 'true' }}
      - run: node scripts/main.js
        if: steps.find.outputs.has_shows == 'true' && steps.find.outputs.heavy == 'true'
      - run: node scripts/main.js`), { root: dir });
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.scripts.map(x => x.installed), [true, false]);
});

test('partial, subdirectory and failure-tolerant installs do not prove dependencies are present', () => {
  const dir = fixture({ 'scripts/main.js': "require('cheerio');" });
  for (const install of [
    'run: npm install axios', 'run: npm ci --omit=dev', 'run: npm ci --prefix elsewhere',
    'run: npm ci\n        working-directory: elsewhere', 'run: npm ci\n        continue-on-error: true',
    'run: npm ci || true', 'run: if false; then npm ci; fi', 'run: false && npm ci',
  ]) {
    assert.equal(auditWorkflow(workflow(`      - ${install}\n      - run: node scripts/main.js`), { root: dir }).findings.length, 1, install);
  }
});

test('unknown syntax or a missing local file produces a coverage diagnostic', () => {
  const dir = fixture({ 'scripts/main.js': "require('./absent');", 'scripts/broken.js': 'const = ;' });
  const result = auditWorkflow(workflow(`      - run: node scripts/main.js
      - run: node scripts/broken.js`), { root: dir });
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0].error, /Unresolved local module/);
  assert.match(result.errors[1].error, /Unexpected token/);
});

test('directory audit exposes findings without running any audited script', () => {
  const dir = fixture({
    'scripts/main.js': "require('cheerio'); throw new Error('must never execute');",
    'workflows/check.yml': workflow('      - run: node scripts/main.js'),
    'workflows/README.md': 'ignored',
  });
  const result = auditDirectory(path.join(dir, 'workflows'), dir);
  assert.equal(result.findings[0].workflow, 'check.yml');
  assert.deepEqual(result.findings[0].packages, ['cheerio']);
});

test('real workflow cases: optional entities, optional sharp, lazy browser fallback and prose are excluded', () => {
  const cache = new Map();
  for (const name of ['check-cookie-health', 'daily-digest', 'update-lbo', 'opening-night-stage-alert']) {
    const raw = fs.readFileSync(path.join(root, '.github/workflows', name + '.yml'), 'utf8');
    const result = auditWorkflow(raw, { root, cache });
    assert.deepEqual(result.findings, [], name);
    assert.deepEqual(result.errors, [], name);
    if (name === 'opening-night-stage-alert') assert.deepEqual([...new Set(result.scripts.map(x => x.script))].sort(), ['scripts/check-opening-night-scored.js', 'scripts/route-workflow-alerts.js']); // route-workflow-alerts.js: BRO-6397
  }
});

test('existing hygiene caller emits missing-deps warnings without failing its gate', () => {
  const dir = fixture({
    'workflows/check.yml': workflow('      - run: node scripts/probe-scrapingdog-billing.js'),
  });
  // Exercise the advisory rule within a complete workflow inventory, as the
  // production caller now rejects small inventories before evaluating rules.
  for (let i = 1; i < MIN_EXPECTED_WORKFLOWS; i++) {
    fs.writeFileSync(path.join(dir, 'workflows', `padding-${i}.yml`), '# hygiene-permissions-ok: fixture\njobs: {}\n');
  }
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/audit-workflow-hygiene.js')], {
    cwd: root,
    env: { ...process.env, HYGIENE_WORKFLOW_DIR: path.join(dir, 'workflows'), HYGIENE_NEVER_RUN_SCAN: '0' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /::warning::missing-deps: check\.yml job check runs scripts\/probe-scrapingdog-billing\.js.*axios/);
  assert.match(result.stdout, /missing-deps \(advisory\): 1 script invocation\(s\), 1 unmet eager dependency graph\(s\)/);
});
