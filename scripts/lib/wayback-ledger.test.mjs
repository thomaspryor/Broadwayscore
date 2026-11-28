// BRO-7944: recover-wayback-reviews writes gap-recovery ledger rows. Run: node --test scripts/lib/wayback-ledger.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WL = require('./wayback-ledger.js');
const L = require('./gap-recovery-ledger.js');

test('accepted write -> pending_push row; landing -> recovered row; refusal row carries diagnostics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  const filePath = path.join(dir, 'some-show-2026', 'outlet--critic.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ fullText: 'short' }));
  const cand = { filePath, url: 'https://o.test/r', contentTier: 'stub' };
  const before = WL.snapshotBefore(cand);
  assert.equal(before, 5);
  fs.writeFileSync(filePath, JSON.stringify({ fullText: 'x'.repeat(900) }));
  WL.recordAccepted(cand, { bytesBefore: before, ledgerPath: ledger });
  WL.onLanded({ path: filePath, blob: 'abc', commit: 'c1' }, ledger);
  WL.recordRefusal({ ...cand, filePath: path.join(dir, 'some-show-2026', 'other--x.json') }, { outcome: 'no_evidence', reason: 'archive_empty', error: 'no snapshots', ledgerPath: ledger });
  const rows = L.readRows(ledger);
  assert.deepEqual(rows.map((r) => r.outcome), ['pending_push', 'recovered', 'no_evidence']);
  assert.equal(rows[0].strategy, 'ARCHIVE');
  assert.equal(rows[0].bytesBefore, 5);
  assert.equal(rows[0].bytesAfter, 900);
  assert.equal(rows[1].reviewKey, 'some-show-2026/outlet--critic.json');
  assert.equal(rows[2].url, 'https://o.test/r');
  assert.equal(rows[2].tier, 'stub');
  assert.equal(rows[2].error, 'no snapshots');
});

test('class guard: recover-wayback-reviews.js wires the ledger (attempt rows + onLanded on both push paths)', () => {
  const src = fs.readFileSync(new URL('../recover-wayback-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /require\('\.\/lib\/wayback-ledger'\)/);
  assert.match(src, /checkpointRtWrites\(\{[\s\S]*?onLanded: \(landed\) => WL\.onLanded/);
  assert.match(src, /retryPendingPushes\(\{ repoDir: RT_DIR, onLanded/);
  assert.match(src, /expected: RUN_WRITES\.expected/, 'landing must verify OUR text, not whatever a concurrent writer left');
  assert.equal((src.match(/processRecoveredText\(c,/g) || []).length, 0, 'call sites must go through recoverAndRecord');
});
