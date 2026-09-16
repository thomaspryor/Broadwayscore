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

  test('buildEnsembleDelegationArgs passes show/limit/dry-run through to the real pipeline', () => {
    const delegateArgs = buildEnsembleDelegationArgs({ showFilter: 'hamilton-2015', limit: 5, dryRun: true });
    assert.ok(delegateArgs.includes('scripts/llm-scoring/index.ts'));
    assert.ok(delegateArgs.includes('--ensemble'));
    assert.ok(delegateArgs.includes('--show=hamilton-2015'));
    assert.ok(delegateArgs.includes('--limit=5'));
    assert.ok(delegateArgs.includes('--dry-run'));
  });

  test('buildEnsembleDelegationArgs with no options omits per-show/limit/dry-run flags', () => {
    const delegateArgs = buildEnsembleDelegationArgs();
    assert.ok(delegateArgs.includes('--ensemble'));
    assert.ok(!delegateArgs.some((a) => a.startsWith('--show=')));
    assert.ok(!delegateArgs.some((a) => a.startsWith('--limit=')));
    assert.ok(!delegateArgs.includes('--dry-run'));
  });
});

describe('score-reviews-calibrated.js CLI', () => {
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
});
