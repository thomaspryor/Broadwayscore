import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanWorkflow } = require('../../scripts/lib/validate-data-nonblocking-scan.js');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const wf = (steps) => `jobs:\n  j:\n    steps:\n${steps}`;
const VAL = (extra = '') => `      - name: Validate data\n${extra}        run: node scripts/validate-data.js\n`;
const ALWAYS = `      - name: Push\n        if: always()\n        run: echo push\n`;

test('flags validate with only always() steps after it and no continue-on-error', () => {
  assert.equal(scanWorkflow(wf(VAL() + ALWAYS)).length, 1);
});

test('continue-on-error: true is accepted', () => {
  assert.equal(scanWorkflow(wf(VAL('        continue-on-error: true\n') + ALWAYS)).length, 0);
});

test('a later step without always() makes validate load-bearing', () => {
  assert.equal(scanWorkflow(wf(VAL() + '      - name: Commit\n        run: echo c\n' + ALWAYS)).length, 0);
});

test('a later step reading the validate outcome (env or if) is a deliberate gate', () => {
  const v = '      - name: Validate data\n        id: validate\n        run: node scripts/validate-data.js\n';
  const reader = '      - name: Push\n        if: always()\n        env:\n          V: ${{ steps.validate.outcome }}\n        run: echo "$V"\n';
  assert.equal(scanWorkflow(wf(v + reader)).length, 0);
});

test('inline shell that handles the exit code itself is not a standalone step', () => {
  const v = '      - name: Validate data\n        run: |\n          node scripts/validate-data.js || RC=$?\n';
  assert.equal(scanWorkflow(wf(v + ALWAYS)).length, 0);
});

test('validate-blocking-ok marker before the step exempts it', () => {
  const marked = '      # validate-blocking-ok: requester must see the refusal\n' + VAL();
  assert.equal(scanWorkflow(wf(marked + ALWAYS)).length, 0);
});

test('a later push-core-data step reads the validate sentinel, so validate is load-bearing', () => {
  const push = '      - name: Push\n        if: always()\n        uses: ./.github/actions/push-core-data\n';
  assert.equal(scanWorkflow(wf(VAL() + push)).length, 0);
});

test('!cancelled() later steps still run after failure (validate gates nothing)', () => {
  const s = '      - name: Push\n        if: ${{ !cancelled() }}\n        run: echo p\n';
  assert.equal(scanWorkflow(wf(VAL() + s)).length, 1);
});

test('a YAML parse error throws instead of reading as clean', () => {
  assert.throws(() => scanWorkflow('jobs: [unclosed'));
});

test('every real workflow: standalone validate-data steps gate something or are non-blocking', () => {
  const dir = path.join(REPO, '.github/workflows');
  const files = fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f));
  assert.ok(files.length > 50);
  const bad = [];
  for (const f of files) {
    for (const h of scanWorkflow(fs.readFileSync(path.join(dir, f), 'utf8'))) bad.push(`${f}: ${h.job} / ${h.step}`);
  }
  assert.deepEqual(bad, []);
});
