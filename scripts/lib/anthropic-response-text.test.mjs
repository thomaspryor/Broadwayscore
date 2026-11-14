// BRO-4665: advisor-tool responses carry several text blocks; read the final answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { finalResponseText, describeResponse, firstJsonObject } = require('./anthropic-response-text.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const tool = [
  { type: 'server_tool_use', id: 'x', name: 'advisor', input: {} },
  { type: 'advisor_tool_result', tool_use_id: 'x', content: {} },
];

test('preamble, advisor call, answer: returns only the answer', () => {
  const content = [{ type: 'text', text: "I'll analyze each transcript carefully before classifying." }, ...tool,
    { type: 'text', text: '[{"index": 1, "type": "review"}]' }];
  assert.equal(finalResponseText(content), '[{"index": 1, "type": "review"}]');
  // A bare JSON object answer (classify-non-reviews) parses directly.
  const obj = [{ type: 'text', text: 'Let me check.' }, ...tool, { type: 'text', text: '{"verdict":"review","confidence":"high"}' }];
  assert.deepEqual(JSON.parse(finalResponseText(obj)), { verdict: 'review', confidence: 'high' });
});

test('a draft written before the advisor call is not returned', () => {
  const content = [{ type: 'text', text: '[{"index": 1, "type": "other"}]' }, ...tool,
    { type: 'text', text: 'Revised:' }, { type: 'text', text: '[{"index": 1, "type": "review"}]' }];
  assert.equal(finalResponseText(content), 'Revised:\n[{"index": 1, "type": "review"}]');
});

test('no tool blocks: all text; odd content: empty string', () => {
  assert.equal(finalResponseText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(finalResponseText(undefined), '');
  // Answer before the advisor call with nothing after it: fall back to the last text block.
  assert.equal(finalResponseText([{ type: 'text', text: 'pre' }, ...tool]), 'pre');
  assert.equal(finalResponseText([...tool]), '');
  // Blank trailing blocks do not hide the answer.
  assert.equal(finalResponseText([{ type: 'text', text: '[{"a":1}]' }, ...tool, { type: 'text', text: '\n' }]), '[{"a":1}]');
});

test('describeResponse names stop_reason and block types', () => {
  assert.equal(describeResponse({ stop_reason: 'max_tokens', content: [{ type: 'text' }, ...tool] }),
    'stop_reason=max_tokens blocks=[text,server_tool_use,advisor_tool_result]');
  assert.equal(describeResponse(null), 'stop_reason=unknown blocks=[none]');
});

test('firstJsonObject pulls the object out of prose and fences', () => {
  const tail = 'Revised:\n```json\n{"isReview":true,"contentType":"review","confidence":"high","reasoning":"a {b} \\"c\\""}\n```';
  assert.deepEqual(JSON.parse(firstJsonObject(tail)), { isReview: true, contentType: 'review', confidence: 'high', reasoning: 'a {b} "c"' });
  // A non-JSON brace earlier in the prose is skipped.
  assert.equal(firstJsonObject('use {x} then {"a":1}'), '{"a":1}');
  assert.equal(firstJsonObject('{"a":1'), null);
  assert.equal(firstJsonObject(undefined), null);
});

// Guard: a script that enables the advisor tool must not read only the first text block.
const FIRST_TEXT = /\.(?:find\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\??\.type\s*===?\s*['"]text['"]\s*\)|filter\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\??\.type\s*===?\s*['"]text['"]\s*\)\s*\[0\])|\bcontent\??\.?\[0\]\??\.text\b/;

test('guard regex matches the common spellings', () => {
  for (const s of ["data.content.find(c => c.type === 'text')", 'json.content?.find((c) => c.type === "text")', "(m.content || []).find(b => b?.type === 'text')",
    "content.find(c => c.type == 'text')", 'content.filter(c => c.type === "text")[0].text',
    'json.content[0].text', 'data.content?.[0]?.text']) {
    assert.match(s, FIRST_TEXT, s);
  }
});

test('no advisor-tool script reads only the first text block', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c?js|mjs|ts)$/.test(e.name) && !e.name.includes('.test.') && e.name !== 'anthropic-response-text.js') {
        const src = fs.readFileSync(p, 'utf8');
        if (/advisor_20\d{6}/.test(src) && FIRST_TEXT.test(src)) offenders.push(path.relative(ROOT, p));
      }
    }
  };
  walk(path.join(ROOT, 'scripts'));
  assert.deepEqual(offenders, [], `use finalResponseText() from scripts/lib/anthropic-response-text.js in: ${offenders.join(', ')}`);
});
