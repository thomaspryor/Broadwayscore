// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — the detector under test
// never reads data/*.json; it only parses workflow YAML text.
/**
 * Unit tests for rule (ae), BRO-7306: a `run:` block that contains any `${{ }}`
 * is evaluated by GitHub as one expression with a 21,000 cap. Past it the
 * workflow file is invalid and nothing can start it. BRO-7198 pushed the
 * opening-night orchestrator's Polling loop over the cap and the orchestrator
 * could not run for a day. Pattern: require() the real function (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  expressionExpandedBytes,
  findOversizedExpressionRunBlocks,
  extractRunBlocks,
  EXPRESSION_MAX_LENGTH,
  EXPRESSION_BLOCK_WARN_BYTES,
} = require('../../scripts/lib/audit-workflow-hygiene-rules.js');

const ROOT = path.resolve(import.meta.dirname, '../..');
const WORKFLOWS = path.join(ROOT, '.github/workflows');
const ACTIONS = path.join(ROOT, '.github/actions');

const step = (body) => `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: big\n        run: |\n${body
  .split('\n')
  .map((l) => (l ? `          ${l}` : l))
  .join('\n')}\n      - name: after\n        run: echo done\n`;
const filler = (bytes) => Array.from({ length: Math.ceil(bytes / 50) }, (_, i) => `echo "line ${String(i).padStart(5, '0')} ${'x'.repeat(31)}"`).join('\n');

describe('expressionExpandedBytes', () => {
  test('a string with no expression is not an expression at all', () => {
    assert.strictEqual(expressionExpandedBytes('echo hello\n'.repeat(5000)), 0);
  });
  test('builds the format() call GitHub evaluates: quotes and braces doubled, expressions as arguments', () => {
    // format('a=''{0}'' b={{}} {1}', inputs.x, steps.s.outputs.y)
    const expected = "format('a=''{0}'' b={{}} {1}', inputs.x, steps.s.outputs.y)";
    assert.strictEqual(expressionExpandedBytes("a='${{ inputs.x }}' b={} ${{ steps.s.outputs.y }}"), expected.length);
  });
  test('counts UTF-8 bytes, so a non-ASCII comment costs more than its characters', () => {
    assert.ok(expressionExpandedBytes('# café — ${{ inputs.x }}') > expressionExpandedBytes('# cafe - ${{ inputs.x }}'));
  });
});

describe('findOversizedExpressionRunBlocks', () => {
  test('a large script with no expression passes', () => {
    assert.deepStrictEqual(findOversizedExpressionRunBlocks(step(filler(40000))), []);
  });
  test('the same large script with ONE expression is flagged, with its line', () => {
    const raw = step(`X="\${{ inputs.x }}"\n${filler(20000)}`);
    const hits = findOversizedExpressionRunBlocks(raw);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].expressions, 1);
    assert.strictEqual(hits[0].firstExpressionLine, 7);
    assert.ok(hits[0].bytes > EXPRESSION_BLOCK_WARN_BYTES);
  });
  test('a small script with expressions passes, and the next step is measured on its own', () => {
    assert.deepStrictEqual(findOversizedExpressionRunBlocks(step('echo "${{ inputs.x }}"\necho ok')), []);
  });
  test('block indentation is not counted (YAML strips it before GitHub sees the script)', () => {
    const body = `X="\${{ inputs.x }}"\n${filler(17000)}`;
    assert.deepStrictEqual(findOversizedExpressionRunBlocks(step(body)), []);
    assert.ok(Buffer.byteLength(step(body)) > EXPRESSION_BLOCK_WARN_BYTES, 'fixture only passes because indentation is stripped');
  });
  test('folded and strip-chomped block scalars and inline run lines are measured too', () => {
    const big = `X="\${{ inputs.x }}"\n${filler(20000)}`;
    for (const style of ['>', '|-', '>-']) {
      const raw = step(big).replace('run: |\n', `run: ${style}\n`);
      assert.strictEqual(findOversizedExpressionRunBlocks(raw).length, 1, `run: ${style}`);
    }
    const inline = `jobs:\n  a:\n    steps:\n      - run: echo "\${{ inputs.x }}" ${'y'.repeat(20000)}\n`;
    assert.strictEqual(findOversizedExpressionRunBlocks(inline).length, 1);
  });
  test('a composite action (steps under runs:) is measured the same way', () => {
    const raw = `name: a\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: |\n${`X="\${{ inputs.x }}"\n${filler(20000)}`.split('\n').map((l) => `        ${l}`).join('\n')}\n`;
    assert.strictEqual(findOversizedExpressionRunBlocks(raw).length, 1);
  });
  test('the incident itself: 21,020 is flagged, the last good 15,866 is not', () => {
    // The Polling loop's measured sizes before and after BRO-7198. The threshold must sit between them.
    assert.ok(EXPRESSION_BLOCK_WARN_BYTES > 15866 && EXPRESSION_BLOCK_WARN_BYTES < 21020);
    assert.ok(EXPRESSION_BLOCK_WARN_BYTES < EXPRESSION_MAX_LENGTH);
  });
});

describe('audit CLI wiring (rule ae reaches the exit code)', () => {
  const audit = path.join(ROOT, 'scripts/audit-workflow-hygiene.js');
  const runAudit = (body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-exprsize-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.yml'), body);
      for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, `inert-${i}.yml`), '# hygiene-notify-ok: inert fixture\n# hygiene-permissions-ok: inert fixture (BRO-6398 rule aa)\nname: inert\non: workflow_dispatch\njobs: {}\n');
      return spawnSync('node', [audit], { env: { ...process.env, HYGIENE_WORKFLOW_DIR: dir }, encoding: 'utf8' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const wf = (body) => `# hygiene-notify-ok: fixture\nname: x\non: workflow_dispatch\npermissions:\n  contents: read\n${step(body)}`;
  test('an oversized block with an expression fails the audit and names rule (ae)', () => {
    const r = runAudit(wf(`X="\${{ inputs.x }}"\n${filler(20000)}`));
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /\(ae\) run: block with/);
    assert.match(r.stderr, /x\.yml/);
  });
  test('the same block with the value passed through env passes', () => {
    const r = runAudit(wf(`X="$INPUT_X"\n${filler(20000)}`));
    assert.doesNotMatch(r.stderr, /\(ae\) run: block with/);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe('the repo itself', () => {
  const targets = fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(WORKFLOWS, f));
  for (const dir of fs.existsSync(ACTIONS) ? fs.readdirSync(ACTIONS) : []) {
    for (const base of ['action.yml', 'action.yaml']) {
      const full = path.join(ACTIONS, dir, base);
      if (fs.existsSync(full)) targets.push(full);
    }
  }
  test('scans a real workflow tree', () => {
    assert.ok(targets.length > 100, `only ${targets.length} files found`);
  });
  test('no run block holding ${{ }} is near the expression cap', () => {
    const bad = [];
    for (const full of targets) {
      for (const h of findOversizedExpressionRunBlocks(fs.readFileSync(full, 'utf8'))) {
        bad.push(`${path.relative(ROOT, full)}:${h.lineNum} ${h.bytes} bytes, ${h.expressions} expressions`);
      }
    }
    assert.deepStrictEqual(bad, [], 'move every ${{ }} in these blocks into the step env:');
  });
  test('BRO-7306 regression: one expression added back to the orchestrator Polling loop is caught', () => {
    const file = path.join(WORKFLOWS, 'opening-night-orchestrator.yml');
    const raw = fs.readFileSync(file, 'utf8');
    const marker = 'MAX_ITERATIONS=$MAX_ITERATIONS_OR_DEFAULT';
    assert.ok(raw.includes(marker), 'Polling loop no longer reads its iteration cap from env');
    const loop = extractRunBlocks(raw).find((b) => b.lines.some((l) => l.text.includes(marker)));
    assert.strictEqual(loop.lines.filter((l) => l.text.includes('${{')).length, 0, 'Polling loop must hold no ${{ }}');
    // Padded so this still bites if the loop is later slimmed: the claim is about the shape, not today's size.
    const pad = loop.lines[0].text.match(/^ */)[0] + '# ' + 'x'.repeat(100);
    const regressed = raw.replace(marker, `MAX_ITERATIONS=\${{ inputs.max_iterations || 10 }}\n${Array(200).fill(pad).join('\n')}`);
    const hits = findOversizedExpressionRunBlocks(regressed);
    assert.strictEqual(hits.length, 1, 'the exact BRO-7198 shape (big loop + an inline expression) must be flagged');
    assert.ok(hits[0].bytes > EXPRESSION_BLOCK_WARN_BYTES);
  });
});
