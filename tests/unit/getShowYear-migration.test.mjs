// BRO-3096: a bare YYYY-MM-DD parsed by `new Date()` is UTC midnight, and
// getFullYear() reads local time, so Jan 1 openings render as the prior year
// west of UTC. Show years must come from getShowYear() (reads the string).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', '..', 'src');
const BARE = /new Date\(\s*[\w.?]*\b(openingDate|closingDate|previewsStartDate|previewDate)\s*\)\s*\.getFullYear\(\)/;
// `const x = new Date(<show>.openingDate);` followed by `x.getFullYear()`
const ASSIGNED = /const (\w+) = new Date\(\s*[\w.?]*\b(?:openingDate|closingDate|previewsStartDate|previewDate)\s*\);[\s\S]{0,300}?\b\1\.getFullYear\(\)/;

// Pending UI follow-up: this page needs a visual-approval landing (BRO-3096). Remove when migrated.
const PENDING_UI = new Set([path.join('app', 'research', 'critic-audience-divergence-2026', 'page.tsx')]);

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

export const offends = s => BARE.test(s) || ASSIGNED.test(s);

test('detector flags both bare and assigned forms', () => {
  assert.ok(offends('const y = new Date(show.openingDate).getFullYear();'));
  assert.ok(offends('const d = new Date(show.openingDate);\n  return d.getFullYear() > 2000;'));
  assert.ok(!offends('const y = getShowYear(show.openingDate);'));
  assert.ok(!offends("new Date(prod.openingDate + 'T12:00:00').getFullYear()"));
});

test('no src file derives a show year from new Date(bareDate).getFullYear()', () => {
  const bad = walk(SRC).filter(f => !f.endsWith(path.join('lib', 'date-utils.ts')) && offends(fs.readFileSync(f, 'utf8'))).map(f => path.relative(SRC, f)).filter(f => !PENDING_UI.has(f));
  assert.deepEqual(bad, [], 'use getShowYear() from src/lib/date-utils.ts');
});
