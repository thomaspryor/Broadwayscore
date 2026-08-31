// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — reads the real
// .github/workflows/llm-ensemble-score.yml CI config (not data/*.json derived
// data) to regression-guard a spend circuit-breaker wiring fix.
/**
 * BRO-78 — scripts/llm-scoring/index.ts has implemented a --max-cost=N cost
 * circuit breaker since Phase B-WE W1-T5, but llm-ensemble-score.yml never
 * exposed it, so every manual large-batch dispatch ran uncapped. Fixed by
 * 31dc6944c71 (expose the input, thread it) and 46eb2028be8 (validate it).
 *
 * Why this test exists: the card shipped with `npx tsc --noEmit` as its stated
 * acceptance command, and that command CANNOT FAIL for this change — tsc does
 * not typecheck YAML, so a green run proved nothing about the wiring. This is
 * the check that can actually go red.
 *
 * The load-bearing property is the VALIDATION, not just the plumbing. As the
 * workflow's own comment records, index.ts parses the flag with
 * `parseFloat(arg) || 0`, which silently treats NaN and negative values as
 * "unlimited" — exactly backwards for a cost-safety feature. A typo in the
 * dispatch form must therefore fail loud rather than silently disable the cap.
 *
 * So rather than grep for the guard, this test EXTRACTS the real shell block
 * out of the workflow and EXECUTES it against sample inputs. A future edit that
 * weakens the guard (drops the awk positivity check, loosens the regex) goes
 * red here instead of quietly passing a string match.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WF = path.join(__dirname, '..', '..', '.github', 'workflows', 'llm-ensemble-score.yml');
const yml = fs.readFileSync(WF, 'utf8');
const lines = yml.split('\n');

// --- structural: the input exists and is a workflow_dispatch input ---

test('BRO-78: max_cost is declared as a workflow_dispatch input', () => {
  const dispatchIdx = lines.findIndex(l => /^\s*workflow_dispatch:\s*$/.test(l));
  assert.ok(dispatchIdx >= 0, 'workflow_dispatch block not found');
  const decl = lines.findIndex(l => /^\s*max_cost:\s*$/.test(l));
  assert.ok(decl > dispatchIdx, 'max_cost: input declaration not found after workflow_dispatch');
  const window = lines.slice(decl, decl + 4).join('\n');
  assert.match(window, /description:/, 'max_cost input has no description');
});

// --- structural: it is threaded into the scoring invocation and the chain ---

test('BRO-78: max_cost is threaded into the scoring args as --max-cost=', () => {
  assert.match(yml, /ARGS="\$ARGS --max-cost=\$MAX_COST"/,
    'the validated MAX_COST is not appended to ARGS as --max-cost=; index.ts would never receive the cap');
});

test('BRO-78: max_cost is passed down the rescore chain, not just the first batch', () => {
  assert.match(yml, /CHAIN_ARGS="\$CHAIN_ARGS -f max_cost=/,
    'max_cost is not forwarded into CHAIN_ARGS; a chained rescore would run uncapped after the first batch');
});

// --- behavioural: run the REAL guard out of the workflow ---

function extractGuard() {
  const start = lines.findIndex(l => l.includes('MAX_COST="${{ github.event.inputs.max_cost }}"'));
  assert.ok(start >= 0, 'MAX_COST assignment not found in the workflow');
  const indent = lines[start].length - lines[start].trimStart().length;
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === 'fi' && (l.length - l.trimStart().length) === indent) { end = i; break; }
  }
  assert.ok(end > start, 'could not find the closing fi of the max_cost guard');
  return lines.slice(start + 1, end + 1).join('\n');
}

function runGuard(value) {
  const guard = extractGuard();
  const script = ['set -u', 'ARGS=""', 'MAX_COST="' + value + '"', guard, 'echo "ARGS=$ARGS"'].join('\n');
  try {
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

test('BRO-78 guard: a valid integer cap is accepted and reaches index.ts', () => {
  const r = runGuard('5');
  assert.equal(r.code, 0, 'expected exit 0, got ' + r.code + ': ' + r.out);
  assert.match(r.out, /ARGS=.*--max-cost=5/);
});

test('BRO-78 guard: a valid decimal cap is accepted', () => {
  const r = runGuard('0.5');
  assert.equal(r.code, 0, 'expected exit 0, got ' + r.code + ': ' + r.out);
  assert.match(r.out, /--max-cost=0\.5/);
});

test('BRO-78 guard: empty input is a no-op (unlimited stays the documented default)', () => {
  const r = runGuard('');
  assert.equal(r.code, 0, 'expected exit 0, got ' + r.code + ': ' + r.out);
  assert.doesNotMatch(r.out, /--max-cost/, 'empty input must not append a flag at all');
});

test('BRO-78 guard: zero FAILS LOUD rather than silently disabling the cap', () => {
  const r = runGuard('0');
  assert.notEqual(r.code, 0, 'max_cost=0 must fail; index.ts parseFloat||0 would treat it as unlimited');
});

test('BRO-78 guard: a negative cap FAILS LOUD', () => {
  const r = runGuard('-1');
  assert.notEqual(r.code, 0, 'a negative max_cost must fail; index.ts would treat it as unlimited');
});

test('BRO-78 guard: a non-numeric typo FAILS LOUD', () => {
  const r = runGuard('abc');
  assert.notEqual(r.code, 0, 'a non-numeric max_cost must fail; parseFloat would yield NaN then 0 then unlimited');
});
