import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Point the router at a fixture ledger BEFORE it loads (it reads the path at require time).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dependabot-cards-'));
const ledgerPath = path.join(dir, 'alert-ledger.json');
process.env.ALERT_LEDGER_PATH = ledgerPath;
process.env.ALERT_DIGEST_QUEUE_PATH = path.join(dir, 'queue.json');
const require = createRequire(import.meta.url);
const { main } = require('./route-dependabot-pr-cards.js');

const seen = '2026-10-27T16:01:00.234Z';
function writeFixtures(prs) {
  fs.writeFileSync(ledgerPath, JSON.stringify({ conditions: {
    'dependabot-pr:1165': { status: 'open', lastSeen: seen, firstSeen: seen },
    'dependabot-pr:1175': { status: 'open', lastSeen: seen, firstSeen: seen },
  } }));
  const prsPath = path.join(dir, 'prs.json');
  fs.writeFileSync(prsPath, JSON.stringify(prs));
  return prsPath;
}

test('--dry-run touches nothing', async () => {
  const prsPath = writeFixtures([]);
  const before = fs.readFileSync(ledgerPath, 'utf8');
  assert.equal(await main(['--dry-run'], { PRS_JSON: prsPath }), 0);
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), before);
});

test('resolves the condition of a PR that is no longer open, keeps the open one', async () => {
  // 1175 is open but not a dependabot/ branch, so nothing is routed (no Linear call).
  const prsPath = writeFixtures([{ number: 1175, title: 't', url: 'u', headRefName: 'claude/x', isCrossRepository: false }]);
  assert.equal(await main([], { PRS_JSON: prsPath }), 0);
  const { conditions } = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.equal(conditions['dependabot-pr:1165'].status, 'resolved');
  assert.match(conditions['dependabot-pr:1165'].resolveReason, /no longer open/);
  assert.equal(conditions['dependabot-pr:1175'].status, 'open');
});

test('unreadable or non-array PRS_JSON exits 2 and resolves nothing', async () => {
  writeFixtures([]);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{"message":"API rate limit"}');
  assert.equal(await main([], { PRS_JSON: bad }), 2);
  assert.equal(await main([], { PRS_JSON: path.join(dir, 'missing.json') }), 2);
  const { conditions } = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.equal(conditions['dependabot-pr:1165'].status, 'open');
});
