// Tests for the Phase 1 (BRO-377) Notion read-only guard.
//
// Two halves, and the second is the one that matters. The pure verdict is easy;
// what actually protects the migration is that notion-brain.js's ONE create
// call site consults it and exits non-zero, and that updates are NOT gated —
// a guard that also blocked updates would make notion-action-poll.js reprocess
// the same action forever and would strand every open Notion card unclosable.
//
// Structural assertions read the real source (the pattern
// scripts/autonomous-merge-core-data-guard.test.mjs established) so that
// deleting the wiring fails here, not silently in production six days later.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const { notionCreateVerdict, ESCAPE_ENV } = require(join(HERE, 'notion-write-guard.js'));

test('refuses a create by default, and says what to do instead', () => {
  const v = notionCreateVerdict({});
  assert.equal(v.allowed, false);
  assert.match(v.reason, /READ-ONLY/);
  assert.match(v.reason, /linear-brain\.js create/, 'a refusal that does not name the alternative just gets worked around');
  assert.match(v.reason, /BRO-377/, 'name the card so the next reader can find out why');
});

test('the refusal tells the reader updates still work', () => {
  // Without this line someone reasonably concludes the whole board is frozen
  // and stops closing old cards, which is the opposite of draining it.
  assert.match(notionCreateVerdict({}).reason, /updated and closed/i);
});

test('the escape hatch is honoured, and is never silent', () => {
  const v = notionCreateVerdict({ [ESCAPE_ENV]: '1' });
  assert.equal(v.allowed, true);
  assert.ok(v.reason, 'an allowed-by-bypass verdict MUST carry a reason so the caller can log it');
  assert.match(v.reason, new RegExp(ESCAPE_ENV));
});

test('only the exact value "1" opens the hatch', () => {
  for (const val of ['0', 'true', 'yes', '', 'TRUE', ' 1']) {
    assert.equal(notionCreateVerdict({ [ESCAPE_ENV]: val }).allowed, false, `${JSON.stringify(val)} must not bypass`);
  }
});

test('the ordinary allowed path carries no reason to log', () => {
  // Guards the caller's `if (writeVerdict.reason)` logging branch: if a future
  // edit made every verdict carry a reason, every create would print a warning.
  const v = notionCreateVerdict({ [ESCAPE_ENV]: '1' });
  assert.equal(typeof v.reason, 'string');
  assert.equal(notionCreateVerdict({}).allowed, false);
});

test('notion-brain.js actually consults the guard at its create call site', () => {
  const src = readFileSync(join(REPO, 'scripts', 'notion-brain.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/notion-write-guard['"]\)/, 'guard must be required');

  const createIdx = src.indexOf('notion.pages.create(');
  assert.ok(createIdx > 0, 'the create call site must exist — if this moved, re-point the guard');
  const guardIdx = src.indexOf('notionCreateVerdict(process.env)');
  assert.ok(guardIdx > 0, 'the guard must be CALLED, not merely imported');
  assert.ok(guardIdx < createIdx, 'the guard must run BEFORE the create, or it guards nothing');

  const between = src.slice(guardIdx, createIdx);
  assert.match(between, /process\.exit\(/, 'a refusal must actually stop the create');
});

test('updates and archives are deliberately NOT gated', () => {
  const src = readFileSync(join(REPO, 'scripts', 'notion-brain.js'), 'utf8');
  // Exactly one guard call: gating pages.update too would make
  // notion-action-poll.js reprocess actions forever (see the guard's header).
  const calls = src.match(/notionCreateVerdict\(/g) || [];
  assert.equal(calls.length, 1, `guard should be called once (at create), found ${calls.length}`);
  assert.ok(src.includes('notion.pages.update('), 'update path should still exist and be ungated');
});
