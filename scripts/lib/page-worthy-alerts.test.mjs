import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { isPageWorthy } = createRequire(import.meta.url)('./page-worthy-alerts.js');

test('opening-night monitor final report / escalation pages the owner (BRO-2791)', () => {
  assert.equal(isPageWorthy('on-monitor-report-2026-09-04'), true);
  assert.equal(isPageWorthy('on-monitor-report-test'), true);
});

test('per-pass monitor noise stays off the page list', () => {
  assert.equal(isPageWorthy('on-monitor-attempts-exhausted-2026-09-04'), false);
  assert.equal(isPageWorthy('on-monitor-auth-starved-2026-09-04'), false);
});

test('real substituted key shape pages (NIGHT_KEY is itself on-monitor-<date>)', () => {
  assert.equal(isPageWorthy('on-monitor-report-on-monitor-2026-09-04'), true);
  assert.equal(isPageWorthy('on-monitor-report-on-monitor-forced-some-show'), true);
});
