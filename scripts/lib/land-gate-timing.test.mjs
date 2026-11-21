// scripts/lib/land-gate-timing.test.mjs — BRO-7324. collectTiming() is what land.yml
// records on each landing row; required from the lib, never restated (rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { collectTiming, summaryLines } = require('./land-gate-timing.js');
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), 'land-gate-timing.js');

function outDir(root, name, meta, { scoped = false } = {}) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  if (meta) fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(meta));
  if (scoped) fs.writeFileSync(path.join(d, 'SCOPED'), '');
  return d;
}

const T0 = Date.parse('2026-11-21T12:00:00Z');

test('keeps runs finished in this job, drops a restored base with an old meta.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-'));
  outDir(root, 'branch', { finishedAt: '2026-11-21T12:20:00Z', wallMs: 960400, gates: ['tsc', 'next-lint'], gateSecs: { tsc: 81.6, 'next-lint': 120.2 } });
  outDir(root, 'base', { finishedAt: '2026-11-20T09:00:00Z', wallMs: 900000, gates: ['tsc'], gateSecs: { tsc: 70 } });
  outDir(root, 'confirm', { finishedAt: '2026-11-21T12:30:00Z', wallMs: 300000, gates: ['tsc'], gateSecs: { tsc: 75, bad: 'x' } }, { scoped: true });
  outDir(root, 'scope-only', null);
  const t = collectTiming({ roots: [root], t0Ms: T0 });
  const k = path.basename(root);
  assert.deepEqual(Object.keys(t.runs).sort(), [`${k}/branch`, `${k}/confirm`]);
  assert.deepEqual(t.runs[`${k}/branch`], { wallSecs: 960, gateSecs: { tsc: 82, 'next-lint': 120 }, gateCount: 2, scoped: false });
  assert.equal(t.runs[`${k}/confirm`].scoped, true);
  assert.deepEqual(t.runs[`${k}/confirm`].gateSecs, { tsc: 75 });
  assert.match(summaryLines(t).join('\n'), /next-lint 120s, tsc 82s/);
});

test('missing roots and an empty job give an empty record, never a throw', () => {
  const t = collectTiming({ roots: ['/nonexistent/bro-7324'], t0Ms: T0 });
  assert.deepEqual(t, { v: 1, runs: {} });
  assert.match(summaryLines(t).join('\n'), /no gauntlet ran/);
});

test('emit writes one timing= line that round-trips as JSON, and exits 0 on bad input', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-'));
  outDir(root, 'branch', { finishedAt: '2026-11-21T12:20:00Z', wallMs: 1000, gates: ['tsc'], gateSecs: { tsc: 1 } });
  const gho = path.join(root, 'gh-output');
  execFileSync('node', [CLI, 'emit', `--t0=${T0}`, `--root=${root}`, `--github-output=${gho}`]);
  const line = fs.readFileSync(gho, 'utf8').trim();
  assert.match(line, /^timing=\{/);
  assert.equal(line.split('\n').length, 1);
  assert.equal(JSON.parse(line.slice('timing='.length)).runs[`${path.basename(root)}/branch`].gateSecs.tsc, 1);
  // unwritable output file: still exit 0
  execFileSync('node', [CLI, 'emit', `--t0=${T0}`, `--root=${root}`, '--github-output=/nonexistent/dir/x']);
});
