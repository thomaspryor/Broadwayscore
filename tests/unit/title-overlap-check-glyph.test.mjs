/**
 * Gate P (exit-status-gate.sh) vs Gate W: they were mutually unsatisfiable for
 * every auto-dispatched workspace, and this suite pins the fix.
 *
 * titleMatchesSubject(title, subject) is asymmetric ON PURPOSE — it strips the
 * activity-glyph / auto-dispatch prefix from `title` (a raw cmux workspace
 * title) but not from `subject`, because every other caller passes a raw TASK
 * SUBJECT there, which never carries a glyph.
 *
 * Gate P is the one caller that passes a cmux TITLE as the subject: it reads the
 * title quoted in a DISPATCHED: line. Gate W separately requires that quoted
 * title to be the exact tab title, glyphs included, because that is what the
 * owner's sidebar shows. Result on 2026-08-17: two byte-identical strings
 * returned NOMATCH, so a truthful DISPATCHED: claim for any 🤖 workspace was
 * unreportable — Gate W demanded the glyph and Gate P rejected it.
 *
 * Run: node --test tests/unit/title-overlap-check-glyph.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO, 'scripts/lib/title-overlap-check.mjs');

/** @returns {{code:number, out:string}} */
function check(subject, ...titles) {
  try {
    const out = execFileSync('node', [CLI, subject, ...titles], { encoding: 'utf8' });
    return { code: 0, out: out.trim() };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '').trim() };
  }
}

// The exact live title from the 2026-08-17 incident.
const GLYPH = '🤖⚡ Infra·P1: nothing alarms when main has been red for hour';

test('title-overlap-check — a glyph-prefixed title matches ITSELF', () => {
  // The regression: this returned NOMATCH, blocking a truthful DISPATCHED: line.
  const r = check(GLYPH, GLYPH);
  assert.equal(r.out, 'MATCH');
  assert.equal(r.code, 0);
});

test('title-overlap-check — a glyph-prefixed claim matches the live title among several', () => {
  const r = check(GLYPH, '🤖⚡ Data·P1: something else entirely over here', GLYPH, 'idle tab');
  assert.equal(r.out, 'MATCH');
});

test('title-overlap-check — the raw-subject path still works (every other caller)', () => {
  // bsc-next.js / dispatch-guards.js pass a task subject with no glyph.
  const subject = 'nothing alarms when main has been red for hours';
  assert.equal(check(subject, `🤖⚡ Infra·${subject}`).out, 'MATCH');
  assert.equal(check(subject, subject).out, 'MATCH');
});

test('title-overlap-check — an UNRELATED live title is still NOMATCH (the gate keeps its teeth)', () => {
  const r = check('🤖⚡ Data·P1: totally unrelated workspace title here', GLYPH);
  assert.equal(r.out, 'NOMATCH');
  assert.equal(r.code, 1);
});

test('title-overlap-check — a fabricated claim against zero real overlap is NOMATCH', () => {
  // The incident this gate exists for: a DISPATCHED: line with no workspace.
  assert.equal(check('🤖⚡ Infra·P1: a card nobody ever launched a tab for', 'some other tab').out, 'NOMATCH');
});

test('title-overlap-check — the <20-char bar is preserved, glyph or not', () => {
  // Short titles must not match on a few incidental characters.
  assert.equal(check('🤖⚡ Data·ab', '🤖⚡ Data·ab').out, 'NOMATCH');
});

test('title-overlap-check — a missing argument still exits 2, never 1', () => {
  // Exit 2 means "the checker could not answer" and Gate P degrades to skip;
  // collapsing it into 1 would turn an environment fault into a false block.
  const r = check(GLYPH);
  assert.equal(r.code, 2);
  assert.match(r.out, /^ERROR:/);
});
