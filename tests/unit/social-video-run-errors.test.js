// BRO-7418 + BRO-7909: a failed child step reports its real Error line, and Whisper's by-ear
// outlet spellings still get a cue (the-heart: "Theatrely" heard as "Theaterly" failed render.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../../scripts/social-autopost/video-run');
const { fuzzyFind, skeleton } = require('../../scripts/video-proto/cue-match');

test('run() surfaces the Error: line, not just the stack tail', () => {
  assert.throws(() => run('node', ['-e', "function f(){throw new Error('the voiceover never says X')} function g(){f()} function h(){g()} function i(){h()} function j(){i()} j()"], { cwd: process.cwd() }),
    /Error: the voiceover never says X/);
});

test('fuzzyFind matches Whisper spellings of an outlet name', () => {
  const tk = [{ k: 'but', a: 15 }, { k: 'theaterly', a: 15.6 }, { k: 'said', a: 16 }];
  assert.equal(fuzzyFind(tk, 'theatrely', 0), 1);
  assert.equal(fuzzyFind(tk, 'theatrely', 16), -1); // never before `start`
  assert.equal(skeleton('theatrely'), skeleton('theaterly'));
});

test('fuzzyFind does not match unrelated words', () => {
  const tk = [{ k: 'thoroughly', a: 1 }, { k: 'times', a: 2 }, { k: 'post', a: 3 }];
  assert.equal(fuzzyFind(tk, 'theatrely', 0), -1);
  assert.equal(fuzzyFind(tk, 'timeout', 0), -1);
  assert.equal(fuzzyFind(tk, 'times', 0), 1); // exact stem still works
});

test('quoteCue falls back to the spoken excerpt when the outlet name is misheard (unattended only)', () => {
  const { quoteCue } = require('../../scripts/video-proto/cue-match');
  let cur = 10;
  const V = { cur: () => cur, at: p => { if (p === 'Cititour') throw new Error('never says'); cur = 20; return 20; } };
  const q = { say: 'Cititour', ex: 'A sweet love letter' };
  process.env.VO_FUZZY_CUES = '1';
  assert.equal(quoteCue(V, q, x => x), 19);
  process.env.VO_FUZZY_CUES = '0';
  assert.throws(() => quoteCue(V, q, x => x), /never says/);
  delete process.env.VO_FUZZY_CUES;
});
