/**
 * land-gauntlet.sh's lint-workflows gate must run every script test.yml's
 * lint-workflows job runs (BRO-4737).
 *
 * The gauntlet keeps a hand-copied list of test.yml's lint/audit steps so land
 * can refuse a branch before it reaches main. BRO-3908 added
 * lint-autoclear-invalidate to test.yml but not to the gauntlet; on 2026-10-05
 * the BRO-3482 fix script landed through the gauntlet with three
 * lint-autoclear-invalidate violations and turned main red (test.yml run
 * 37332751709). This test derives the list from test.yml's executable
 * (non-comment) lint-workflows lines and fails when the gauntlet is missing a
 * `node scripts/X.js` script, drops a `--flag` test.yml passes it (the gauntlet
 * ran audit-push-retry-budgets without --fail-on-job-timeout), or misses a
 * `bash scripts/X.sh <mode>` mode. Inline `node -e` blocks are not compared.
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
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function lintWorkflowsText(testYml) {
  const block = readWorkflowJobBlocks(testYml)['lint-workflows'];
  assert.ok(block, 'test.yml has no lint-workflows job');
  return stripComments(block).join('\n');
}

function lintWorkflowsScripts(testYml) {
  const text = lintWorkflowsText(testYml);
  return [...new Set([...text.matchAll(/node (?:--test )?scripts\/([\w./-]+?)\.(?:js|mjs)\b/g)].map((m) => m[1]))];
}

function missingFromGauntlet(names, gauntlet) {
  const text = stripComments(gauntlet.split('\n')).join('\n');
  return names.filter((n) => !new RegExp(`(^|[\\s/"])${esc(n)}(\\.m?js)?(?=[\\s"\\\\;]|$)`, 'm').test(text));
}

// [script, --flag] pairs test.yml passes to `node scripts/X.js`.
function nodeFlags(testYml) {
  const out = [];
  for (const m of lintWorkflowsText(testYml).matchAll(/node scripts\/([\w./-]+?)\.m?js\b([^\n|&;>)"]*)/g)) {
    for (const flag of m[2].split(/\s+/).filter((t) => t.startsWith('--'))) out.push([m[1], flag]);
  }
  return out;
}

function missingFlags(pairs, gauntlet) {
  const text = stripComments(gauntlet.split('\n')).join('\n');
  return pairs.filter(([name, flag]) => !new RegExp(`scripts/${esc(name)}\\.m?js\\b[^\\n]*\\s${esc(flag)}(?=[\\s)"]|$)`, 'm').test(text));
}

// [script, mode] pairs for `bash scripts/X.sh <mode>`.
function bashModes(testYml) {
  return [...lintWorkflowsText(testYml).matchAll(/bash scripts\/([\w./-]+?\.sh)[ \t]+([\w-]+)/g)].map((m) => [m[1], m[2]]);
}

// A gauntlet mode counts when it is called literally, or listed in the
// `for x in ...; do` loop whose next line calls that script.
function missingModes(pairs, gauntlet) {
  const lines = stripComments(gauntlet.split('\n'));
  const have = new Set();
  lines.forEach((l, i) => {
    const lit = l.match(/scripts\/([\w./-]+?\.sh)[ \t]+([\w-]+)/);
    if (lit) have.add(`${lit[1]}::${lit[2]}`);
    const loop = l.match(/^\s*for \w+ in (.+?); do\s*$/);
    const call = loop && (lines[i + 1] || '').match(/scripts\/([\w./-]+?\.sh)/);
    if (call) for (const mode of loop[1].trim().split(/\s+/)) have.add(`${call[1]}::${mode}`);
  });
  return pairs.filter(([s, m]) => !have.has(`${s}::${m}`));
}

const testYml = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
const gauntlet = fs.readFileSync(path.join(ROOT, 'scripts/lib/land-gauntlet.sh'), 'utf8');

test('every script test.yml lint-workflows runs is also run by land-gauntlet.sh', () => {
  const names = lintWorkflowsScripts(testYml);
  assert.ok(names.length >= 20, `parsed only ${names.length} scripts from lint-workflows; parser drift?`);
  const missing = missingFromGauntlet(names, gauntlet).filter((n) => !EXEMPT.has(n));
  assert.deepEqual(missing, [], `land-gauntlet.sh lint-workflows gate is missing: ${missing.join(', ')}. Add each to its audit list (or EXEMPT with a reason).`);
});

test('every --flag test.yml passes a lint-workflows node script, the gauntlet passes too', () => {
  const pairs = nodeFlags(testYml);
  assert.ok(pairs.some(([n, f]) => n === 'audit-push-retry-budgets' && f === '--fail-on-job-timeout'), 'parser drift: expected audit-push-retry-budgets --fail-on-job-timeout');
  const missing = missingFlags(pairs, gauntlet).filter(([n]) => !EXEMPT.has(n));
  assert.deepEqual(missing, [], `land-gauntlet.sh runs these without the flag test.yml uses: ${missing.map((p) => p.join(' ')).join(', ')}`);
  assert.deepEqual(missingFlags([['audit-x', '--strict']], 'lwgate audit-x node scripts/audit-x.js\n'), [['audit-x', '--strict']]);
  assert.deepEqual(missingFlags([['audit-x', '--strict']], 'lwgate audit-x node scripts/audit-x.js --strict\n'), []);
});

test('every bash lint mode test.yml runs is run by the gauntlet', () => {
  const pairs = bashModes(testYml);
  assert.ok(pairs.length >= 10, `parsed only ${pairs.length} bash lint modes; parser drift?`);
  assert.deepEqual(missingModes(pairs, gauntlet), []);
  const dropped = gauntlet.replace(/ theatr-token /, ' ');
  assert.notEqual(dropped, gauntlet, 'fixture: gauntlet loop no longer lists theatr-token');
  assert.deepEqual(missingModes(pairs, dropped), [['lint-workflow-guards.sh', 'theatr-token']]);
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
