/**
 * Guard: scripts/lib/models.js is the ONE Claude model table.
 *
 * Three tables (models.js, autonomous-budget.js MODELS, bsc-next-model.js
 * SHORT_ALIAS) drifted to three different generations before 2026-10-01. The
 * dispatch tables now derive from models.js; this pins that, keeps every
 * referenced id priced, and keeps the review-SCORING model frozen (CLAUDE.md
 * §13: it moves only after the A/B gate, never with the general alias).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ts = require('typescript');
const models = require('../../scripts/lib/models.js');
const budget = require('../../scripts/lib/autonomous-budget.js');
const { SHORT_ALIAS } = require('../../scripts/lib/bsc-next-model.js');

const claudeIds = new Set(Object.values(models).filter(v => /^claude-/.test(v)));

// JS call sites that score reviews. They must use the SCORING_* pins.
const SCORING_JS = [
  'scripts/score-reviews-llm.js',
  'scripts/score-reviews-calibrated.js',
  'scripts/eval-v52.js',
  'scripts/test-consistency.js',
  'scripts/video-reviews/score-video-reviews.js',
];

describe('models.js is the single Claude model table', () => {
  test('executable scripts import versioned Claude ids from models.js', () => {
    const violations = [];
    for (const rel of readdirSync(join(root, 'scripts'), { recursive: true })) {
      const file = rel.replaceAll('\\', '/');
      // Test fixtures assert historical ids; scoring experiments are frozen.
      if (!/\.(?:js|mjs|ts)$/.test(file) || /\.(?:test|spec)\./.test(file)
        || file.startsWith('tests/') || /^llm-scoring\/.*\.ts$/.test(file)
        || file === 'lib/models.js') continue;
      const src = ts.createSourceFile(file,
        readFileSync(join(root, 'scripts', rel), 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        // Parsing ignores comments, but catches object keys, escaped strings,
        // double quotes and static template literals as well as single quotes.
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
          && /^claude-(?:[a-z]+-)?\d/.test(node.text)) {
          const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
          violations.push(`scripts/${file}:${line + 1}: ${node.text}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(src);
    }
    assert.deepEqual(violations, [],
      `Import a named pin from scripts/lib/models.js:\n${violations.join('\n')}`);
  });

  test('caller-group pins preserve the pre-centralization models', () => {
    const pins = {
      COPY_SONNET: 'claude-sonnet-4-5-20250929',
      ADJUDICATE_SONNET: 'claude-sonnet-4-5-20250929',
      EXTRACTION_SONNET: 'claude-sonnet-4-5-20250929',
      COPY_FALLBACK_SONNET: 'claude-3-5-sonnet-20241022',
      REDDIT_SONNET: 'claude-sonnet-5-5',
      WALKTHROUGH_SONNET: 'claude-sonnet-5',
      TRIAGE_SONNET: 'claude-sonnet-5',
    };
    for (const [name, id] of Object.entries(pins)) assert.equal(models[name], id, name);
  });

  test('SCORING_SONNET stays pinned to claude-sonnet-4-6 (§13 A/B gate)', () => {
    assert.equal(models.SCORING_SONNET, 'claude-sonnet-4-6');
  });

  // Ship-check 2026-10-01: the 5.5 generation rejects `temperature` and returns a
  // thinking block first, which breaks ~38 direct-API callers that read
  // content[0].text. The general aliases stay on 4.x until those callers are
  // migrated; only the headless `claude` CLI dispatch moves to 5.5.
  test('direct-API aliases stay on the 4.x generation; CLI dispatch aliases are 5.5', () => {
    assert.equal(models.CLAUDE_SONNET, 'claude-sonnet-4-6');
    assert.equal(models.CLAUDE_OPUS, 'claude-opus-4-7');
    assert.equal(models.DISPATCH_SONNET, 'claude-sonnet-5-5');
    assert.equal(models.DISPATCH_OPUS, 'claude-opus-5-5');
  });

  test('every SHORT_ALIAS key is an id defined in models.js', () => {
    for (const id of Object.keys(SHORT_ALIAS)) {
      assert.ok(claudeIds.has(id), `SHORT_ALIAS key ${id} is not in models.js`);
    }
  });

  test('autonomous-budget models come from models.js', () => {
    assert.equal(budget.pickModel(1), models.DISPATCH_SONNET);
    assert.equal(budget.pickModel(2, 'content'), models.DISPATCH_OPUS);
    const src = readFileSync(join(root, 'scripts/lib/autonomous-budget.js'), 'utf8');
    assert.doesNotMatch(src, /attempt\w*:\s*'claude-/, 'MODELS must not hardcode a claude id');
  });

  test('every Claude id in models.js has a MODEL_PRICES row', () => {
    for (const id of claudeIds) {
      assert.ok(budget.estimateUSD(id, 1_000_000, 0) > 0, `${id} is unpriced`);
    }
  });

  for (const rel of SCORING_JS) {
    test(`${rel} scores with a SCORING_* pin, not the general alias`, () => {
      const src = readFileSync(join(root, rel), 'utf8');
      assert.match(src, /SCORING_(SONNET|OPUS)/);
      assert.doesNotMatch(src, /\bCLAUDE_(SONNET|OPUS)\b/,
        `${rel} uses a general alias; scoring must use models.js SCORING_*`);
    });
  }

  // eval-prompts.js runs both a classifier (general alias) and the scorer (pinned).
  test('video-reviews/eval-prompts.js SCORE_MODEL defaults to a SCORING_* pin', () => {
    const src = readFileSync(join(root, 'scripts/video-reviews/eval-prompts.js'), 'utf8');
    assert.match(src, /const SCORE_MODEL = process\.env\.SCORE_MODEL \|\| SCORING_(SONNET|OPUS);/);
  });

  // BRO-4497: workflow inline scripts build Messages-API bodies too.
  for (const wf of ['get-ai-feedback.yml', 'investigate-alert.yml']) {
    test(`.github/workflows/${wf} reads its model id from models.js`, () => {
      const src = readFileSync(join(root, '.github/workflows', wf), 'utf8');
      assert.doesNotMatch(src, /['"`]claude-(?:sonnet|opus|haiku)-\d/, 'workflow hardcodes a claude id');
      assert.match(src, /scripts\/lib\/models\.js/);
    });
  }
});
