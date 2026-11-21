// BRO-2388: acceptance test. push-with-retry.sh must exist and no workflow that
// commits the scraper-spend ledger may sit on a too-shallow checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { findShallowLedgerCheckouts } = createRequire(import.meta.url)('../../scripts/lib/ledger-checkout-depth.js');

test('push-with-retry.sh exists', () => {
  assert.ok(fs.existsSync('scripts/lib/push-with-retry.sh'));
});
test('no ledger-committing workflow job has a depth-1 checkout (BRO-2388)', () => {
  const bad = [];
  for (const f of fs.readdirSync('.github/workflows').filter((x) => x.endsWith('.yml'))) {
    for (const r of findShallowLedgerCheckouts(fs.readFileSync(`.github/workflows/${f}`, 'utf8'))) bad.push(`${f}:${r.line}`);
  }
  assert.deepEqual(bad, []);
});
