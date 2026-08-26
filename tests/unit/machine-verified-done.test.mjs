// tests/unit/machine-verified-done.test.mjs — acceptance test for BRO-264
// Phase 2 (machine-verified Done gate). Per CLAUDE.md rule 15, this
// require()s the real modules rather than restating their logic.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('BRO-264 item 1: branch-protection ruleset design', () => {
  const {
    RESTRICTED_FILE_PATHS,
    RULESET_NAME,
    buildRulesetPayload,
    matchesRestrictedPath,
  } = require(path.join(REPO_ROOT, 'scripts/lib/branch-ruleset-paths.js'));

  test('restricts code file extensions and dot-github/src/config paths', () => {
    for (const p of [
      'src/app/page.tsx',
      'scripts/apply-branch-ruleset.js',
      'scripts/lib/branch-ruleset-paths.js',
      '.github/workflows/test.yml',
      '.github/actions/setup-node/action.yml',
      'next.config.js',
      'tsconfig.json',
      'package.json',
      'package-lock.json',
      'supabase/migrations/0001.sql',
      'CLAUDE.md',
    ]) {
      assert.equal(matchesRestrictedPath(p), true, `expected ${p} to be restricted`);
    }
  });

  test('does NOT restrict data files or generated config JSON under scripts/ — the exact case that would have broken regenerate-tier-configs.yml with a blanket scripts/** glob', () => {
    for (const p of [
      'data/shows.json',
      'data/reviews.json',
      'scripts/config/domain-tier-order.json',
      'scripts/config/domain-tier-skip.json',
      'data/audit/scraper-spend-ledger.jsonl',
      'README.md',
    ]) {
      assert.equal(matchesRestrictedPath(p), false, `expected ${p} to NOT be restricted`);
    }
  });

  test('buildRulesetPayload produces a file_path_restriction rule with no bypass actors (include-administrators requirement)', () => {
    const payload = buildRulesetPayload({ enforcement: 'evaluate' });
    assert.equal(payload.name, RULESET_NAME);
    assert.equal(payload.target, 'branch');
    assert.deepEqual(payload.bypass_actors, []);
    assert.equal(payload.rules.length, 1);
    assert.equal(payload.rules[0].type, 'file_path_restriction');
    assert.deepEqual(payload.rules[0].parameters.restricted_file_paths, RESTRICTED_FILE_PATHS);
  });

  test('buildRulesetPayload rejects an invalid enforcement value', () => {
    assert.throws(() => buildRulesetPayload({ enforcement: 'bogus' }), /enforcement must be/);
  });

  test('apply-branch-ruleset.js documents the live platform blocker found this session (push rulesets require an org-owned repo)', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/apply-branch-ruleset.js'), 'utf-8');
    assert.match(src, /org-owned/i);
    assert.match(src, /PLATFORM BLOCKER/);
  });
});

describe('BRO-264 item 2: ship-check as CI already covered by existing infra', () => {
  test('test.yml runs unconditionally (no path filter) on every pull_request to main, including a typescript-check job', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/test.yml'), 'utf-8');
    // The `pull_request:` trigger block must carry no `paths:` filter — that
    // absence is what makes it an "always-run neutral check" (a PR touching
    // only paths outside the `push:` trigger's allow-list still gets this
    // job), same requirement BRO-264 asked a new workflow to provide.
    const prBlock = src.match(/\n {2}pull_request:\n([\s\S]*?)\n {2}\S/);
    assert.ok(prBlock, 'expected a pull_request: trigger block in test.yml');
    assert.doesNotMatch(prBlock[1], /paths:/, 'pull_request trigger must not be path-filtered');
    assert.match(src, /\n {2}typescript-check:/);
    assert.match(src, /npx tsc --noEmit/);
    assert.match(src, /npx next lint/);
  });
});

describe('BRO-264 items 3 & 4: deferred this session', () => {
  test('close-linear-on-deploy and runner-heartbeat wiring are explicitly not yet implemented (see Linear comment for the redesign + reason)', () => {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, 'scripts/close-linear-on-deploy.js')), false);
  });
});
