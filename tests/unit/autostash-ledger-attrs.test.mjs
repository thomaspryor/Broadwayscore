// BRO-7595: the append-only audit ledgers must
// carry an autostash attribute, or two concurrent CI runs that both touch them
// log an autostash-conflict row (2,309 of them kept the Push-retry deadman row red).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MERGE = path.join(ROOT, 'scripts/lib/json-three-way-merge.js');
const attr = (p) => execFileSync('git', ['check-attr', 'autostash', '--', p], { cwd: ROOT, encoding: 'utf8' }).trim().split(': ').pop();

const APPEND = ['data/audit/url-mismatch-suspects.json', 'data/audit/market-misroutes.json', 'data/audit/gather-collisions.json'];

test('append-only array ledgers are autostash=append', () => {
  for (const p of APPEND) assert.equal(attr(p), 'append', p);
});

test('exclusion-daily-totals stays untagged (past days are never recomputed; regenerated would also change rebase merges)', () => {
  assert.equal(attr('data/audit/exclusion-daily-totals.json'), 'unspecified');
});

function merge(base, ours, theirs, flags = ['--append-arrays']) {
  const d = mkdtempSync(path.join(tmpdir(), 'asl-'));
  const f = (n, v) => { const q = path.join(d, n); writeFileSync(q, JSON.stringify(v, null, 2) + '\n'); return q; };
  const out = path.join(d, 'out.json');
  try {
    execFileSync('node', [MERGE, f('base', base), f('ours', ours), f('theirs', theirs), out, ...flags], { stdio: 'pipe' });
  } catch { return null; }
  return JSON.parse(readFileSync(out, 'utf8'));
}

test('two runs each appending a row to the real url-mismatch ledger union, and the flag is what makes it so', () => {
  const real = JSON.parse(readFileSync(path.join(ROOT, 'data/audit/url-mismatch-suspects.json'), 'utf8')).slice(-50);
  const a = { requestedUrl: 'https://x.test/a', actualUrl: 'https://x.test/a2', fetchedAt: '2026-11-17T00:00:00.000Z', source: 'ScrapingBee', hostname: 'x.test' };
  const b = { ...a, requestedUrl: 'https://y.test/b', hostname: 'y.test' };
  const merged = merge(real, [...real, a], [...real, b]);
  assert.ok(merged, 'append merge must succeed');
  assert.equal(merged.length, real.length + 2);
  assert.ok(merged.some((r) => r.requestedUrl === a.requestedUrl) && merged.some((r) => r.requestedUrl === b.requestedUrl));
  assert.equal(merge(real, [...real, a], [...real, b], []), null, 'without --append-arrays the same input is a conflict (what the attribute fixes)');
});
