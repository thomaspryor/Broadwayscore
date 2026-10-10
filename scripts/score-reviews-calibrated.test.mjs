/**
 * BRO-929: single-model llmScore from score-reviews-calibrated.js has no
 * ensembleData and rebuild-all-reviews.js silently rejects it
 * (scripts/lib/rebuild-helpers.js `inc('blockedSingleModel')`). Covers the
 * acceptance criteria: running without ensemble args must warn, and --ensemble
 * must delegate to the real multi-model pipeline instead of scoring single-model.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildSingleModelWarning, buildEnsembleDelegationArgs } = require('./lib/single-model-warning.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, 'score-reviews-calibrated.js');

describe('single-model-warning lib', () => {
  test('warning names the rejection mechanism and the --ensemble fix', () => {
    const warning = buildSingleModelWarning();
    assert.match(warning, /ensembleData/);
    assert.match(warning, /--ensemble/);
    assert.match(warning, /reject/i);
  });

  test('buildEnsembleDelegationArgs passes show/limit/dry-run/max-cost through to the real pipeline', () => {
    const delegateArgs = buildEnsembleDelegationArgs({ showFilter: 'hamilton-2015', limit: 5, dryRun: true, maxCost: 5 });
    assert.ok(delegateArgs.includes('scripts/llm-scoring/index.ts'));
    assert.ok(delegateArgs.includes('--ensemble'));
    assert.ok(delegateArgs.includes('--show=hamilton-2015'));
    assert.ok(delegateArgs.includes('--limit=5'));
    assert.ok(delegateArgs.includes('--dry-run'));
    assert.ok(delegateArgs.includes('--max-cost=5'));
  });

  test('buildEnsembleDelegationArgs always includes --upgrade-ensemble (the real "single-model, no ensembleData" selector)', () => {
    // Plain --ensemble alone defaults the pipeline to unscoredOnly, which SKIPS
    // every review this script already wrote llmScore to — exactly the reviews
    // BRO-929 needs fixed. --upgrade-ensemble is the selector that actually
    // targets them (scripts/llm-scoring/index.ts ~line 1091).
    const delegateArgs = buildEnsembleDelegationArgs();
    assert.ok(delegateArgs.includes('--ensemble'));
    assert.ok(delegateArgs.includes('--upgrade-ensemble'));
  });

  test('buildEnsembleDelegationArgs with no options omits per-show/limit/dry-run/max-cost flags', () => {
    const delegateArgs = buildEnsembleDelegationArgs();
    assert.ok(!delegateArgs.some((a) => a.startsWith('--show=')));
    assert.ok(!delegateArgs.some((a) => a.startsWith('--limit=')));
    assert.ok(!delegateArgs.includes('--dry-run'));
    assert.ok(!delegateArgs.some((a) => a.startsWith('--max-cost=')));
  });
});

describe('score-reviews-calibrated.js CLI', () => {
  test('--help prints usage and exits without touching ANTHROPIC_API_KEY or network', () => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const output = execFileSync('node', [scriptPath, '--help'], { env, encoding: 'utf8' });
    assert.match(output, /score-reviews-calibrated\.js/);
    assert.match(output, /--ensemble/);
  });

  test('warns about ensemble rejection before the API-key check fires', () => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    let output = '';
    let status = 0;
    try {
      output = execFileSync('node', [scriptPath, '--dry-run'], { env, encoding: 'utf8' });
    } catch (e) {
      output = (e.stdout || '') + (e.stderr || '');
      status = e.status;
    }
    assert.strictEqual(status, 1);
    assert.match(output, /ensembleData/);
    assert.match(output, /--ensemble/);
    assert.match(output, /ANTHROPIC_API_KEY/);
  });

  test('--ensemble --calibration-only is rejected instead of silently mis-selecting', () => {
    // The calibration set and --upgrade-ensemble's "single-model, no ensembleData"
    // selector are different populations — delegating would silently score the
    // wrong reviews (Codex review finding, BRO-929).
    let output = '';
    let status = 0;
    try {
      output = execFileSync('node', [scriptPath, '--ensemble', '--calibration-only'], { encoding: 'utf8' });
    } catch (e) {
      output = (e.stdout || '') + (e.stderr || '');
      status = e.status;
    }
    assert.strictEqual(status, 1);
    assert.match(output, /--calibration-only/);
  });

  test('--ensemble --force is rejected instead of silently ignoring --force', () => {
    let output = '';
    let status = 0;
    try {
      output = execFileSync('node', [scriptPath, '--ensemble', '--force'], { encoding: 'utf8' });
    } catch (e) {
      output = (e.stdout || '') + (e.stderr || '');
      status = e.status;
    }
    assert.strictEqual(status, 1);
    assert.match(output, /--force/);
  });
});
