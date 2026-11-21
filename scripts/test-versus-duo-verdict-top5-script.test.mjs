// BRO-6449: the open-question framing rule (BRO-6417, owner 2026-10-27) holds for verdict, reveal, every, top5, duo and versus,
// not just compare. Generators are run for real on live show data; the checker is the one render.js uses.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const HAVE_DATA = fs.existsSync(new URL('../data/shows.json', import.meta.url)); // gitignored; absent on Dependabot and bare checkouts

const require = createRequire(import.meta.url);
const { checkFraming, assertFraming, LEGACY } = require('./video-proto/script-rules.js');
// Poster art is gitignored (not in CI), and topList refuses a list without it; the list itself is real data, the art check is skipped.
const sd = require('./video-proto/showdata.js'), realTopList = sd.topList;
sd.topList = (key) => { try { return realTopList(key); } catch (e) {
  if (!/no key art/.test(e.message)) throw e;
  const all = JSON.parse(fs.readFileSync(new URL('../data/shows.json', import.meta.url), 'utf8')); const list = all.shows || all;
  const ids = list.filter(x => x.category === 'broadway' && ['musical', 'play'].includes(x.type) && x.openingDate).map(x => { try { return { id: x.id, cs: sd.slim(x.id).cs }; } catch (_) { return null; } })
    .filter(x => x && x.cs != null).sort((a, b) => b.cs - a.cs).slice(0, 5).map(x => x.id);
  return { title: 'Top 5 on Broadway right now', sub: 'test', endLine: 'See every score on Broadway Scorecard.', ids }; } };
const vo = require('./video-proto/voscript.js');

// long quotes normally go to a model for an excerpt; here the first ten words stand in (still a verbatim span)
const cache = new Proxy({}, { get: (t, q) => (typeof q === 'string' ? q.trim().split(/\s+/).slice(0, 10).join(' ') : undefined), set: () => true });
const SHOW = process.env.FRAMING_TEST_SHOW || 'maybe-happy-ending-2024';
const gen = async (fmt, key) => { vo.setHistory({}); return vo.plan(fmt, key, cache); };

for (const fmt of ['verdict', 'reveal', 'every']) {
  test(`${fmt} generator ends on an open question in voice and caption`, { skip: !HAVE_DATA && 'no core data here' }, async () => {
    const p = await gen(fmt, SHOW);
    assert.deepStrictEqual(checkFraming(p), []);
    assert(/\?$/.test(p.prompt.trim()), p.prompt.slice(-80));
    assert(/\?/.test(p.caption), 'caption asks it too');
    assert(p.prompt.indexOf('Broadway Scorecard') < p.prompt.lastIndexOf('?'), 'question comes after the sign-off');
  });
}
test('top5 generator ends on an open question in voice and caption', { skip: !HAVE_DATA && 'no core data here' }, async () => {
  const p = await gen('top5', 'now');
  assert.deepStrictEqual(checkFraming(p), []);
  assert(/\?$/.test(p.prompt.trim()));
});
test('every wording rotation always passes the rule', { skip: !HAVE_DATA && 'no core data here' }, async () => {
  try { for (const salt of ['a', 'b', 'c', 'd', 'e', 'f']) { process.env.VO_SALT = salt; for (const fmt of ['verdict', 'reveal', 'every']) assert.deepStrictEqual(checkFraming(await gen(fmt, SHOW)), [], `${fmt} ${salt}`); } }
  finally { delete process.env.VO_SALT; }
});
test('spoken score words and captioned digits count as the same question', { skip: !HAVE_DATA && 'no core data here' }, async () => {
  const p = await gen('reveal', SHOW);
  const q = { fmt: 'reveal', key: 'x', prompt: 'Great. Is eighty-six fair?', caption: 'Hi.\n\nIs 86 fair?' };
  assert.deepStrictEqual(checkFraming(q), []);
  assert(p.caption.length > 0);
});

test('a flat sign-off ending is refused for every ruled format', () => {
  for (const fmt of ['verdict', 'reveal', 'every', 'top5', 'duo', 'versus']) {
    const p = checkFraming({ fmt, key: 'x', prompt: 'Can you guess which? Here they are. Every review is on Broadway Scorecard.', caption: 'Did you guess right?' });
    assert(p.some(m => /end on an open question/.test(m)), fmt);
  }
});
test('the caption must ask the same question the voice does', () => {
  assert(checkFraming({ fmt: 'verdict', key: 'x', prompt: 'Done. Fair score, or way off?', caption: 'Done. Read them all.' }).some(m => /caption must ask/.test(m)));
  assert(checkFraming({ fmt: 'verdict', key: 'x', prompt: 'Done. Fair score, or way off?', caption: 'Other words? Nope.' }).some(m => /caption must ask/.test(m)));
});
test('duo and versus must also open on the puzzle', () => {
  const flat = { prompt: 'Two big shows. They scored differently. Here they are. Which did you like?', caption: 'x\n\nWhich did you like?' };
  for (const fmt of ['duo', 'versus']) assert(checkFraming({ fmt, key: 'x', ...flat }).some(m => /open on the puzzle/.test(m)), fmt);
  assert.deepStrictEqual(checkFraming({ fmt: 'duo', key: 'x', prompt: 'Critics loved one and shrugged at the other. Can you guess which? Here they are. Did you guess right?', caption: 'Did you guess right?' }), []);
  assert.deepStrictEqual(checkFraming({ fmt: 'verdict', key: 'x', ...flat }), [], 'verdict needs only the closing question');
});
test('versus transcripts (no caption) are checked on the voice alone', () => {
  assert.deepStrictEqual(checkFraming({ fmt: 'versus', key: 'versus', prompt: 'Critics versus audiences. Who is right? Scores follow. Do you side with critics?' }, { needCaption: false }), []);
  assert.throws(() => assertFraming({ fmt: 'versus', key: 'versus', prompt: 'Who is right? Scores follow.' }, { needCaption: false }), /script framing rule/);
});
test('compare and how keep their own rules and are not checked here', () => {
  assert.deepStrictEqual(checkFraming({ fmt: 'compare', key: 'x', prompt: 'Flat.', caption: 'Flat.' }), []);
  assert.deepStrictEqual(checkFraming({ fmt: 'how', key: 'x', prompt: 'Flat.', caption: 'Flat.' }), []);
});
test('every checked-in duo/verdict/top5 plan passes or is a named legacy plan', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'video-proto', 'plans');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.plan.json'))) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.deepStrictEqual(checkFraming(p), [], `${f} breaks the framing rule; script it with a closing question (or, only if already published, add ${p.fmt}:${p.key} to LEGACY)`);
  }
  for (const k of LEGACY) assert(fs.existsSync(path.join(dir, k.split(':')[1] + '.plan.json')), `LEGACY entry ${k} has no plan file: remove it`);
});
test('render.js wires the rule in before any render', () => {
  const src = fs.readFileSync(new URL('./video-proto/render.js', import.meta.url), 'utf8');
  assert(/assertFraming\(V\.plan\)/.test(src)); assert(/assertFraming\(\{ fmt: 'versus'/.test(src));
});
test('a quoted sentence does not hide text and a quoted question still ends the script', () => {
  assert.deepStrictEqual(checkFraming({ fmt: 'duo', key: 'x', prompt: 'NYT said, "It soars." Then more. Who wins? Did you guess "right?"', caption: 'Did you guess "right?"' }), []);
});
test('a copy-review rewrite that drops the closing question is rejected', { skip: !HAVE_DATA && 'no core data here' }, async () => {
  const cr = require('./video-proto/copyreview.js'); const p = await gen('every', SHOW);
  assert(cr.keepsFacts(p, 'caption', p.caption) === null, 'original passes');
  const dropped = p.caption.replace(/\n\n[^\n]*\?\n\n/, '\n\n');
  assert(cr.keepsFacts(p, 'caption', dropped) !== null, 'caption keep list now includes the question');
});
test('every closing-question line in every rotation is a question, so any pick passes the rule', () => {
  for (const slot of ['askVerdict', 'askReveal', 'askEvery', 'askTop5']) for (const l of vo.LINES[slot])
    assert(/\?$/.test(l), `${slot}: "${l}" must end on a question mark`);
});
