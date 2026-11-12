// Automatic voiceover (BRO-7414): a plan's `prompt` -> <name>.mp3 + <name>.words.json, the two files render.js reads from VO_DIR.
// The manual prototype used an ElevenLabs connector, which has no API key in CI. Here: OpenAI gpt-4o-mini-tts for the voice and
// whisper-1 word timestamps for the timings. About 25 s of audio per video: roughly 0.5 US cents of TTS plus 0.3 of Whisper.
// Bracketed voice directions in a script ("[excited]", "[dryly]") are not spoken: they become the delivery instruction.
const fs = require('fs'), path = require('path');

const TTS_MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.TTS_VOICE || 'coral';
const STT_MODEL = 'whisper-1';
const BASE_STYLE = 'Warm, upbeat entertainment-news presenter. Natural pace, clear diction, speak numbers and scores plainly. No sound effects.';
const MOODS = { excited: 'Lead with real excitement.', curious: 'Sound curious and inviting.', dryly: 'Say this part dryly, with a hint of humor.' };

/** {text, style}: the spoken text with the [tags] removed, and the delivery instruction they asked for. */
function splitDirections(prompt) {
  const tags = [...String(prompt).matchAll(/\[([a-z ]+)\]/gi)].map(m => m[1].toLowerCase().trim());
  const text = String(prompt).replace(/\[[a-z ]+\]/gi, ' ').replace(/\s{2,}/g, ' ').trim();
  const moods = [...new Set(tags)].map(t => MOODS[t]).filter(Boolean);
  return { text, style: [BASE_STYLE, ...moods].join(' ') };
}

/** whisper-1 verbose_json -> the words.json shape render.js reads: {text, words:[{word,start,end}]}. */
function wordsFromWhisper(j) {
  if (!j || !Array.isArray(j.words) || !j.words.length) throw new Error('whisper returned no word timings');
  const words = j.words.map(w => ({ word: String(w.word).trim(), start: +w.start, end: +w.end }));
  if (words.some(w => !w.word || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end < w.start)) throw new Error('whisper returned malformed word timings');
  return { text: String(j.text || words.map(w => w.word).join(' ')).trim(), words };
}

async function openai(pathname, init, what) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error(`${what}: OPENAI_API_KEY is not set`);
  const res = await fetch('https://api.openai.com/v1/' + pathname, { ...init, headers: { Authorization: 'Bearer ' + key, ...(init.headers || {}) }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

/** Writes <outDir>/<name>.mp3 and <name>.words.json for plan.prompt. Returns {mp3, words, seconds}. */
async function voice(plan, outDir, name) {
  const { text, style } = splitDirections(plan.prompt);
  fs.mkdirSync(outDir, { recursive: true });
  const mp3 = path.join(outDir, name + '.mp3');
  const sp = await openai('audio/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, instructions: style, response_format: 'mp3' }) }, 'text-to-speech');
  fs.writeFileSync(mp3, Buffer.from(await sp.arrayBuffer()));
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(mp3)], { type: 'audio/mpeg' }), name + '.mp3');
  form.append('model', STT_MODEL); form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'word'); form.append('language', 'en');
  const tr = wordsFromWhisper(await (await openai('audio/transcriptions', { method: 'POST', body: form }, 'whisper')).json());
  const words = path.join(outDir, name + '.words.json');
  fs.writeFileSync(words, JSON.stringify(tr, null, 1));
  return { mp3, words, seconds: tr.words[tr.words.length - 1].end };
}

module.exports = { voice, splitDirections, wordsFromWhisper, TTS_MODEL, TTS_VOICE };

if (require.main === module) {
  const [planFile, outDir, name] = process.argv.slice(2);
  if (!planFile || !outDir) { console.error('usage: node tts.js <plan.json> <outDir> [name]'); process.exit(2); }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  voice(plan, outDir, name || path.basename(planFile).replace(/\.plan\.json$/, '')).then(r => console.log(JSON.stringify(r)), e => { console.error(e.message); process.exit(1); });
}
