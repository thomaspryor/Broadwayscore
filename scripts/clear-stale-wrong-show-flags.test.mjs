/**
 * Tests for scripts/clear-stale-wrong-show-flags.js (BRO-2432).
 *
 * Bug: with --llm, a total LLM outage (API down, key unset/revoked) counted
 * every errored call as a "rejection", so the sweep printed "Would clear: 0"
 * and exited 0, which an unattended weekly run reads as a clean no-op. Fix:
 * exit 1 with a ::error:: when every candidate errored (same as the
 * wrongProduction sibling, card #1917). Runs the real CLI against a fixture
 * dir (CLAUDE.md §15). No network: ANTHROPIC_API_KEY is unset, so every
 * llmVerify() call throws before fetch.
 *
 * Run: node --test scripts/clear-stale-wrong-show-flags.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'clear-stale-wrong-show-flags.js');

const SHOW = { id: 'test-musical-2026', title: 'Test Musical', openingDate: '2026-03-01' };
const REVIEW = {
  wrongShow: true,
  rejectionReason: 'wrong_show',
  url: 'https://example.com/2026/03/test-musical-review',
  criticName: 'A Critic',
  outlet: 'Example',
  fullText: 'Test Musical is a thoroughly staged evening of theater. '.repeat(40),
};

function makeFixture(reviews) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-stale-wrong-show-'));
  const dir = path.join(root, 'review-texts');
  fs.mkdirSync(path.join(dir, SHOW.id), { recursive: true });
  reviews.forEach((r, i) => fs.writeFileSync(path.join(dir, SHOW.id, `r${i}.json`), JSON.stringify(r)));
  const shows = path.join(root, 'shows.json');
  fs.writeFileSync(shows, JSON.stringify({ shows: [SHOW] }));
  return { root, dir, shows };
}

function run(fx, extra) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return spawnSync('node', [SCRIPT, `--dir=${fx.dir}`, `--shows=${fx.shows}`, ...extra], { env, encoding: 'utf8', timeout: 60000 });
}

test('--llm with every call erroring (no API key) exits 1 and does not write', () => {
  const fx = makeFixture([REVIEW]);
  try {
    const r = run(fx, ['--llm', '--apply']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /::error::All 1 LLM verification call\(s\) errored/);
    const after = JSON.parse(fs.readFileSync(path.join(fx.dir, SHOW.id, 'r0.json'), 'utf8'));
    assert.equal(after.wrongShow, true, 'flag must stay set on outage');
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('--llm dry-run (no --apply) also fails loud on total outage', () => {
  const fx = makeFixture([REVIEW]);
  try {
    assert.equal(run(fx, ['--llm']).status, 1);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('--llm with zero candidates still exits 0 (legitimate empty result)', () => {
  const fx = makeFixture([{ ...REVIEW, wrongShow: false }]);
  try {
    const r = run(fx, ['--llm', '--apply']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Would clear: 0/);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('predicate-only mode (no --llm) is unaffected by the outage guard', () => {
  const fx = makeFixture([REVIEW]);
  try {
    const r = run(fx, []);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Would clear: 1/);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});
