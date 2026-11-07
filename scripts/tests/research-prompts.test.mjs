// BRO-5570: the research-prompt generators build prompts from live data and splice
// them into the prompts page. Node's built-in runner: node --test scripts/tests/research-prompts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'research-prompts');
const root = path.join(here, '..', '..');
const { build, summarize } = require('../research-prompts/build.js');
const haveData = fs.existsSync(path.join(root, 'data/commercial.json')) && fs.existsSync(path.join(root, 'data/shows.json'));

test('summarize reports id and show count in order', () => {
  assert.deepEqual(summarize([{ id: 'p1', shows: [1, 2] }, { id: 'p2', shows: [] }]), [{ id: 'p1', shows: 2 }, { id: 'p2', shows: 0 }]);
});

test('ran-in.json names a tool list for every entry', () => {
  const ran = JSON.parse(fs.readFileSync(path.join(dir, 'ran-in.json'), 'utf8'));
  assert.ok(Object.keys(ran).length >= 11);
  for (const [id, v] of Object.entries(ran)) {
    assert.match(id, /^p\d+b?$/);
    assert.ok(typeof v.done === 'string' && v.done.length > 0, id);
    assert.ok(v.ran.every((t) => ['gemini', 'chatgpt'].includes(t)), id);
  }
});

test('sources carry no hard-coded machine paths or contact email', () => {
  for (const f of fs.readdirSync(dir).filter((n) => /\.(js|mts|py|json)$/.test(n))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(s, /\/root\/|\.claude\/worktrees|[\w.]+@[\w.]+\.\w{2,}/, f);
  }
});

test('splice.py drops asked-twice questions and groups prompts by tool', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'splice-'));
  const html = path.join(tmp, 'page.html');
  fs.writeFileSync(html, 'head\n  {"id": "p0", "old": true},\ntail');
  const show = (t, need) => [t, 'Venue', 'opened Jan 1, 2024', need, null];
  const season = [
    { id: 'p5', kind: 'commercial', title: 'S', why: 'w', shows: [show('A', ['capitalization', 'weekly running cost']), show('B', ['capitalization'])] },
    { id: 'p10', kind: 'commercial', title: 'O', why: 'w', shows: [show('C', ['capitalization'])] },
  ];
  const deep = [{ id: 'p13', kind: 'commercial', title: 'D', why: 'w', shows: [show('A', ['capitalization'])] }];
  fs.writeFileSync(path.join(tmp, 's.json'), JSON.stringify(season));
  fs.writeFileSync(path.join(tmp, 'd.json'), JSON.stringify(deep));
  const r = spawnSync('python3', ['-I', path.join(dir, 'splice.py'), html, path.join(tmp, 's.json'), path.join(tmp, 'd.json'), path.join(dir, 'ran-in.json')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const ids = fs.readFileSync(html, 'utf8').split('\n').filter((l) => l.startsWith('  {"id"')).map((l) => JSON.parse(l.replace(/,$/, '')));
  assert.deepEqual(ids.map((p) => [p.id, p.group]), [['p13', 'first'], ['p5', 'later'], ['p10', 'older']]);
  assert.deepEqual(ids[1].shows.find((s) => s[0] === 'A')[3], ['weekly running cost']);
  assert.deepEqual(ids[1].ran, ['gemini']);
  assert.equal(fs.readFileSync(html, 'utf8').startsWith('head\n'), true);
});

test('live build yields season and deep-dive prompts with shows', { skip: !haveData && 'no data/commercial.json here' }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  const { season, deep } = build({ work, out: null });
  const ids = [...deep, ...season].map((p) => p.id);
  const seasonIds = season.map((p) => p.id), ran = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'ran-in.json'), 'utf8')));
  for (const id of ran) assert.ok(seasonIds.includes(id), `ran-in id ${id} has no season prompt`);
  for (const id of ['p14', 'p15', 'p16', 'p5', 'p7']) assert.ok(ids.includes(id), id);
  for (const p of [...deep, ...season]) assert.ok(p.shows.length > 0 && p.title && p.why, p.id);
});

test('build refuses to splice without Form D files unless --no-formd', { skip: !haveData && 'no data/commercial.json here' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-refuse-'));
  const html = path.join(tmp, 'page.html');
  fs.writeFileSync(html, '  {"id": "p13", "x": 1},\n');
  const r = spawnSync('node', [path.join(dir, 'build.js'), '--out', html, '--work', tmp], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to splice/);
  assert.match(fs.readFileSync(html, 'utf8'), /p13/);
});
