// BRO-2681: dispatch-ledger.js had its own Mac-only REPO literal. Its ledger
// must live in the same main checkout the dispatchers resolve (repo-root.js),
// or a non-Mac run splits the ledger from the claim/queue paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MAIN_REPO_ROOT } = require('../../scripts/lib/repo-root.js');
const dispatchLedger = require('../../scripts/lib/dispatch-ledger.js');
const drain = require('../../scripts/linear-drain-parked.js');

test('dispatch-ledger LEDGER_PATH lives under MAIN_REPO_ROOT', () => {
  assert.equal(dispatchLedger.LEDGER_PATH, path.join(MAIN_REPO_ROOT, 'data', 'audit', 'dispatch-ledger.jsonl'));
});

test('dispatch-ledger.js resolves REPO through repo-root.js, not a literal', () => {
  const src = fs.readFileSync(new URL('../../scripts/lib/dispatch-ledger.js', import.meta.url), 'utf8');
  assert.match(src, /^const \{ MAIN_REPO_ROOT: REPO \} = require\('\.\/repo-root'\);$/m);
});

// BRO-3545: the drain ledger is git-tracked, so CI must find it in its checkout.
test('linear-drain-parked LEDGER_PATH resolves to the committed ledger in this checkout', () => {
  assert.equal(drain.LEDGER_PATH, path.join(MAIN_REPO_ROOT, 'data', 'audit', 'linear-drain-parked-ledger.jsonl'));
  assert.ok(fs.existsSync(drain.LEDGER_PATH), `expected the tracked ledger at ${drain.LEDGER_PATH}`);
});
