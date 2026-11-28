import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { findFreshClaim, freshClaimGuard } = createRequire(import.meta.url)('./fresh-claim-guard.js');

const NOW = Date.parse('2026-10-26T01:32:00Z');
const claim = (iso, ref = 'https://claude.ai/code/session_01Ha') => ({ body: `Claimed by ${ref} at ${iso}`, createdAt: iso });

test('BRO-6276 shape: cloud claim 1 min old blocks the Mac dispatcher', () => {
  const msg = freshClaimGuard('BRO-6276', [claim('2026-10-26T01:31:00Z')], NOW, {});
  assert.match(msg, /REFUSING to dispatch BRO-6276/);
  assert.match(msg, /session_01Ha/);
});
test('claim older than 6h no longer blocks', () => {
  assert.equal(findFreshClaim([claim('2026-10-25T18:00:00Z')], NOW), null);
});
test('a later session report releases the claim', () => {
  const c = [claim('2026-10-26T01:00:00Z'), { body: '**Session report (paused)**\nx', createdAt: '2026-10-26T01:20:00Z' }];
  assert.equal(findFreshClaim(c, NOW), null);
});
test('codex bounce, watchdog park and PR-EVIDENCE release the claim; leading whitespace tolerated', () => {
  for (const body of ['<!-- codex-runner-bounced -->\nx', '## Codex runner: stopped mid-card', 'Watchdog safety net: parked', 'PR-EVIDENCE: merged deployed checked (x)', '  \n**Session report (done)**']) {
    assert.equal(findFreshClaim([claim('2026-10-26T01:00:00Z'), { body, createdAt: '2026-10-26T01:10:00Z' }], NOW), null, body);
  }
  assert.ok(findFreshClaim([{ body: '  Claimed by x at t', createdAt: '2026-10-26T01:31:00Z' }], NOW));
});
test('watchdog redispatch of a dead job passes --allow-fresh-claim', async () => {
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../dispatch-watchdog.js', import.meta.url), 'utf8'), /'--headless', '--allow-fresh-claim'/);
});
test('a re-claim after a release blocks again', () => {
  const c = [claim('2026-10-26T00:00:00Z'), { body: 'RECLAIMED-ABANDONED: x', createdAt: '2026-10-26T00:10:00Z' }, claim('2026-10-26T01:00:00Z', 'local session abc')];
  assert.equal(findFreshClaim(c, NOW).holder, 'local session abc');
});
test('own session ref never blocks itself', () => {
  assert.equal(findFreshClaim([claim('2026-10-26T01:31:00Z')], NOW, { selfRef: 'session_01Ha' }), null);
});
test('overrides and previews bypass; no comments is fine', () => {
  const c = [claim('2026-10-26T01:31:00Z')];
  for (const o of [{ force: true }, { 'allow-fresh-claim': true }, { 'dry-run': true }, { 'print-prompt': true }]) assert.equal(freshClaimGuard('BRO-1', c, NOW, o), null);
  assert.equal(freshClaimGuard('BRO-1', [], NOW, {}), null);
  assert.equal(freshClaimGuard('BRO-1', undefined, NOW, {}), null);
});
test('linear-next.js wires the guard', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../linear-next.js', import.meta.url), 'utf8');
  assert.match(src, /freshClaimGuard\(/);
});
