// BRO-7267: white labels on the gold gradient are 2.2-2.8:1 (fails WCAG AA).
// Gold fills (bg-gradient-brand, .btn-primary) carry the near-black label.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

test('no bg-gradient-brand with text-white on the same line in src', () => {
  let hits = [];
  try {
    hits = execSync(`grep -rnE "bg-gradient-brand.*text-white|text-white.*bg-gradient-brand" src --include=*.tsx --include=*.ts --include=*.css`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch (e) { if (e.status !== 1) throw e; }
  assert.deepStrictEqual(hits, [], 'gold gradient needs text-[#1a1208]:\n' + hits.join('\n'));
});

test('.btn-primary uses the near-black label', () => {
  const css = readFileSync('src/app/globals.css', 'utf8');
  const m = css.match(/\.btn-primary\s*\{[^}]*\}/);
  assert.ok(m, '.btn-primary rule found');
  assert.ok(m[0].includes('text-[#1a1208]'), m[0]);
  assert.ok(!/text-white/.test(m[0]), m[0]);
});

test('TicketButtonsAB default primary label is near-black', () => {
  const src = readFileSync('src/components/TicketButtonsAB.tsx', 'utf8');
  const line = src.split('\n').find(l => l.includes('primaryButtonClassName =') && l.includes('bg-gradient-brand'));
  assert.ok(line && line.includes('text-[#1a1208]'));
});
