// BRO-4665: advisor-tool responses carry several text blocks; read them all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { responseText } = require('./anthropic-response-text.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('joins every text block so the answer after an advisor call is kept', () => {
  const content = [
    { type: 'text', text: "I'll analyze each transcript carefully before classifying." },
    { type: 'server_tool_use', id: 'x', name: 'advisor', input: {} },
    { type: 'advisor_tool_result', tool_use_id: 'x', content: {} },
    { type: 'text', text: '[{"index": 1, "type": "review"}]' },
  ];
  const text = responseText(content);
  assert.match(text, /^I'll analyze/);
  assert.match(text, /\[\{"index": 1, "type": "review"\}\]$/);
});

test('missing or odd content yields an empty string', () => {
  assert.equal(responseText(undefined), '');
  assert.equal(responseText([{ type: 'tool_use' }, null, { type: 'text' }]), '');
});

// Guard: a script that enables the advisor tool must not read only the first text block.
test('no advisor-tool script reads only the first text block', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c?js|mjs|ts)$/.test(e.name) && !e.name.includes('.test.') && e.name !== 'anthropic-response-text.js') {
        const src = fs.readFileSync(p, 'utf8');
        if (src.includes('advisor_20260301') && /content\??\.find\(\s*\w+\s*=>\s*\w+\.type\s*===\s*'text'\s*\)/.test(src)) {
          offenders.push(path.relative(ROOT, p));
        }
      }
    }
  };
  walk(path.join(ROOT, 'scripts'));
  assert.deepEqual(offenders, [], `use responseText() from scripts/lib/anthropic-response-text.js in: ${offenders.join(', ')}`);
});
