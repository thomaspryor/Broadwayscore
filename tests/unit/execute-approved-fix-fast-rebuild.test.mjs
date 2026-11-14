// BRO-7131: an applied fix must trigger rebuild-fast, or it waits up to 4h for the safety cron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const yml = fs.readFileSync(new URL('../../.github/workflows/execute-approved-fix.yml', import.meta.url), 'utf8');

test('execute-approved-fix dispatches rebuild-fast after a fixed, landed apply', () => {
  const i = yml.indexOf('name: Fast rebuild so the fix reaches the site');
  assert.ok(i > 0, 'fast rebuild step missing');
  const step = yml.slice(i, i + 900);
  assert.match(step, /steps\.exec\.outputs\.result == 'fixed'/);
  assert.match(step, /steps\.push_gate\.outputs\.ok == 'true'/);
  assert.match(step, /dispatch_with_retry rebuild-fast\.yml/);
  assert.ok(i > yml.indexOf('name: Commit and push changes'), 'must run after the plan status is pushed');
});
