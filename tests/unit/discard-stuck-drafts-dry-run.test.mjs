/**
 * BRO-7580 (cousin of recreate-draft-flow.test.mjs): scripts/discard-stuck-broadcast-drafts.js
 * deletes a Resend draft only with --execute. Nothing pinned that default.
 * These run the REAL script as a subprocess in a temp cwd (it reads
 * data/opening-night-sent.json from cwd) with no RESEND_API_KEY, GH_TOKEN or
 * GITHUB_ACTIONS, so no Resend or GitHub call can be made.
 *
 * Green means: a run without --execute leaves the tracker untouched, and
 * --execute without a key refuses. It does not mean the delete itself works.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(new URL('../../scripts/discard-stuck-broadcast-drafts.js', import.meta.url).pathname);
const SHOW = 'some-show-2026';
const KEY = `broadway:${SHOW}`;
const draftRec = { draftId: 'draft-abc', completed: true, draftStatus: 'draft', sentAt: null, broadcastKey: KEY };

function setup(tracker) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'discard-dry-'));
  mkdirSync(path.join(cwd, 'data'));
  const file = path.join(cwd, 'data', 'opening-night-sent.json');
  writeFileSync(file, JSON.stringify({ shows: tracker }, null, 2) + '\n');
  return { cwd, file, before: readFileSync(file, 'utf8') };
}
function run(cwd, args) {
  const env = { PATH: process.env.PATH, HOME: cwd };
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

test('no --execute: reports a dry run, exits 0, tracker file byte-identical', () => {
  const { cwd, file, before } = setup({ [KEY]: draftRec, [SHOW]: draftRec });
  try {
    const r = run(cwd, [`--show=${SHOW}`]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Drafts: draft-abc/, 'must have reached the draft lookup (not vacuous)');
    assert.match(r.out, /\[DRY RUN\] Would delete 1 draft\(s\)/);
    assert.equal(readFileSync(file, 'utf8'), before, 'dry run must not touch the tracker');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('--execute without RESEND_API_KEY is refused before any delete, tracker untouched', () => {
  const { cwd, file, before } = setup({ [KEY]: draftRec, [SHOW]: draftRec });
  try {
    const r = run(cwd, [`--show=${SHOW}`, '--execute']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /REFUSED: RESEND_API_KEY not set/);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('tracker says already sent: refused even as a dry run', () => {
  const sent = { ...draftRec, draftStatus: 'sent', sentAt: '2026-11-01T00:00:00Z' };
  const { cwd, file, before } = setup({ [KEY]: sent, [SHOW]: sent });
  try {
    const r = run(cwd, [`--show=${SHOW}`]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /already sent/);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('only the market record says sent (per-show copy still says draft): still refused', () => {
  const sent = { ...draftRec, draftStatus: 'sent', sentAt: '2026-11-01T00:00:00Z' };
  const { cwd, file, before } = setup({ [KEY]: sent, [SHOW]: { ...draftRec } });
  try {
    const r = run(cwd, [`--show=${SHOW}`]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /already sent/);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
