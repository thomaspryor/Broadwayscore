// BRO-3342: a terminal push-with-retry.sh failure must never be masked at the
// workflow boundary (`|| echo`, `|| true`, `|| :`). Re-raising (`|| { ...; exit 1; }`)
// is fine; non-blocking steps use step-level `continue-on-error: true` instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WORKFLOW = new URL('../../.github/workflows/test.yml', import.meta.url);
const lines = readFileSync(WORKFLOW, 'utf8').split('\n');

// Returns the offending handler text if the line masks the push status.
export function maskedPushHandler(line) {
  const m = line.match(/push-with-retry\.sh(?:\s+[^|\s]\S*)*\s*(?:\|\|\s*(.*))?$/);
  if (!m || line.trim().startsWith('#') || !m[1]) return null;
  const handler = m[1].trim();
  return /\bexit\s+[1-9]/.test(handler) || /\breturn\s+[1-9]/.test(handler) ? null : handler;
}

test('detector flags masking and accepts re-raise', () => {
  assert.ok(maskedPushHandler('bash scripts/lib/push-with-retry.sh || echo "::warning::x"'));
  assert.ok(maskedPushHandler('bash scripts/lib/push-with-retry.sh || true'));
  assert.ok(maskedPushHandler('bash scripts/lib/push-with-retry.sh || :'));
  assert.equal(maskedPushHandler('bash scripts/lib/push-with-retry.sh || { echo "w"; exit 1; }'), null);
  assert.ok(maskedPushHandler('bash scripts/lib/push-with-retry.sh 5 main || echo w'));
  assert.equal(maskedPushHandler('bash scripts/lib/push-with-retry.sh'), null);
  assert.equal(maskedPushHandler('# bash scripts/lib/push-with-retry.sh || echo hi'), null);
});

test('test.yml never masks push-with-retry.sh failures', () => {
  const bad = [];
  lines.forEach((l, i) => {
    const h = maskedPushHandler(l);
    if (h) bad.push(`test.yml:${i + 1}: ${l.trim()}`);
  });
  assert.deepEqual(bad, [], `masked push failures:\n${bad.join('\n')}`);
});
