import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { findShallowLedgerCheckouts, fixShallowLedgerCheckouts } = createRequire(import.meta.url)('./ledger-checkout-depth.js');

const wf = (timeout, extra = '') => `name: x
jobs:
  a:
    runs-on: ubuntu-latest
${timeout ? `    timeout-minutes: ${timeout}\n` : ''}    steps:
      - name: Checkout
        uses: actions/checkout@v5
${extra}      - if: always()
        uses: ./.github/actions/commit-scraper-spend-ledger
`;

test('long ledger job on depth-1 checkout is flagged, and the fixer clears it', () => {
  const t = wf(60);
  assert.equal(findShallowLedgerCheckouts(t).length, 1);
  const fixed = fixShallowLedgerCheckouts(t);
  assert.match(fixed, /fetch-depth: 300/);
  assert.equal(findShallowLedgerCheckouts(fixed).length, 0);
});
test('with: block gets the key appended; >120 min needs 1000', () => {
  const t = wf(240, '        with:\n          ref: main\n');
  assert.equal(findShallowLedgerCheckouts(t)[0].need, 1000);
  const fixed = fixShallowLedgerCheckouts(t);
  assert.match(fixed, /ref: main\n(.*\n)*\s+fetch-depth: 1000/);
  assert.equal(findShallowLedgerCheckouts(fixed).length, 0);
});
test('short jobs, fetch-depth 0, and annotated exemptions pass', () => {
  assert.equal(findShallowLedgerCheckouts(wf(15)).length, 0);
  assert.equal(findShallowLedgerCheckouts(wf(60, '        with:\n          fetch-depth: 0\n')).length, 0);
  assert.equal(findShallowLedgerCheckouts(wf(60).replace('checkout@v5', 'checkout@v5 # shallow-ledger-ok: tiny diff')).length, 0);
});
test('a depth below the tier is still flagged', () => {
  assert.equal(findShallowLedgerCheckouts(wf(240, '        with:\n          fetch-depth: 300\n')).length, 1);
});
test('fixer replaces a too-low depth in place; expression depths are left alone', () => {
  const fixed = fixShallowLedgerCheckouts(wf(240, '        with:\n          fetch-depth: 50\n'));
  assert.equal((fixed.match(/fetch-depth/g) || []).length, 1);
  assert.match(fixed, /fetch-depth: 1000/);
  assert.equal(findShallowLedgerCheckouts(wf(240, '        with:\n          fetch-depth: ${{ inputs.d }}\n')).length, 0);
});
test('every real workflow with a ledger commit has a deep-enough checkout', () => {
  const dir = '.github/workflows';
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yml'))) {
    for (const r of findShallowLedgerCheckouts(fs.readFileSync(path.join(dir, f), 'utf8'))) bad.push(`${f}:${r.line} job ${r.job} needs fetch-depth ${r.need}`);
  }
  assert.deepEqual(bad, []);
});
