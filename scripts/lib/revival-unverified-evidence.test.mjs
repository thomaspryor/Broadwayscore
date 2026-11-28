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

test('row wording is revival-specific, not contamination', () => {
  const r = lifetimeSweepRowResult({ name: 'n', snap: { totalViolations: 1, showsWithViolations: 1, scanned: 9, newSinceLastRun: 1, actionableOpen: { 'a-2026': 'x' } }, ageHours: 1, scriptName: 's.js', stepName: 'st', unit: 'u', formatAge: fmt, evidenceLabel: 'a same-title earlier production', openRemedy: 'set isRevival' });
  assert.match(r.message, /same-title earlier production/);
  assert.match(r.hint, /set isRevival/);
  assert.doesNotMatch(r.hint + r.message, /wrongShow|contamination/);
});

test('health-check wires revival wording into the row', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'health-check.js'), 'utf8');
  assert.match(src, /openRemedy: 'set isRevival/);
  assert.match(src, /lifetimeSweepRowResult\(\{[^}]*evidenceLabel, openRemedy/);
});

test('end to end: runner opens only the title-match show, via the real check', () => {
  const { runLifetimeSweep } = require('./opening-night-checks/lifetime-sweep-runner.js');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rv7354-'));
  const rt = path.join(tmp, 'rt');
  for (const id of ['orig-2000', 'dup-2020', 'mention-2021']) fs.mkdirSync(path.join(rt, id), { recursive: true });
  const text = 'Solo. ' + 'A revival revival revival of note. '.repeat(30);
  fs.writeFileSync(path.join(rt, 'mention-2021', 'x.json'), JSON.stringify({ fullText: text, outlet: 'nytimes', url: 'https://www.nytimes.com/2021/02/01/theater/solo-review.html', showId: 'mention-2021', contentTier: 'complete', publishDate: '2021-02-01' }));
  const shows = { shows: [
    { id: 'orig-2000', title: 'Dup', category: 'broadway', status: 'open', openingDate: '2000-01-01' },
    { id: 'dup-2020', title: 'Dup', category: 'broadway', status: 'open', openingDate: '2020-01-01' },
    { id: 'mention-2021', title: 'Solo', category: 'broadway', status: 'open', openingDate: '2021-01-01' },
  ] };
  fs.writeFileSync(path.join(tmp, 'shows.json'), JSON.stringify(shows));
  fs.writeFileSync(path.join(tmp, 'reviews.json'), JSON.stringify({ reviews: [] }));
  const lines = [];
  const orig = console.log; console.log = (m) => lines.push(m);
  try {
    runLifetimeSweep({ checkModule: chk, scriptName: 't.js', taskRef: 't', snapshotBasename: 't.json', countSeverities: ['warning'], needsShows: true,
      extractViolations: chk.extractViolations, isActionable: chk.isRevivalEvidence,
      argv: ['--json', '--no-snapshot', `--review-texts-dir=${rt}`, `--shows-path=${path.join(tmp, 'shows.json')}`, `--reviews-path=${path.join(tmp, 'reviews.json')}`] });
  } finally { console.log = orig; }
  const out = JSON.parse(lines.join('\n'));
  assert.deepEqual(out.hits.map((h) => h.showId).sort(), ['dup-2020', 'mention-2021']);
  assert.equal(out.actionableViolations, 1);
});
