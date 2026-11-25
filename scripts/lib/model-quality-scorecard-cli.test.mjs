import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// BRO-8289: --json must keep stdout pure JSON (trailing advice goes to stderr).
test('scorecard --json stdout parses as JSON', () => {
  const r = spawnSync('node', ['scripts/model-quality-scorecard.js', '--json', '--no-linear'], { encoding: 'utf8' });
  if (r.status === 2 && /landings\.jsonl missing/.test(r.stderr)) return; // ledger absent on this checkout: nothing to serialize
  assert.ok([0, 1, 3].includes(r.status), `unexpected exit ${r.status}: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  assert.ok(['OK', 'WORSE', 'INSUFFICIENT DATA'].includes(j.verdict));
});
