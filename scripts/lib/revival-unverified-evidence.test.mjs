// BRO-7354: revival-unverified sweep must warn the digest only on structural
// evidence (same-title earlier production), never on review-text mention counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const chk = require('./opening-night-checks/revival-unverified.check.js');
const { lifetimeSweepRowResult } = require('./lifetime-sweep-row.js');

const fmt = (h) => `${Math.round(h)}h`;
const row = (snap) => lifetimeSweepRowResult({ name: 'n', snap, ageHours: 1, scriptName: 's.js', stepName: 'st', unit: 'u', formatAge: fmt });

test('mention-only hit is not evidence; title match is', () => {
  const mention = chk.extractViolations({ details: { titleMatch: false, mentionCount: 4 } });
  const title = chk.extractViolations({ details: { titleMatch: true, mentionCount: 0 } });
  assert.equal(chk.isRevivalEvidence(mention[0]), false);
  assert.equal(chk.isRevivalEvidence(title[0]), true);
  assert.equal(chk.isRevivalEvidence({}), false);
});

test('digest row passes for new mention-only hits, warns for open title-match hit', () => {
  const base = { totalViolations: 3, showsWithViolations: 3, scanned: 100, newSinceLastRun: 2 };
  assert.equal(row({ ...base, actionableOpen: {} }).status, 'pass');
  assert.equal(row({ ...base, actionableOpen: { 'a-2026': new Date().toISOString() } }).status, 'warn');
});

test('audit script wires the evidence rule (class guard: reverting it fails here)', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'audit-revival-unverified-lifetime.js'), 'utf8');
  assert.match(src, /isActionable:\s*revivalUnverified\.isRevivalEvidence/);
  assert.match(src, /extractViolations:\s*revivalUnverified\.extractViolations/);
});
