/**
 * Every workflow step that runs a script reaching validatePageMatchesShow must
 * have an LLM key in scope (BRO-4852).
 *
 * Without GEMINI_API_KEY/OPENAI_API_KEY the page validator's tiebreaker
 * returns null and its final fallback accepts any low-confidence title match.
 * No gather/aggregator step had either key, so in CI the tiebreaker never ran:
 * "Two Girls" took the NYC Theatre roundup for "School Girls; Or, The African
 * Mean Girls Play" and four wrong reviews went live.
 *
 * Reuses audit-workflow-secret-gaps.js's findGaps (advisory on its own, 500+
 * unrelated gaps); page-validator.js carries the audit-secret-scan-always-trace
 * marker so the scan follows it past the shared-module threshold. This test
 * blocks only the LLM-key gaps of steps whose script reaches the validator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { findGaps } = require(path.join(ROOT, 'scripts/audit-workflow-secret-gaps.js'));
const {
  buildRequirerCounts, collectTransitiveSource, resolveModulePath,
} = require(path.join(ROOT, 'scripts/lib/workflow-secret-scan.js'));

const LLM_KEYS = new Set(['GEMINI_API_KEY', 'OPENAI_API_KEY']);

function validatorGaps() {
  const requirerCounts = buildRequirerCounts(path.join(ROOT, 'scripts'));
  const reaches = new Map();
  const reachesValidator = (scriptRel) => {
    if (!reaches.has(scriptRel)) {
      const src = collectTransitiveSource(resolveModulePath(ROOT, scriptRel), { requirerCounts });
      reaches.set(scriptRel, /\bfunction validatePageMatchesShow\b/.test(src));
    }
    return reaches.get(scriptRel);
  };
  return findGaps(path.join(ROOT, '.github', 'workflows'))
    // scripts/test-*.js are offline regression suites (skipLlm), not scrapers.
    .filter((g) => LLM_KEYS.has(g.secret) && !/^scripts\/test-/.test(g.script) && reachesValidator(g.script));
}

test('page-validator.js is traced by the secret scan (always-trace marker)', () => {
  const requirerCounts = buildRequirerCounts(path.join(ROOT, 'scripts'));
  const src = collectTransitiveSource(path.join(ROOT, 'scripts/scrape-nyc-theatre-roundups.js'), { requirerCounts });
  assert.match(src, /\bfunction validatePageMatchesShow\b/,
    'the scan no longer follows page-validator.js; restore its audit-secret-scan-always-trace marker');
});

test('no workflow step runs the page validator without an LLM key (BRO-4852)', () => {
  const gaps = validatorGaps();
  const lines = [...new Set(gaps.map((g) => `${g.workflow} :: ${g.job} :: ${g.step} -> ${g.script} (${g.secret})`))];
  assert.deepEqual(lines, [],
    `Add GEMINI_API_KEY and OPENAI_API_KEY to these steps' env:\n  ${lines.join('\n  ')}`);
});
