// BRO-8455 items 3, 5, 6: replay the audit's cases against the real emit decision functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { emitDecision, typeForTitle } = require('./city-finder-emit.js');
const { FINDERS } = require('./city-finder-config.js');

const today = '2026-11-28';
const rev = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://x.test/${i}` }));

test('item 5: pro:false companies are never emitted (OnStage, Scripps Ranch, OnWord, Sullivan Rep)', () => {
  for (const t of ['OnStage Playhouse', 'Scripps Ranch Theatre', 'OnWord Theatre', 'Oceanside Theatre Company', 'Sullivan Rep']) {
    const cfg = [...FINDERS['san-diego'].theatres, ...FINDERS.boston.theatres].find((x) => x.name === t);
    assert.equal(cfg.pro, false, t);
    assert.equal(emitDecision({ title: 'Anything', pro: cfg.pro, start: '2026-10-01', end: '2026-10-20', reviews: rev(5) }, { today }).emit, false, t);
  }
});
test('item 5: a one-night variety night is not a production (ted talks and talks)', () => {
  assert.equal(emitDecision({ title: 'TED Talks and Talks', pro: true, start: '2026-11-16', end: '2026-11-17', reviews: rev(4) }, { today }).emit, false);
});
test('item 3: a professional production with 1 review is emitted (unscored), 0 reviews is not', () => {
  assert.equal(emitDecision({ title: 'JOB', pro: true, start: '2026-10-07', end: '2026-11-01', reviews: rev(1) }, { today }).emit, true);
  assert.equal(emitDecision({ title: 'JOB', pro: true, start: '2026-10-07', end: '2026-11-01', reviews: [] }, { today }).emit, false);
});
test('item 6: Boston musicals type musical, plays and look-alikes stay play', () => {
  for (const t of ['Something Rotten!', 'Annie', 'On Your Feet! The Story of Emilio and Gloria Estefan', "Joseph and the Amazing Technicolor Dreamcoat", 'Merrily We Roll Along', 'Frozen', 'Jagged Little Pill', 'Finding Nemo']) assert.equal(typeForTitle(t), 'musical', t);
  for (const t of ['Betrayal', 'To Kill a Mockingbird', "Annie Baker's The Antipodes", 'Dracula: A Comedy of Terrors']) assert.equal(typeForTitle(t), 'play', t);
});
test('class guard: city-finder-stage emit uses the shared decision functions, not inline copies', () => {
  const src = readFileSync(new URL('../city-finder-stage.js', import.meta.url), 'utf8');
  assert.match(src, /emitDecision\(p, \{ min, today \}\)/);
  assert.match(src, /typeForTitle\(p\.title\)/);
  assert.doesNotMatch(src, /type: \/\\b\(musical\|rent/);
});

test('item 3: Boston allowlist carries the audit-found theatres (Gloucester Stage, Wheelock, Merrimack)', () => {
  const names = FINDERS.boston.theatres.map((t) => t.name);
  for (const n of ['Gloucester Stage Company', 'Wheelock Family Theatre', 'Merrimack Repertory Theatre']) assert.ok(names.includes(n), n);
});
test('item 3: city-season-sync no longer drops a production for missing art (class guard)', () => {
  const src = readFileSync(new URL('../city-season-sync.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /no real image`\); continue/);
  assert.match(src, /added without art/);
});
