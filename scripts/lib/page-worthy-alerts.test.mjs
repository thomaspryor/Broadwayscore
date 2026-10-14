import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { isPageWorthy } = createRequire(import.meta.url)('./page-worthy-alerts.js');

test('window-end ESCALATION from the opening-night monitor pages the owner (BRO-2791)', () => {
  assert.equal(isPageWorthy('on-monitor-escalation-on-monitor-2026-09-04'), true);
  assert.equal(isPageWorthy('on-monitor-escalation-on-monitor-forced-some-show'), true);
});

test('the success report and per-pass monitor noise stay in the digest', () => {
  assert.equal(isPageWorthy('on-monitor-report-on-monitor-2026-09-04'), false);
  assert.equal(isPageWorthy('on-monitor-attempts-exhausted-2026-09-04'), false);
  assert.equal(isPageWorthy('on-monitor-auth-starved-2026-09-04'), false);
});
