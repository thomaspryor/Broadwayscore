// BRO-7139 Step 1: every board row names the job that acts on it, and every row nothing acts on is pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CATEGORIES, GROUPS } = require('./board-categories.js');
const { HANDLERS, KNOWN_GAPS, gapsOf } = require('./board-handlers.js');

const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');

test('every category declares a handlers list of known handler ids', () => {
  for (const c of CATEGORIES) {
    assert.ok(Array.isArray(c.handlers), `${c.key} has no handlers field`);
    for (const id of c.handlers) assert.ok(HANDLERS[id], `${c.key} names unknown handler ${id}`);
  }
});

test('every built handler is really run by its workflow, with the exact invocation', () => {
  for (const [id, h] of Object.entries(HANDLERS)) {
    assert.ok(['apply', 'report-only', 'planned'].includes(h.mode), `${id} has mode ${h.mode}`);
    if (h.mode === 'planned') {
      assert.equal(h.workflow, null, `${id} is planned but names a workflow`);
      continue;
    }
    assert.ok(fs.existsSync(path.join(REPO, h.script)), `${id}: ${h.script} is missing`);
    const wf = path.join(REPO, h.workflow);
    assert.ok(fs.existsSync(wf), `${id}: ${h.workflow} is missing`);
    const text = fs.readFileSync(wf, 'utf8');
    assert.ok(text.includes(h.invocation), `${id}: ${h.workflow} no longer runs "${h.invocation}"`);
    for (const s of h.mustContain || []) assert.ok(text.includes(s), `${id}: ${h.workflow} lacks "${s}"`);
    // The invocation must not sit in a step switched off with `if: false`.
    const idx = text.indexOf(h.invocation);
    const stepStart = text.lastIndexOf('\n      - ', idx);
    assert.ok(!/\bif:\s*(?:false|\$\{\{\s*false\s*\}\})/.test(text.slice(stepStart, idx)), `${id}: its step is disabled`);
  }
});

test('the rows nothing applies to are exactly KNOWN_GAPS (ratchet both ways)', () => {
  assert.deepEqual([...gapsOf(CATEGORIES)].sort(), [...KNOWN_GAPS].sort());
});

test('a stuck-group row is never silently unhandled: a gap there must be pinned', () => {
  const stuck = GROUPS.find((g) => g.key === 'stuck').keys;
  const unhandled = gapsOf(CATEGORIES.filter((c) => stuck.includes(c.key)));
  for (const k of unhandled) assert.ok(KNOWN_GAPS.includes(k), `${k} is stuck and unhandled`);
});

test('gapsOf: a row with only report-only or planned handlers is a gap; one apply handler covers it', () => {
  const cats = [
    { key: 'a', handlers: ['board-hygiene-sweep'] },
    { key: 'b', handlers: ['llm-triage'] },
    { key: 'c', handlers: [] },
    { key: 'd', handlers: ['board-hygiene-sweep', 'owner-hold-sweep'] },
    { key: 'e' },
  ];
  assert.deepEqual(gapsOf(cats), ['a', 'b', 'c', 'e']);
});
