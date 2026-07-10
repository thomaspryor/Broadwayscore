/**
 * Guard: the LLM-scoring production paths must use the canonical Claude model from
 * scripts/lib/models.js (CLAUDE_SONNET), never a hardcoded retired pin.
 *
 * Rationale (Notion 386637c5-416f-8147): the ensemble hardcoded
 * claude-sonnet-4-20250514, which reached EOL 2026-06-15 and now returns
 * not_found_error. The Claude leg of the 3-model ensemble failed on every scoring
 * attempt corpus-wide — Glengarry WE's Guardian + WhatsOnStage reviews could not be
 * scored and stayed off the live page. models.js already defined the correct
 * 'claude-sonnet-4-6' but the pipeline bypassed it. This guard fails CI if any
 * production scoring file reintroduces the dead pin or drifts off the canonical model.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const { CLAUDE_SONNET } = require('../../scripts/lib/models.js');

const PRODUCTION_SCORING_FILES = [
  'scripts/llm-scoring/index.ts',
  'scripts/llm-scoring/scorer.ts',
  'scripts/llm-scoring/ensemble-scorer.ts',
  'scripts/llm-scoring/types.ts',
];

// Retired Claude pins that must never appear in production scoring paths.
const DEAD_MODELS = ['claude-sonnet-4-20250514'];

describe('scoring model is not EOL', () => {
  test('models.js CLAUDE_SONNET is the expected current model', () => {
    assert.equal(CLAUDE_SONNET, 'claude-sonnet-4-6');
  });

  for (const rel of PRODUCTION_SCORING_FILES) {
    test(`${rel} contains no retired Claude model pin`, () => {
      const src = readFileSync(join(root, rel), 'utf8');
      for (const dead of DEAD_MODELS) {
        assert.ok(!src.includes(dead),
          `${rel} references retired model ${dead} — use models.js CLAUDE_SONNET (${CLAUDE_SONNET})`);
      }
    });

    test(`${rel} references the canonical scoring model`, () => {
      const src = readFileSync(join(root, rel), 'utf8');
      assert.ok(src.includes(CLAUDE_SONNET),
        `${rel} should reference the canonical Claude scoring model ${CLAUDE_SONNET}`);
    });
  }

  // Repo-wide sweep: the scoring-path guard above missed 2 stragglers
  // (scan-we-cross-market.ts, get-ai-feedback.yml) that kept calling the dead
  // pin until 2026-07-09. Any file that ships a model string can rot the same
  // way, so scan everything we execute — scripts, src, workflows.
  test('no retired Claude model pin anywhere in scripts/, src/, .github/', async () => {
    const { execSync } = await import('node:child_process');
    for (const dead of DEAD_MODELS) {
      let hits = '';
      try {
        hits = execSync(
          `grep -rl --fixed-strings ${JSON.stringify(dead)} scripts src .github --include='*.js' --include='*.ts' --include='*.mjs' --include='*.yml' --include='*.yaml' || true`,
          { cwd: root, encoding: 'utf8' }
        ).trim();
      } catch { /* grep exit 1 = no matches — handled by || true */ }
      // This test file legitimately names the dead pin.
      const offenders = hits.split('\n').filter(f => f && !f.includes('scoring-model-not-eol'));
      assert.deepEqual(offenders, [],
        `retired model ${dead} still referenced by: ${offenders.join(', ')} — use models.js`);
    }
  });
});
