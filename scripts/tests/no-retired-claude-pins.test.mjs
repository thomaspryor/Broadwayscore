// BRO-7527: no runtime call site may resolve to a retired/retiring Claude model.
// Test fixtures are exempt (scripts/llm-scoring is covered since BRO-7510: its --model=haiku pin was a dead 3.5 id).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const models = require('../lib/models.js');

const RETIRED = 'claude-(sonnet-4-5|3-5-sonnet|3-5-haiku|3-haiku|3-opus|3-7-sonnet|sonnet-4-0|opus-4-0|opus-4-1)([^a-z0-9]|$)';

test('every models.js claude pin is off retired models', () => {
  for (const [k, v] of Object.entries(models)) {
    if (typeof v === 'string' && v.startsWith('claude-')) assert.doesNotMatch(v, new RegExp(RETIRED), k);
  }
});

test('no runtime code hardcodes a retired claude id (comments/registries exempt)', () => {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-nE', RETIRED, '--', 'scripts', 'src', '.github/workflows',
      ':!*.test.*', ':!scripts/tests', ':!scripts/lib/provider-deprecations.js',
      ':!scripts/lib/openai-deprecations.js', ':!scripts/lib/model-drift-guard.js'], { encoding: 'utf8' });
  } catch (e) { if (e.status !== 1) throw e; }
  const hits = out.split('\n').filter(Boolean).filter(l => {
    const code = l.replace(/^[^:]+:\d+:/, '').trim();
    return !/^(\/\/|\*|\/\*)/.test(code);
  });
  assert.deepEqual(hits, []);
});

test('retirement audit ignores quoted ids in whole-line comments (BRO-7510)', () => {
  const { referencedAnthropicIds } = require('../lib/provider-deprecations.js');
  const src = "// registry keys like 'claude-sonnet-4-5' fold\n * 'claude-3-5-haiku'\nconst m = 'claude-haiku-4-5-20251001';\n";
  assert.deepEqual([...referencedAnthropicIds(src)], ['claude-haiku-4-5']);
});
