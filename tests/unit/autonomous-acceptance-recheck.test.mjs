// Regression guard for BRO-2359: autonomous-acceptance-recheck.js only scanned
// Notion cards, so a RECHECK-AFTER stamp on a card without a Notion twin was
// invisible for days. BRO-3373 added the Linear candidate source; this asserts
// the recheck script still wires it in and the source exports its entry point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '../..');
const scriptPath = path.join(root, 'scripts/autonomous-acceptance-recheck.js');

test('recheck script exists', () => {
  assert.ok(fs.existsSync(scriptPath));
});

test('recheck script pulls Linear candidates, not only Notion', () => {
  const src = fs.readFileSync(scriptPath, 'utf8');
  assert.match(src, /require\('\.\/lib\/linear-recheck-source\.js'\)/);
  assert.match(src, /fetchLinearRecheckCandidates\(/);
});

test('linear-recheck-source exports the real entry points', () => {
  const mod = require('../../scripts/lib/linear-recheck-source.js');
  assert.equal(typeof mod.fetchLinearRecheckCandidates, 'function');
  assert.equal(typeof mod.mapIssueToCard, 'function');
  assert.equal(typeof mod.buildRecheckCandidatesQuery, 'function');
});
