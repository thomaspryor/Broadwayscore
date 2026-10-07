import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dir = new URL('../../data/audit/', import.meta.url);
const load = (f) => JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'));

test('daily baseline has cost data or a documented error', () => {
  const d = load('ccusage-2026-09-daily.json');
  if (d.error) return assert.equal(typeof d.error, 'string');
  assert.ok(Array.isArray(d.daily) && d.daily.length > 0);
  for (const day of d.daily) assert.ok(Number.isFinite(day.totalCost) && day.totalCost >= 0);
  assert.ok(d.totals.totalCost > 0);
});

test('sessions baseline is well-formed', () => {
  const s = load('ccusage-2026-09-sessions.json');
  if (s.error) return assert.equal(typeof s.error, 'string');
  assert.ok(Array.isArray(s.session) && s.session.length > 0);
  for (const x of s.session) assert.ok(Number.isFinite(x.totalCost));
});

test('monthly baseline is well-formed', () => {
  const m = load('ccusage-monthly.json');
  if (m.error) return assert.equal(typeof m.error, 'string');
  assert.ok(Array.isArray(m.monthly) && m.monthly.length > 0);
});
