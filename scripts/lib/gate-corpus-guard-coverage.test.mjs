/**
 * Unit tests for findUnguardedGateAudits (task #1069) — the lint that stops
 * a NEW --gate-wired audit from reintroducing the vacuous-gate class
 * (#1063 lineage: a corpus audit that readdirSync's a missing/empty
 * data/review-texts checkout and reports a false-clean pass).
 *
 * Pattern: require() the real function; never copy logic into tests
 * (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  joinContinuationLines,
  parseGateWiredAudits,
  parseStrictWiredAudits,
  isReviewTextsCorpusScanner,
  hasCorpusGuard,
  findUnguardedGateAudits,
} = require('./gate-corpus-guard-coverage.js');

const GUARDED_REVIEW_TEXTS_SCRIPT = `
const { assertCorpusScanned } = require('./lib/corpus-scan-guard');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const shows = fs.readdirSync(REVIEW_TEXTS_DIR);
assertCorpusScanned(scanned, { gate: GATE });
`;

const UNGUARDED_REVIEW_TEXTS_SCRIPT = `
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const shows = fs.readdirSync(REVIEW_TEXTS_DIR);
if (shows.length === 0) console.log('empty corpus, reporting clean pass anyway');
`;

const UNRELATED_GATE_SCRIPT = `
const CAST_DIR = path.join(__dirname, '..', 'data', 'cast');
const files = fs.readdirSync(CAST_DIR);
// this audit gates on a different corpus entirely — no guard needed here
`;

describe('parseGateWiredAudits', () => {
  test('extracts script + line for a --gate invocation', () => {
    const workflow = 'steps:\n  - run: node scripts/audit-foo.js --gate\n';
    assert.deepStrictEqual(parseGateWiredAudits(workflow), [{ script: 'audit-foo.js', line: 2 }]);
  });

  test('extracts script when --gate is followed by other flags', () => {
    const workflow = '        run: node scripts/audit-self-contradictory-clears.js --gate --max=780';
    assert.deepStrictEqual(parseGateWiredAudits(workflow), [
      { script: 'audit-self-contradictory-clears.js', line: 1 },
    ]);
  });

  test('ignores invocations without --gate (advisory/--strict)', () => {
    const workflow = [
      'run: node scripts/audit-direct-provider-calls.js --strict',
      'run: node scripts/audit-run-budget-coverage.js',
    ].join('\n');
    assert.deepStrictEqual(parseGateWiredAudits(workflow), []);
  });

  test('ignores commented-out lines', () => {
    const workflow = '      # run: node scripts/audit-foo.js --gate\n';
    assert.deepStrictEqual(parseGateWiredAudits(workflow), []);
  });

  test('dedupes the same script wired in two steps but keeps first line', () => {
    const workflow = [
      'run: node scripts/audit-foo.js --gate',
      'run: node scripts/audit-foo.js --gate --extra',
    ].join('\n');
    assert.deepStrictEqual(parseGateWiredAudits(workflow), [
      { script: 'audit-foo.js', line: 1 },
      { script: 'audit-foo.js', line: 2 },
    ]);
  });

  test('catches --gate wrapped onto a continuation line (the false-negative both reviewers flagged)', () => {
    const workflow = [
      'steps:',
      '  - run: node scripts/audit-fake-vacuous.js \\',
      '      --gate',
    ].join('\n');
    assert.deepStrictEqual(parseGateWiredAudits(workflow), [
      { script: 'audit-fake-vacuous.js', line: 2 },
    ]);
  });

  test('reports the FIRST physical line number for a multi-line continuation', () => {
    const workflow = [
      '# comment',
      '# comment',
      'run: node scripts/audit-foo.js \\',
      '  --max=10 \\',
      '  --gate',
    ].join('\n');
    assert.deepStrictEqual(parseGateWiredAudits(workflow), [{ script: 'audit-foo.js', line: 3 }]);
  });
});

describe('parseStrictWiredAudits', () => {
  test('extracts script + line for a --strict invocation', () => {
    const workflow = 'steps:\n  - run: node scripts/audit-foo.js --strict\n';
    assert.deepStrictEqual(parseStrictWiredAudits(workflow), [{ script: 'audit-foo.js', line: 2 }]);
  });

  test('ignores invocations without --strict (--gate or bare)', () => {
    const workflow = [
      'run: node scripts/audit-cast-changes.js --gate',
      'run: node scripts/audit-run-budget-coverage.js',
    ].join('\n');
    assert.deepStrictEqual(parseStrictWiredAudits(workflow), []);
  });

  test('ignores commented-out lines', () => {
    const workflow = '      # run: node scripts/audit-foo.js --strict\n';
    assert.deepStrictEqual(parseStrictWiredAudits(workflow), []);
  });
});

describe('joinContinuationLines', () => {
  test('merges a trailing-backslash line with the next, keyed to the first line number', () => {
    const lines = ['run: node scripts/audit-foo.js \\', '  --gate', 'run: node scripts/audit-bar.js'];
    assert.deepStrictEqual(joinContinuationLines(lines), [
      { text: 'run: node scripts/audit-foo.js  --gate', line: 1 },
      { text: 'run: node scripts/audit-bar.js', line: 3 },
    ]);
  });

  test('leaves non-continued lines untouched', () => {
    const lines = ['a', 'b', 'c'];
    assert.deepStrictEqual(joinContinuationLines(lines), [
      { text: 'a', line: 1 },
      { text: 'b', line: 2 },
      { text: 'c', line: 3 },
    ]);
  });
});

describe('isReviewTextsCorpusScanner', () => {
  test('true when source readdirSyncs a review-texts path', () => {
    assert.strictEqual(isReviewTextsCorpusScanner(GUARDED_REVIEW_TEXTS_SCRIPT), true);
  });

  test('false when source walks an unrelated corpus', () => {
    assert.strictEqual(isReviewTextsCorpusScanner(UNRELATED_GATE_SCRIPT), false);
  });

  test('false when review-texts is mentioned but nothing is readdirSync-ed', () => {
    assert.strictEqual(isReviewTextsCorpusScanner('// see data/review-texts for details'), false);
  });
});

describe('hasCorpusGuard', () => {
  test('true when assertCorpusScanned is called', () => {
    assert.strictEqual(hasCorpusGuard(GUARDED_REVIEW_TEXTS_SCRIPT), true);
  });

  test('false when absent', () => {
    assert.strictEqual(hasCorpusGuard(UNGUARDED_REVIEW_TEXTS_SCRIPT), false);
  });
});

describe('findUnguardedGateAudits', () => {
  test('flags a --gate-wired script that walks review-texts with no guard (the #1069 fake-vacuous case)', () => {
    const workflowText = 'run: node scripts/audit-fake-vacuous.js --gate';
    const { violations, missingScripts, wiredCount } = findUnguardedGateAudits({
      workflowText,
      getScriptSource: (script) =>
        script === 'audit-fake-vacuous.js' ? UNGUARDED_REVIEW_TEXTS_SCRIPT : null,
    });
    assert.strictEqual(wiredCount, 1);
    assert.deepStrictEqual(missingScripts, []);
    assert.deepStrictEqual(violations, [{ script: 'audit-fake-vacuous.js', line: 1 }]);
  });

  test('does not flag a --gate-wired review-texts scanner that already has the guard', () => {
    const workflowText = 'run: node scripts/audit-review-contamination.js --gate';
    const { violations } = findUnguardedGateAudits({
      workflowText,
      getScriptSource: () => GUARDED_REVIEW_TEXTS_SCRIPT,
    });
    assert.deepStrictEqual(violations, []);
  });

  test('does not flag a --gate-wired script that gates on a non-review-texts corpus', () => {
    const workflowText = 'run: node scripts/audit-cast-changes.js --gate';
    const { violations } = findUnguardedGateAudits({
      workflowText,
      getScriptSource: () => UNRELATED_GATE_SCRIPT,
    });
    assert.deepStrictEqual(violations, []);
  });

  test('reports a gate-wired script missing from disk instead of silently skipping it', () => {
    const workflowText = 'run: node scripts/audit-ghost.js --gate';
    const { violations, missingScripts } = findUnguardedGateAudits({
      workflowText,
      getScriptSource: () => null,
    });
    assert.deepStrictEqual(violations, []);
    assert.deepStrictEqual(missingScripts, [{ script: 'audit-ghost.js', line: 1 }]);
  });

  test('flags a --strict-wired script that walks review-texts with no guard (#1619)', () => {
    const workflowText = 'run: node scripts/audit-fake-vacuous.js --strict';
    const { violations, gateWiredCount, strictWiredCount } = findUnguardedGateAudits({
      workflowText,
      getScriptSource: (script) =>
        script === 'audit-fake-vacuous.js' ? UNGUARDED_REVIEW_TEXTS_SCRIPT : null,
    });
    assert.strictEqual(gateWiredCount, 0);
    assert.strictEqual(strictWiredCount, 1);
    assert.deepStrictEqual(violations, [{ script: 'audit-fake-vacuous.js', line: 1 }]);
  });

  test('does not flag a --strict-wired review-texts scanner that already has the guard', () => {
    const workflowText = 'run: node scripts/audit-autoclear-vs-ensemble.js --strict';
    const { violations } = findUnguardedGateAudits({
      workflowText,
      getScriptSource: () => GUARDED_REVIEW_TEXTS_SCRIPT,
    });
    assert.deepStrictEqual(violations, []);
  });

  test('does not flag a --strict-wired script that gates on a non-review-texts corpus', () => {
    const workflowText = 'run: node scripts/audit-direct-provider-calls.js --strict';
    const { violations } = findUnguardedGateAudits({
      workflowText,
      getScriptSource: () => UNRELATED_GATE_SCRIPT,
    });
    assert.deepStrictEqual(violations, []);
  });

  test('checks each distinct script once even when wired in multiple steps', () => {
    const workflowText = [
      'run: node scripts/audit-fake-vacuous.js --gate',
      'run: node scripts/audit-fake-vacuous.js --gate --max=10',
    ].join('\n');
    let calls = 0;
    const { violations } = findUnguardedGateAudits({
      workflowText,
      getScriptSource: () => {
        calls += 1;
        return UNGUARDED_REVIEW_TEXTS_SCRIPT;
      },
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(violations.length, 1);
  });

  test('real-world snapshot: all 5 current review-texts --gate scripts pass, non-review-texts --gate scripts are ignored', () => {
    const workflowText = [
      'run: node scripts/audit-cast-changes.js --gate',
      'run: node scripts/audit-review-contamination.js --gate',
      'run: node scripts/audit-self-contradictory-clears.js --gate --max=780',
      'run: node scripts/audit-cast-contamination.js --gate',
      'run: node scripts/audit-commercial-contamination.js --gate',
      'run: node scripts/audit-non-reviews.js --gate',
      'run: node scripts/audit-audience-buzz-contamination.js --gate',
      'run: node scripts/audit-critic-consensus-contamination.js --gate',
      'run: node scripts/audit-text-quality.js --gate',
      'run: node scripts/audit-duplicate-of-url-mismatch.js --gate',
    ].join('\n');
    const reviewTextsScripts = new Set([
      'audit-review-contamination.js',
      'audit-self-contradictory-clears.js',
      'audit-non-reviews.js',
      'audit-text-quality.js',
      'audit-duplicate-of-url-mismatch.js',
    ]);
    const { violations, wiredCount } = findUnguardedGateAudits({
      workflowText,
      getScriptSource: (script) =>
        reviewTextsScripts.has(script) ? GUARDED_REVIEW_TEXTS_SCRIPT : UNRELATED_GATE_SCRIPT,
    });
    assert.strictEqual(wiredCount, 10);
    assert.deepStrictEqual(violations, []);
  });

  test('real-world snapshot (#1619): all 4 current --strict-wired scripts pass — 2 review-texts scanners already guarded, 2 gate on a different corpus', () => {
    const workflowText = [
      'run: node scripts/audit-direct-provider-calls.js --strict',
      'run: node scripts/audit-autoclear-vs-ensemble.js --strict',
      'run: node scripts/audit-sibling-title-misroute.js --strict',
      'run: node scripts/audit-aggregator-archive-integrity.js --strict',
    ].join('\n');
    const reviewTextsScripts = new Set(['audit-autoclear-vs-ensemble.js', 'audit-sibling-title-misroute.js']);
    const { violations, gateWiredCount, strictWiredCount } = findUnguardedGateAudits({
      workflowText,
      getScriptSource: (script) =>
        reviewTextsScripts.has(script) ? GUARDED_REVIEW_TEXTS_SCRIPT : UNRELATED_GATE_SCRIPT,
    });
    assert.strictEqual(gateWiredCount, 0);
    assert.strictEqual(strictWiredCount, 4);
    assert.deepStrictEqual(violations, []);
  });
});
