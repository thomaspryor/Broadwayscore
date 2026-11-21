// BRO-3041: the day-scoped quota ledger must not be reused as a multi-day
// per-URL backoff (it resets submissions[] every day, so a count filter on it
// is always 0 and its "skipped" figure always lied).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '../..');

test('readQuotaLedger drops submissions from a previous day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-ledger-'));
  const p = path.join(dir, 'ledger.json');
  fs.writeFileSync(p, JSON.stringify({ date: '2020-01-01', used: 3, submissions: [{ url: 'u', time: 't' }] }));
  const out = execFileSync(process.execPath, ['-e',
    "console.log(JSON.stringify(require('./scripts/submit-google-indexing.js').readQuotaLedger()))"],
    { cwd: root, env: { ...process.env, INDEXING_LEDGER_PATH: p }, encoding: 'utf8' });
  const l = JSON.parse(out.trim().split('\n').pop());
  assert.equal(l.used, 0);
  assert.deepEqual(l.submissions, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('check-seo-health does not fake a backoff from the day-scoped ledger', () => {
  const src = fs.readFileSync(path.join(root, 'scripts/check-seo-health.js'), 'utf8');
  assert.doesNotMatch(src, /submissionCounts/);
  assert.doesNotMatch(src, /at backoff limit/);
  assert.doesNotMatch(src, /skipped:\s*highValueUrls\.length\s*-\s*candidates\.length/);
});
