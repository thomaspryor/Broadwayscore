// BRO-6013: a `type: boolean` workflow input compared to a quoted string is a
// silent no-op. GitHub Actions coerces both sides to numbers, so
// `inputs.dry_run != 'true'` is `1 != NaN` (always true: a dry run still
// commits and pushes) and `inputs.force == 'true'` is always false (a force
// flag that never fires). Write `inputs.x != true` / `!inputs.x` instead.
//
// Not flagged: `github.event.inputs.x == 'true'` (event payload inputs are
// strings) and shell tests such as `[ "${{ inputs.x }}" = "true" ]` (the
// expression is interpolated into the script first).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { declaredInputTypes } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');

const WF_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../.github/workflows');
const LIT = `(?<q>['"])(?:true|false)\\k<q>`;
const REF = `(?<![\\w.])inputs\\.(?<name>[\\w-]+)`;
const REF_FIRST_RE = new RegExp(`${REF}\\s*[!=]=\\s*${LIT}`, 'g');
const LIT_FIRST_RE = new RegExp(`${LIT}\\s*[!=]=\\s*${REF}`, 'g');

// Names of inputs on this line compared to a quoted true/false literal.
export function comparedInputs(line) {
  if (/^\s*#/.test(line)) return [];
  const names = [];
  for (const m of line.matchAll(REF_FIRST_RE)) names.push(m.groups.name);
  for (const m of line.matchAll(LIT_FIRST_RE)) names.push(m.groups.name);
  return names;
}

export function booleanStringCompares(raw) {
  const types = declaredInputTypes(raw);
  const hits = [];
  raw.split('\n').forEach((line, i) => {
    for (const name of comparedInputs(line)) {
      if (types[name] === 'boolean') hits.push({ line: i + 1, name, text: line.trim() });
    }
  });
  return hits;
}

test('no workflow compares a boolean input to a quoted true/false string', () => {
  const hits = [];
  for (const f of fs.readdirSync(WF_DIR).filter((n) => /\.ya?ml$/.test(n))) {
    for (const h of booleanStringCompares(fs.readFileSync(path.join(WF_DIR, f), 'utf8'))) {
      hits.push(`${f}:${h.line}: inputs.${h.name} -> ${h.text}`);
    }
  }
  assert.deepEqual(hits, []);
});

const WF = (type, body) => `name: t
on:
  workflow_dispatch:
    inputs:
      flag:
        type: ${type}
        default: false
jobs:
  j:
    steps:
${body}
`;

test('matcher flags boolean inputs in both operand orders and quote styles', () => {
  for (const expr of [
    "if: inputs.flag != 'true'",
    "if: inputs.flag == 'true'",
    'if: inputs.flag == "false"',
    "if: always() && 'true' == inputs.flag",
    "run: echo ${{ inputs.flag != 'false' && 'on' || 'off' }}",
  ]) {
    assert.equal(booleanStringCompares(WF('boolean', `      - ${expr}`)).length, 1, expr);
  }
});

test('matcher leaves the correct forms and non-boolean inputs alone', () => {
  for (const expr of [
    'if: inputs.flag != true',
    'if: ${{ !inputs.flag }}',
    "if: github.event.inputs.flag == 'true'",
    'run: if [ "${{ inputs.flag }}" = "true" ]; then echo y; fi',
    'run: if [ "${{ inputs.flag }}" == "true" ]; then echo y; fi',
  ]) {
    assert.deepEqual(booleanStringCompares(WF('boolean', `      - ${expr}`)), [], expr);
  }
  assert.deepEqual(comparedInputs("      # if: inputs.flag != 'true'"), []);
  assert.deepEqual(booleanStringCompares(WF('string', "      - if: inputs.flag == 'true'")), []);
  assert.deepEqual(booleanStringCompares(WF('choice', "      - if: inputs.flag == 'true'")), []);
});
