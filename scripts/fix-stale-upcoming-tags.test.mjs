import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox } from './lib/shows-sandbox.mjs';

const fixture = () => [
  { id: 'a', status: 'open', tags: ['Upcoming', 'musical'] },
  { id: 'b', status: 'previews', tags: ['upcoming'] },
  { id: 'c', status: 'upcoming', tags: ['upcoming'] },
  { id: 'd', status: 'open', tags: ['musical'] },
  // Padding: the shows.json shrink guard refuses a write that drops >5% of lines.
  ...Array.from({ length: 60 }, (_, i) => ({ id: `pad-${i}`, status: 'open', tags: ['musical'], title: `Pad ${i}` })),
];
const tags = (shows, id) => shows.find(s => s.id === id).tags;

test('dry run lists stale tags and writes nothing', () => {
  const r = runInSandbox('fix-stale-upcoming-tags.js', [], fixture());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /2 show\(s\) with stale 'upcoming' tag/);
  assert.match(r.stdout, /Dry run/);
  assert.deepEqual(r.after, fixture());
});

test('--apply drops the tag (case-insensitive) only where status moved past upcoming', () => {
  const r = runInSandbox('fix-stale-upcoming-tags.js', ['--apply'], fixture());
  assert.equal(r.status, 0);
  assert.deepEqual(tags(r.after, 'a'), ['musical']);
  assert.deepEqual(tags(r.after, 'b'), []);
  assert.deepEqual(tags(r.after, 'c'), ['upcoming'], 'a genuinely upcoming show keeps its tag');
  assert.deepEqual(tags(r.after, 'd'), ['musical']);
});

test('--show=ID scopes the fix to one show', () => {
  const dry = runInSandbox('fix-stale-upcoming-tags.js', ['--show=b'], fixture());
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /1 show\(s\) with stale 'upcoming' tag/);
  assert.doesNotMatch(dry.stdout, /- a \[/);
  assert.deepEqual(dry.after, fixture());

  const r = runInSandbox('fix-stale-upcoming-tags.js', ['--apply', '--show=b'], fixture());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Fixed 1 show\(s\)/);
  assert.deepEqual(tags(r.after, 'b'), []);
  // BRO-5271: shows-write-guard strips a stale tag on every save, so 'a' (open,
  // tagged 'Upcoming') cannot survive the write even though the fixer never
  // selected it. Scoping governs what the fixer selects and reports, above.
  assert.deepEqual(tags(r.after, 'a'), ['musical']);
  assert.deepEqual(tags(r.after, 'c'), ['upcoming']);
});

test('--check exits 1 when a stale tag remains and 0 when clean, never writing', () => {
  const dirty = runInSandbox('fix-stale-upcoming-tags.js', ['--check'], fixture());
  assert.equal(dirty.status, 1);
  assert.deepEqual(dirty.after, fixture());
  const clean = runInSandbox('fix-stale-upcoming-tags.js', ['--check'], fixture().filter(s => s.id !== 'a' && s.id !== 'b'));
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /No shows with a stale upcoming tag/);
});

test('--check with --apply is refused with exit 2', () => {
  const r = runInSandbox('fix-stale-upcoming-tags.js', ['--check', '--apply'], fixture());
  assert.equal(r.status, 2);
  assert.deepEqual(r.after, fixture());
});
