// Pins owner-chosen section placement in the Broadway edition. Reads the real
// sectionOrder array out of generate.mjs (no copied logic) and checks the
// relative order of slot names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generate.mjs'), 'utf8');
const start = src.indexOf('const sectionOrder = IS_WE ? [');
const bwStart = src.indexOf('].filter(Boolean) : [', start);
const bwEnd = src.indexOf('].filter(Boolean);', bwStart);
const bwSlots = [...src.slice(bwStart, bwEnd).matchAll(/_slot\('([^']+)'/g)].map(m => m[1]);

test('found the Broadway section order', () => {
  assert.ok(bwSlots.length > 10, `parsed ${bwSlots.length} slots`);
});

test('Newly Scored Tours comes right after Out of Town (owner, 2026-11-02)', () => {
  const oot = bwSlots.indexOf('out-of-town-openings');
  assert.ok(oot >= 0);
  assert.equal(bwSlots[oot + 1], 'new-tour-scores');
  assert.equal(bwSlots.filter(s => s === 'new-tour-scores').length, 1, 'tours renders once');
});

test('London openings stay after the closings block (owner, 2026-07-12)', () => {
  assert.ok(bwSlots.indexOf('london-openings') > bwSlots.indexOf('announced-closings'));
});
