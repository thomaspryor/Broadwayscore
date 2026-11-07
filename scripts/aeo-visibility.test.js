const assert = require('assert');
const lib = require('./lib/aeo-visibility');

// analyzeAnswer: mention, position, cite, description
let a = lib.analyzeAnswer('Try Show Score first.\nBroadway Scorecard aggregates critic reviews into one score. Also Playbill.', [
  { url: 'https://broadwayscorecard.com/show/hamilton?utm_source=openai' }, { url: 'https://www.nytimes.com/x' }]);
assert.strictEqual(a.mentioned, true); assert.strictEqual(a.cited, true);
assert.strictEqual(a.position, 2);
assert.deepStrictEqual(a.competitors, ['Show Score', 'Playbill']);
assert.ok(a.description.startsWith('Broadway Scorecard aggregates'));
assert.deepStrictEqual(a.ourUrls, ['https://broadwayscorecard.com/show/hamilton']);
assert.strictEqual(a.citedDomains['nytimes.com'], 1);
// inline citation links are not prose mentions; 'show scored' is not Show Score
a = lib.analyzeAnswer('See ([broadwayscorecard.com](https://broadwayscorecard.com/x?utm_source=openai)) and https://show-score.com/a. The show scored well.', []);
assert.strictEqual(a.mentionedInText, false); assert.deepStrictEqual(a.competitors, []);
a = lib.analyzeAnswer('x', [{ url: 'https://broadwayscorecard.com/p?utm_source=openai&a=1' }]);
assert.deepStrictEqual(a.ourUrls, ['https://broadwayscorecard.com/p?a=1']);
a = lib.analyzeAnswer('y'.repeat(500) + ' Broadway Scorecard is an aggregator.', []);
assert.ok(a.description.includes('Broadway Scorecard'));

// absent
a = lib.analyzeAnswer('Use TodayTix or BroadwayWorld.', [{ url: 'https://broadwayworld.com/a' }]);
assert.strictEqual(a.mentioned, false); assert.strictEqual(a.position, null);
// lookalike domain must not count as ours
a = lib.analyzeAnswer('x', [{ url: 'https://notbroadwayscorecard.com/a' }]);
assert.strictEqual(a.cited, false);
// cited without text mention still counts as mentioned
a = lib.analyzeAnswer('Hamilton rocks.', [{ url: 'https://broadwayscorecard.com/show/hamilton' }]);
assert.strictEqual(a.mentioned, true); assert.strictEqual(a.mentionedInText, false);

// cost
assert.ok(Math.abs(lib.costOf('openai', { input: 10000, output: 1000, searches: 3 }) - (0.0025 + 0.002 + 0.03)) < 1e-9);
assert.ok(Math.abs(lib.costOf('gemini', { input: 1000, output: 1000, searches: 1 }) - (0.0003 + 0.0025 + 0.035)) < 1e-9);

(async () => {
  const oa = await lib.runOpenAI('q', { apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
    output: [{ type: 'web_search_call', action: { sources: [{ url: 'https://playbill.com/a' }] } },
      { type: 'message', content: [{ type: 'output_text', text: 'Broadway Scorecard', annotations: [{ type: 'url_citation', url: 'https://broadwayscorecard.com/', title: 't' }] }] }],
    usage: { input_tokens: 5, output_tokens: 6 } }) }) });
  assert.strictEqual(oa.citations.length, 2); assert.strictEqual(oa.usage.searches, 1);
  const ge = await lib.runGemini('q', { apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
    candidates: [{ content: { parts: [{ text: 'hi' }] }, groundingMetadata: { webSearchQueries: ['a'], groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/x', title: 'broadwayscorecard.com' } }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } }) }) });
  assert.strictEqual(lib.analyzeAnswer(ge.text, ge.citations).cited, true);
  await assert.rejects(lib.runOpenAI('q', { apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'bad' } }) }) }));
  const s = lib.summarize([
    { engine: 'openai', mentioned: true, cited: false, position: 2, competitors: ['Playbill'], ourUrls: [], citedDomains: {}, cost: 0.1 },
    { engine: 'openai', mentioned: false, cited: false, position: null, competitors: [], ourUrls: [], citedDomains: {}, cost: 0.1 },
    { engine: 'openai', error: 'x' }]);
  assert.strictEqual(s.openai.runs, 2); assert.strictEqual(s.openai.mentionRate, 0.5); assert.strictEqual(s.all.avgPosition, 2);
  console.log('aeo-visibility tests passed');
})().catch(e => { console.error(e); process.exit(1); });
