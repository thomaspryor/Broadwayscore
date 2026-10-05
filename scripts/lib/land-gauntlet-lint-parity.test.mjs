/**
 * land-gauntlet.sh's lint-workflows gate must run every script test.yml's
 * lint-workflows job runs (BRO-4737).
 *
 * The gauntlet keeps a hand-copied list of test.yml's lint/audit steps so land
 * can refuse a branch before it reaches main. BRO-3908 added
 * lint-autoclear-invalidate to test.yml but not to the gauntlet; on 2026-10-05
 * the BRO-3482 fix script landed through the gauntlet with three
 * lint-autoclear-invalidate violations and turned main red (test.yml run
 * 37332751709). This test derives the script list from test.yml's executable
 * lines and fails when the gauntlet is missing one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readWorkflowJobBlocks } = require('./audit-workflow-hygiene-rules.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A test.yml lint-workflows script the gauntlet deliberately does not run
// needs a one-line reason here, not a silent skip.
const EXEMPT = new Map([]);

const stripComments = (lines) => lines.filter((l) => !/^\s*#/.test(l));

function lintWorkflowsScripts(testYml) {
  const block = readWorkflowJobBlocks(testYml)['lint-workflows'];
  assert.ok(block, 'test.yml has no lint-workflows job');
  const text = stripComments(block).join('\n');
  return [...new Set([...text.matchAll(/node (?:--test )?scripts\/([\w./-]+?)\.(?:js|mjs)\b/g)].map((m) => m[1]))];
}

function missingFromGauntlet(names, gauntlet) {
  const text = stripComments(gauntlet.split('\n')).join('\n');
  return names.filter((n) => {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`(^|[\\s/"])${esc}(\\.m?js)?(?=[\\s"\\\\;]|$)`, 'm').test(text);
  });
}

const testYml = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
const gauntlet = fs.readFileSync(path.join(ROOT, 'scripts/lib/land-gauntlet.sh'), 'utf8');

test('every script test.yml lint-workflows runs is also run by land-gauntlet.sh', () => {
  const names = lintWorkflowsScripts(testYml);
  assert.ok(names.length >= 20, `parsed only ${names.length} scripts from lint-workflows; parser drift?`);
  const missing = missingFromGauntlet(names, gauntlet).filter((n) => !EXEMPT.has(n));
  assert.deepEqual(missing, [], `land-gauntlet.sh lint-workflows gate is missing: ${missing.join(', ')}. Add each to its audit list (or EXEMPT with a reason).`);
});

test('the check catches a script dropped from the gauntlet (lint-autoclear-invalidate, the BRO-4737 regression)', () => {
  const names = lintWorkflowsScripts(testYml);
  assert.ok(names.includes('lint-autoclear-invalidate'));
  const dropped = gauntlet.replace(/^\s*lint-autoclear-invalidate \\\n/m, '');
  assert.notEqual(dropped, gauntlet, 'fixture: gauntlet no longer lists lint-autoclear-invalidate in the loop form');
  assert.deepEqual(missingFromGauntlet(['lint-autoclear-invalidate'], dropped), ['lint-autoclear-invalidate']);
});

test('a script named only in a gauntlet comment does not count as run', () => {
  assert.deepEqual(missingFromGauntlet(['audit-foo'], '# audit-foo is great\nlwgate x node scripts/bar.js\n'), ['audit-foo']);
  assert.deepEqual(missingFromGauntlet(['audit-foo'], 'lwgate audit-foo node scripts/audit-foo.js --strict\n'), []);
});
