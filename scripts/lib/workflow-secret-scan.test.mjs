import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  parseWorkflowFile,
  groupByMinIndent,
  extractScriptInvocations,
  resolveModulePath,
  extractLocalDeps,
  buildRequirerCounts,
  collectTransitiveSource,
  extractEnvReads,
  collectKnownSecrets,
  collectExemptions,
} = require('./workflow-secret-scan.js');
const { findGaps } = require('../audit-workflow-secret-gaps.js');

// --- parseWorkflowFile -------------------------------------------------

const SAMPLE_WORKFLOW = `
name: Sample
on:
  workflow_dispatch:

env:
  TOP_LEVEL_VAR: 'x'

jobs:
  checklist:
    runs-on: ubuntu-latest
    env:
      JOB_LEVEL_VAR: 'y'
    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Run checklist
        # a comment interspersed between env keys, matching real repo style
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          # note about this one
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          node scripts/opening-night-checklist.js --json --out=/tmp/out.json
          echo "done"

      - name: Single line run
        run: node scripts/other.js --flag
`;

test('parseWorkflowFile: extracts workflow-level, job-level, and step-level env keys', () => {
  const { workflowEnv, jobs } = parseWorkflowFile(SAMPLE_WORKFLOW);
  assert.deepEqual([...workflowEnv], ['TOP_LEVEL_VAR']);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, 'checklist');
  assert.deepEqual([...jobs[0].env], ['JOB_LEVEL_VAR']);
  assert.equal(jobs[0].steps.length, 3);
});

test('parseWorkflowFile: step env keys survive interspersed comments (real repo pattern)', () => {
  const { jobs } = parseWorkflowFile(SAMPLE_WORKFLOW);
  const step = jobs[0].steps[1];
  assert.equal(step.name, 'Run checklist');
  assert.deepEqual([...step.env].sort(), ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN']);
});

test('parseWorkflowFile: block-scalar (run: |) multi-line text preserved', () => {
  const { jobs } = parseWorkflowFile(SAMPLE_WORKFLOW);
  const step = jobs[0].steps[1];
  assert.match(step.run, /node scripts\/opening-night-checklist\.js/);
  assert.match(step.run, /echo "done"/);
});

test('parseWorkflowFile: single-line run: scalar captured', () => {
  const { jobs } = parseWorkflowFile(SAMPLE_WORKFLOW);
  const step = jobs[0].steps[2];
  assert.equal(step.run.trim(), 'node scripts/other.js --flag');
});

test('parseWorkflowFile: a uses:-only step has no run text and empty env', () => {
  const { jobs } = parseWorkflowFile(SAMPLE_WORKFLOW);
  const step = jobs[0].steps[0];
  assert.equal(step.run, '');
  assert.equal(step.env.size, 0);
});

// --- groupByMinIndent invariant -----------------------------------------

test('groupByMinIndent: ignores comment-only and blank lines when finding siblings', () => {
  const toLines = (raw) =>
    raw.split('\n').map((text) => ({ raw: text, indent: text.match(/^(\s*)/)[1].length, trimmed: text.trim() }));
  const lines = toLines('a: 1\n\n# comment\nb: 2\n');
  const children = groupByMinIndent(lines);
  assert.equal(children.length, 2);
});

// --- extractScriptInvocations --------------------------------------------

test('extractScriptInvocations: plain node invocation', () => {
  assert.deepEqual(extractScriptInvocations('node scripts/foo.js --flag'), ['scripts/foo.js']);
});

test('extractScriptInvocations: node with flags before the script path', () => {
  assert.deepEqual(
    extractScriptInvocations('node --max-old-space-size=4096 scripts/foo.js'),
    ['scripts/foo.js']
  );
});

test('extractScriptInvocations: npx tsx and npx ts-node forms', () => {
  assert.deepEqual(extractScriptInvocations('npx tsx scripts/llm-scoring/index.ts'), [
    'scripts/llm-scoring/index.ts',
  ]);
  assert.deepEqual(extractScriptInvocations('npx ts-node scripts/foo.ts'), ['scripts/foo.ts']);
});

test('extractScriptInvocations: multiple invocations in one multi-line block', () => {
  const run = 'node scripts/a.js\nif [ -s x ]; then node scripts/b.js; fi\n';
  assert.deepEqual(extractScriptInvocations(run).sort(), ['scripts/a.js', 'scripts/b.js']);
});

test('extractScriptInvocations: no match for shell-only run text', () => {
  assert.deepEqual(extractScriptInvocations('echo "hello" && exit 0'), []);
});

// --- extractEnvReads -------------------------------------------------------

test('extractEnvReads: dot access', () => {
  assert.deepEqual([...extractEnvReads("const k = process.env.ANTHROPIC_API_KEY;")], ['ANTHROPIC_API_KEY']);
});

test('extractEnvReads: bracket access', () => {
  assert.deepEqual([...extractEnvReads("const k = process.env['ANTHROPIC_API_KEY'];")], ['ANTHROPIC_API_KEY']);
});

test('extractEnvReads: destructured access, ignores renamed/lowercase parts', () => {
  const reads = extractEnvReads('const { ANTHROPIC_API_KEY, other: renamed } = process.env;');
  assert.ok(reads.has('ANTHROPIC_API_KEY'));
  assert.equal(reads.size, 1);
});

// --- collectKnownSecrets / collectExemptions -------------------------------

test('collectKnownSecrets: only secrets.X references count', () => {
  const raw = "env:\n  A: ${{ secrets.FOO_TOKEN }}\n  B: ${{ vars.NOT_A_SECRET }}\n";
  const known = collectKnownSecrets([raw]);
  assert.ok(known.has('FOO_TOKEN'));
  assert.ok(!known.has('NOT_A_SECRET'));
});

test('collectKnownSecrets: also recognizes secrets[\'X\'] bracket form', () => {
  const raw = 'env:\n  A: ${{ secrets[\'BRACKET_TOKEN\'] }}\n';
  const known = collectKnownSecrets([raw]);
  assert.ok(known.has('BRACKET_TOKEN'));
});

test('collectExemptions: parses the audit-secret-gap-ok comment convention', () => {
  const raw = '# audit-secret-gap-ok: SOME_SECRET\nname: x\n';
  const exempt = collectExemptions(raw);
  assert.ok(exempt.has('SOME_SECRET'));
});

// --- resolveModulePath / extractLocalDeps ----------------------------------

test('resolveModulePath: relative require resolves against fromDir', () => {
  const resolved = resolveModulePath(path.join(__dirname), './workflow-secret-scan.js');
  assert.equal(resolved, path.join(__dirname, 'workflow-secret-scan.js'));
});

test('resolveModulePath: repo-rooted path (no leading dot) resolves against fromDir too — the actual bug fixed during development (was previously left relative and never matched STOP-list absolute paths)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const resolved = resolveModulePath(repoRoot, 'scripts/lib/workflow-secret-scan.js');
  assert.equal(resolved, path.join(repoRoot, 'scripts', 'lib', 'workflow-secret-scan.js'));
});

test('resolveModulePath: returns null for a nonexistent file', () => {
  assert.equal(resolveModulePath(__dirname, './does-not-exist-9999.js'), null);
});

test('extractLocalDeps: dynamic same-directory glob-require heuristic pulls in sibling files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wss-dynreq-'));
  try {
    const loaderPath = path.join(tmpDir, 'loader.js');
    fs.writeFileSync(
      loaderPath,
      "const fs = require('fs');\nconst path = require('path');\nconst DIR = __dirname;\nfs.readdirSync(DIR).map(f => require(path.join(DIR, f)));\n"
    );
    fs.writeFileSync(path.join(tmpDir, 'sibling.js'), "module.exports = { x: process.env.SIBLING_SECRET };\n");
    const src = fs.readFileSync(loaderPath, 'utf8');
    const deps = extractLocalDeps(src, loaderPath);
    assert.ok(deps.some((d) => d.endsWith('sibling.js')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// --- buildRequirerCounts / collectTransitiveSource: shared-module threshold

test('buildRequirerCounts + collectTransitiveSource: a module required by many files is excluded from tracing (shared-infra heuristic)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wss-shared-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'shared.js'), 'module.exports.x = process.env.SHARED_SECRET;\n');
    // 6 distinct requirers — over SHARED_MODULE_THRESHOLD (5)
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(tmpDir, `caller${i}.js`), `require('./shared.js');\n`);
    }
    fs.writeFileSync(path.join(tmpDir, 'entry.js'), "require('./caller0.js');\n");

    const requirerCounts = buildRequirerCounts(tmpDir);
    const entryAbs = path.join(tmpDir, 'entry.js');
    const src = collectTransitiveSource(entryAbs, { requirerCounts });
    const reads = extractEnvReads(src);
    assert.ok(!reads.has('SHARED_SECRET'), 'shared.js should be excluded once required by >5 files');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('collectTransitiveSource: a shared module WITH the always-trace marker IS traced despite being over threshold (owner-alert-router.js shape, 2026-08-31 incident)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wss-always-trace-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'gateway.js'),
      '// audit-secret-scan-always-trace: hard dependency, no fallback\nmodule.exports.x = process.env.GATEWAY_SECRET;\n'
    );
    // 6 distinct requirers — over SHARED_MODULE_THRESHOLD (5) — but the
    // marker above must override the threshold exclusion.
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(tmpDir, `caller${i}.js`), `require('./gateway.js');\n`);
    }
    fs.writeFileSync(path.join(tmpDir, 'entry.js'), "require('./caller0.js');\n");

    const requirerCounts = buildRequirerCounts(tmpDir);
    const entryAbs = path.join(tmpDir, 'entry.js');
    const src = collectTransitiveSource(entryAbs, { requirerCounts });
    const reads = extractEnvReads(src);
    assert.ok(reads.has('GATEWAY_SECRET'), 'a marked file must be traced even when required by >5 files');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('collectTransitiveSource: the always-trace marker only rescues the marked file, not its own high-fanout deps — a second hop needs its own marker', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wss-always-trace-chain-'));
  try {
    // gateway.js is marked and required by >5 files, but its own dependency
    // (unmarked-shared.js) is ALSO required by >5 files independently —
    // mirrors linear-client.js needing its OWN marker, not just
    // owner-alert-router.js's, to survive the BFS.
    fs.writeFileSync(
      path.join(tmpDir, 'gateway.js'),
      "// audit-secret-scan-always-trace\nrequire('./unmarked-shared.js');\n"
    );
    fs.writeFileSync(
      path.join(tmpDir, 'unmarked-shared.js'),
      'module.exports.x = process.env.DEEP_SECRET;\n'
    );
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(tmpDir, `gwcaller${i}.js`), `require('./gateway.js');\n`);
      fs.writeFileSync(path.join(tmpDir, `deepcaller${i}.js`), `require('./unmarked-shared.js');\n`);
    }
    fs.writeFileSync(path.join(tmpDir, 'entry.js'), "require('./gwcaller0.js');\n");

    const requirerCounts = buildRequirerCounts(tmpDir);
    const entryAbs = path.join(tmpDir, 'entry.js');
    const src = collectTransitiveSource(entryAbs, { requirerCounts });
    const reads = extractEnvReads(src);
    assert.ok(!reads.has('DEEP_SECRET'), 'an unmarked high-fanout second hop must still be excluded');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('collectTransitiveSource: a narrowly-used module (below threshold) IS traced — the real BRO-67 shape (multi-hop through a small number of specific callers)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wss-narrow-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'narrow.js'), 'module.exports.x = process.env.NARROW_SECRET;\n');
    fs.writeFileSync(path.join(tmpDir, 'caller.js'), "require('./narrow.js');\n");
    fs.writeFileSync(path.join(tmpDir, 'entry.js'), "require('./caller.js');\n");

    const requirerCounts = buildRequirerCounts(tmpDir);
    const entryAbs = path.join(tmpDir, 'entry.js');
    const src = collectTransitiveSource(entryAbs, { requirerCounts });
    const reads = extractEnvReads(src);
    assert.ok(reads.has('NARROW_SECRET'), 'a module with 1 requirer must still be traced');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// --- End-to-end: findGaps against a synthetic fixture repo -----------------

function makeFixtureRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wss-fixture-repo-'));
  const workflowDir = path.join(repoRoot, '.github', 'workflows');
  const scriptsDir = path.join(repoRoot, 'scripts');
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  return { repoRoot, workflowDir, scriptsDir };
}

test('findGaps: flags a step whose script reads a secret that is referenced elsewhere as a real secret but never wired into that step', () => {
  const { repoRoot, workflowDir, scriptsDir } = makeFixtureRepo();
  try {
    fs.writeFileSync(
      path.join(scriptsDir, 'needs-secret.js'),
      "const key = process.env.FIXTURE_API_KEY;\nif (!key) { console.log('degraded, no-op'); }\n"
    );
    fs.writeFileSync(
      path.join(workflowDir, 'fixture-missing.yml'),
      [
        'name: Fixture Missing Secret',
        'on:',
        '  workflow_dispatch:',
        'jobs:',
        '  run:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Run it',
        '        run: node scripts/needs-secret.js',
        '      - name: Some other step that references the secret so it is a KNOWN secret',
        '        env:',
        '          UNRELATED: ${{ secrets.FIXTURE_API_KEY }}',
        '        run: echo unrelated',
        '',
      ].join('\n')
    );

    const gaps = findGaps(workflowDir, { repoRoot, scriptsDir });
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].secret, 'FIXTURE_API_KEY');
    assert.equal(gaps[0].step, 'Run it');
    assert.equal(gaps[0].script, 'scripts/needs-secret.js');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('findGaps: does NOT flag when the secret is wired into the step env', () => {
  const { repoRoot, workflowDir, scriptsDir } = makeFixtureRepo();
  try {
    fs.writeFileSync(path.join(scriptsDir, 'needs-secret.js'), 'const key = process.env.FIXTURE_API_KEY;\n');
    fs.writeFileSync(
      path.join(workflowDir, 'fixture-provided.yml'),
      [
        'name: Fixture Provided Secret',
        'on:',
        '  workflow_dispatch:',
        'jobs:',
        '  run:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Run it',
        '        env:',
        '          FIXTURE_API_KEY: ${{ secrets.FIXTURE_API_KEY }}',
        '        run: node scripts/needs-secret.js',
        '',
      ].join('\n')
    );

    const gaps = findGaps(workflowDir, { repoRoot, scriptsDir });
    assert.deepEqual(gaps, []);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('findGaps: does NOT flag when the secret is wired at job level', () => {
  const { repoRoot, workflowDir, scriptsDir } = makeFixtureRepo();
  try {
    fs.writeFileSync(path.join(scriptsDir, 'needs-secret.js'), 'const key = process.env.FIXTURE_API_KEY;\n');
    fs.writeFileSync(
      path.join(workflowDir, 'fixture-job-level.yml'),
      [
        'name: Fixture Job Level Secret',
        'on:',
        '  workflow_dispatch:',
        'jobs:',
        '  run:',
        '    runs-on: ubuntu-latest',
        '    env:',
        '      FIXTURE_API_KEY: ${{ secrets.FIXTURE_API_KEY }}',
        '    steps:',
        '      - name: Run it',
        '        run: node scripts/needs-secret.js',
        '',
      ].join('\n')
    );

    const gaps = findGaps(workflowDir, { repoRoot, scriptsDir });
    assert.deepEqual(gaps, []);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('findGaps: `# audit-secret-gap-ok:` comment suppresses a known false positive', () => {
  const { repoRoot, workflowDir, scriptsDir } = makeFixtureRepo();
  try {
    fs.writeFileSync(path.join(scriptsDir, 'needs-secret.js'), 'const key = process.env.FIXTURE_API_KEY;\n');
    fs.writeFileSync(
      path.join(workflowDir, 'fixture-exempt.yml'),
      [
        '# audit-secret-gap-ok: FIXTURE_API_KEY',
        'name: Fixture Exempt',
        'on:',
        '  workflow_dispatch:',
        'jobs:',
        '  run:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Run it',
        '        run: node scripts/needs-secret.js',
        '      - name: Reference the secret elsewhere',
        '        env:',
        '          UNRELATED: ${{ secrets.FIXTURE_API_KEY }}',
        '        run: echo unrelated',
        '',
      ].join('\n')
    );

    const gaps = findGaps(workflowDir, { repoRoot, scriptsDir });
    assert.deepEqual(gaps, []);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('findGaps: a missing env var that is never referenced anywhere as ${{ secrets.X }} is NOT flagged (not a known repo secret)', () => {
  const { repoRoot, workflowDir, scriptsDir } = makeFixtureRepo();
  try {
    fs.writeFileSync(path.join(scriptsDir, 'needs-var.js'), 'const v = process.env.SOME_LOCAL_CONFIG_VAR;\n');
    fs.writeFileSync(
      path.join(workflowDir, 'fixture-not-a-secret.yml'),
      [
        'name: Fixture Not A Secret',
        'on:',
        '  workflow_dispatch:',
        'jobs:',
        '  run:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Run it',
        '        run: node scripts/needs-var.js',
        '',
      ].join('\n')
    );

    const gaps = findGaps(workflowDir, { repoRoot, scriptsDir });
    assert.deepEqual(gaps, []);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// --- Regression floor against the real repo --------------------------------

test('findGaps: the 3 specific BRO-67 steps no longer show an ANTHROPIC_API_KEY gap on main', () => {
  // Deliberately narrowed to the exact 3 (workflow, step) pairs the BRO-67
  // fix touched, NOT "every ANTHROPIC_API_KEY gap in these 3 files" — that
  // broader assertion briefly failed in development on a 4th, DIFFERENT step
  // (opening-night-orchestrator.yml's "Send opening night status to
  // Discord" -> scripts/opening-night-status.js), which turned out to be a
  // genuine false positive of the documented over-approximation kind: that
  // script only calls opening-night-poller.js's checkReadiness/
  // getMissingT1T2Outlets (re-exported from scripts/lib/opening-night-
  // readiness.js, no LLM involved), but poller.js's own file-level code
  // separately requires lib/llm-extractor.js for an unrelated code path
  // (SERP discovery), so the trace correctly-but-uselessly attributes that
  // read to every caller of the whole file. A real bug there, if any, is a
  // job for a human triaging that specific advisory finding — not this
  // regression floor, which exists only to prove the ALREADY-FIXED bug
  // stays fixed.
  const ROOT = path.resolve(__dirname, '..', '..');
  const workflowDir = path.join(ROOT, '.github', 'workflows');
  const gaps = findGaps(workflowDir);
  const fixedSteps = [
    ['opening-night-checklist.yml', 'Run opening night checklist'],
    ['opening-night-poller.yml', 'Run poller for each show'],
    ['opening-night-orchestrator.yml', 'Run opening night checklist + SLA dispatch'],
  ];
  const stillBroken = gaps.filter(
    (g) => g.secret === 'ANTHROPIC_API_KEY' && fixedSteps.some(([wf, step]) => g.workflow === wf && g.step === step)
  );
  assert.deepEqual(stillBroken, []);
});

test('findGaps: no self-referential gap from this tool describing its own regex shapes in doc comments (codex ship-check finding, task #1855)', () => {
  // The tool's own docstrings used to contain literal example text like
  // `process.env.X` and `${{ secrets.X }}`, which the regex scanners (which
  // do not distinguish code from comments/prose) matched against themselves —
  // producing a spurious "test.yml reads secret X" finding on every run.
  const ROOT = path.resolve(__dirname, '..', '..');
  const workflowDir = path.join(ROOT, '.github', 'workflows');
  const gaps = findGaps(workflowDir);
  assert.deepEqual(
    gaps.filter((g) => g.workflow === 'test.yml' && g.script === 'scripts/audit-workflow-secret-gaps.js'),
    []
  );
});
