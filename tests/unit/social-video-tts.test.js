// BRO-7414: voice step helpers. Real functions, fixture shaped like OpenAI whisper-1 verbose_json.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../scripts/video-proto/tts');

test('splitDirections strips [tags] from the spoken text and maps them to a delivery instruction', () => {
  const r = T.splitDirections('[excited] Hamilton just opened. [dryly] Critics agree.');
  assert.equal(r.text, 'Hamilton just opened. Critics agree.');
  assert.match(r.style, /excitement/);
  assert.match(r.style, /dryly/);
});

test('splitDirections ignores unknown tags and keeps plain text', () => {
  const r = T.splitDirections('Plain line [whispers]');
  assert.equal(r.text, 'Plain line');
  assert.ok(!/undefined/.test(r.style));
});

test('wordsFromWhisper maps to the words.json shape render.js reads', () => {
  const r = T.wordsFromWhisper({ text: ' Hello world ', words: [{ word: ' Hello', start: 0.1, end: 0.4 }, { word: 'world', start: 0.5, end: 0.9 }] });
  assert.deepEqual(r, { text: 'Hello world', words: [{ word: 'Hello', start: 0.1, end: 0.4 }, { word: 'world', start: 0.5, end: 0.9 }] });
});

test('wordsFromWhisper repairs a stray bad token instead of failing the video', () => {
  const r = T.wordsFromWhisper({ words: [{ word: 'a', start: 0, end: 0.4 }, { word: 'b', start: 1, end: 0.5 }, { word: ' ', start: 1, end: 2 }, { word: 'c', start: NaN, end: 3 }, { word: 'd', start: 2, end: 2.5 }] });
  assert.deepEqual(r.words.map(w => w.word), ['a', 'b', 'd']);
  assert.equal(r.words[1].end, 1); // reversed end clamped to start
});

test('wordsFromWhisper still rejects empty or mostly unusable timings', () => {
  assert.throws(() => T.wordsFromWhisper({ words: [] }), /no word timings/);
  assert.throws(() => T.wordsFromWhisper(null), /no word timings/);
  assert.throws(() => T.wordsFromWhisper({ words: [{ word: '', start: 0, end: 1 }, { word: 'a', start: 'x', end: 1 }, { word: 'b', start: 0, end: 1 }] }), /malformed/);
});

test('voice without OPENAI_API_KEY fails before any file is written', async () => {
  const keep = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'tts-'));
  try { await assert.rejects(T.voice({ prompt: 'hi' }, dir, 'x'), /OPENAI_API_KEY/); assert.equal(require('fs').existsSync(dir + '/x.mp3'), false); }
  finally { if (keep) process.env.OPENAI_API_KEY = keep; }
});
