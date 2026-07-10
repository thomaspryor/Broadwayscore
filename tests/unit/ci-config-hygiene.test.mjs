/**
 * CI-config hygiene guards — two failure classes that reddened main in July 2026:
 *
 * 1. Fixture-spec dual registration (2026-07-06→09 incident): any E2E spec that
 *    navigates to /test/* fixture pages MUST be in playwright.config.ts
 *    testIgnore — main CI runs E2E against production, where TestGuard
 *    client-redirects /test/* to the homepage (fixtures are demo-flag-gated),
 *    so every such test times out. It SHOULD also be in test-ugc.yml's local
 *    run list or it has no CI coverage at all. rating-editor.spec.ts was added
 *    to test-ugc.yml but not testIgnore → 16 timeouts, main red 3 days.
 *
 * 2. Workflow node-heredoc module ambiguity (2026-07-04→09 incident): an inline
 *    `node << 'EOF'` script that mixes require() with TOP-LEVEL await dies
 *    instantly on Node 22.7+ (ERR_AMBIGUOUS_MODULE_SYNTAX). investigate-alert.yml
 *    failed 21 times before anyone read the log. Detection mirrors node's own
 *    rule: fails CJS compile (vm.Script) AND references require().
 *
 * Run: node --test tests/unit/ci-config-hygiene.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');

describe('fixture-spec dual registration', () => {
  const e2eDir = join(root, 'tests/e2e');
  const specs = readdirSync(e2eDir).filter(f => f.endsWith('.spec.ts'));
  const playwrightConfig = readFileSync(join(root, 'playwright.config.ts'), 'utf8');
  const ugcWorkflow = readFileSync(join(root, '.github/workflows/test-ugc.yml'), 'utf8');

  // Globs in testIgnore look like '**/rating-editor*' — reduce to the stem for matching.
  const ignoreStems = [...playwrightConfig.matchAll(/'\*\*\/([a-z0-9-]+)\*'/g)].map(m => m[1]);

  const fixtureSpecs = specs.filter(f => {
    const src = readFileSync(join(e2eDir, f), 'utf8');
    // Navigations to gated fixture pages: goto('/test/... or goto(`/test/...
    return /goto\((["'`])[^"'`]*\/test\//.test(src) || /`\$\{?[A-Z_]*\}?\/test\//.test(src);
  });

  for (const spec of fixtureSpecs) {
    test(`${spec} hits /test/* — must be in playwright testIgnore`, () => {
      const ignored = ignoreStems.some(stem => spec.startsWith(stem));
      assert.ok(ignored,
        `${spec} navigates to /test/* fixture pages but is not in playwright.config.ts testIgnore. ` +
        `Main CI runs E2E against production where TestGuard redirects /test/* to / — every test will time out. ` +
        `Add '**/${spec.replace('.spec.ts', '')}*' to testIgnore AND list the spec in test-ugc.yml.`);
    });

    test(`${spec} hits /test/* — should run in test-ugc.yml for coverage`, () => {
      assert.ok(ugcWorkflow.includes(spec),
        `${spec} is excluded from main CI (correctly) but not listed in test-ugc.yml's run step — it runs NOWHERE in CI.`);
    });
  }

  test('sanity: the sweep actually finds fixture specs', () => {
    assert.ok(fixtureSpecs.length >= 1,
      'no fixture specs detected — the /test/ navigation regex is broken, guard is dead');
  });
});

describe('workflow node-heredoc module ambiguity', () => {
  const wfDir = join(root, '.github/workflows');
  const workflows = readdirSync(wfDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  // Strip comments and string contents so a mention of "require(" in prose or a
  // log message does not count as a CJS reference.
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');

  function extractHeredocs(yaml) {
    const blocks = [];
    const lines = yaml.split('\n');
    let marker = null, indent = '', buf = [];
    for (const line of lines) {
      if (marker === null) {
        const m = line.match(/^(\s*)node\s+<<-?\s*'?([A-Z_]+)'?\s*$/);
        if (m) { indent = m[1]; marker = m[2]; buf = []; }
      } else {
        if (line.trim() === marker) {
          blocks.push(buf.join('\n'));
          marker = null;
        } else {
          buf.push(line.startsWith(indent) ? line.slice(indent.length) : line);
        }
      }
    }
    return blocks;
  }

  let heredocCount = 0;
  for (const wf of workflows) {
    const yaml = readFileSync(join(wfDir, wf), 'utf8');
    const blocks = extractHeredocs(yaml);
    if (blocks.length === 0) continue;
    heredocCount += blocks.length;

    test(`${wf} inline node script(s) are not module-ambiguous`, () => {
      for (const src of blocks) {
        let cjsCompiles = true;
        try { new vm.Script(src); } catch { cjsCompiles = false; }
        if (cjsCompiles) continue; // plain CJS — safe
        const referencesCjs = /\brequire\s*\(|\bmodule\.exports\b/.test(strip(src));
        assert.ok(!referencesCjs,
          `${wf}: inline node heredoc mixes ESM-only syntax (top-level await / import) with require()/module.exports — ` +
          `Node 22.7+ dies with ERR_AMBIGUOUS_MODULE_SYNTAX before running a single line. ` +
          `Use import statements throughout (see investigate-alert.yml) or wrap the awaits in an async IIFE.`);
      }
    });
  }

  test('sanity: the sweep actually finds node heredocs', () => {
    assert.ok(heredocCount >= 1,
      'no node heredocs detected across workflows — extraction regex is broken, guard is dead');
  });
});
