// Class guard (BRO-5043 follow-up, owner asked 2026-11-08 to explain and cut
// the Gemini + OpenAI bill): every file under scripts/ that calls Gemini or
// OpenAI turns on the spend meter (scripts/lib/llm-usage-install.js) BEFORE
// it can build a client. Root cause of the unexplained bill: the meter was
// opt-in per library, so on 2026-11-08 it saw <$1/day of ~$35/day billed.
//
// Order matters: the openai SDK captures globalThis.fetch at `new OpenAI()`,
// and ESM evaluates imports in order, so in ESM/TS the meter import must be
// the first import; in CommonJS it must come before any client is built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');

// A file "calls an LLM API" when it names the API host or loads either SDK.
// Anthropic is metered separately (data/llm-scoring-runs.json, claude-session-cost).
const CALLS_LLM_RE = /generativelanguage\.googleapis\.com|api\.openai\.com|require\(\s*['"](?:openai|@google\/generative-ai)['"]\s*\)|from\s+['"](?:openai|@google\/generative-ai)['"]|new OpenAI\(/;
const METER_RE = /llm-usage-install|gemini-usage-ledger['"]\)\.install\(\)/;
const CLIENT_RE = /new (?:OpenAI|GoogleGenerativeAI)\(/;
// The meter itself and tests that stub fetch are not callers.
const EXEMPT = new Set(['scripts/lib/gemini-usage-ledger.js', 'scripts/lib/llm-usage-install.js']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(c?js|mjs|ts)$/.test(e.name) && !/\.test\.(c?js|mjs|ts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const callers = walk(SCRIPTS)
  .map((abs) => ({ rel: path.relative(ROOT, abs).split(path.sep).join('/'), src: fs.readFileSync(abs, 'utf8') }))
  .filter((f) => !EXEMPT.has(f.rel) && CALLS_LLM_RE.test(f.src));

// Exported for the red-then-green check below.
function meterProblem(src) {
  if (!METER_RE.test(src)) return 'never turns on the LLM spend meter (add `require(\'./lib/llm-usage-install\')` or `import \'./lib/llm-usage-install.js\'` first)';
  const lines = src.split('\n');
  const meterLine = lines.findIndex((l) => METER_RE.test(l) && !/^\s*(\/\/|\*)/.test(l));
  if (meterLine === -1) return 'mentions the meter only in a comment';
  const firstImport = lines.findIndex((l) => /^import\s/.test(l));
  if (firstImport !== -1 && firstImport < meterLine) return `an import (line ${firstImport + 1}) runs before the meter (line ${meterLine + 1}); make the meter the first import`;
  const firstClient = lines.findIndex((l) => CLIENT_RE.test(l) && !/^\s*(\/\/|\*)/.test(l));
  if (firstClient !== -1 && firstClient < meterLine) return `a client is built (line ${firstClient + 1}) before the meter (line ${meterLine + 1})`;
  return null;
}

test('the scan finds the known LLM callers (guards against a regex that silently matches nothing)', () => {
  const rels = new Set(callers.map((c) => c.rel));
  for (const known of ['scripts/llm-scoring/gemini-scorer.ts', 'scripts/llm-scoring/openai-scorer.ts', 'scripts/lib/content-verifier.js', 'scripts/review-factcheck/check.js']) {
    assert.ok(rels.has(known), `expected ${known} to be detected as an LLM caller`);
  }
  assert.ok(callers.length >= 50, `only ${callers.length} callers found`);
});

test('every Gemini/OpenAI caller under scripts/ turns on the spend meter before building a client', () => {
  const bad = callers.map((c) => ({ rel: c.rel, why: meterProblem(c.src) })).filter((x) => x.why);
  assert.deepEqual(bad, [], bad.map((b) => `${b.rel}: ${b.why}`).join('\n'));
});

test('red-then-green: the rule flags a missing, late, or comment-only meter', () => {
  assert.match(meterProblem("const OpenAI = require('openai');\nconst c = new OpenAI();\n"), /never turns on/);
  assert.match(meterProblem("import OpenAI from 'openai';\nimport './lib/llm-usage-install.js';\n"), /runs before the meter/);
  assert.match(meterProblem("const OpenAI = require('openai');\nconst c = new OpenAI();\nrequire('./lib/llm-usage-install');\n"), /client is built/);
  assert.match(meterProblem("// require('./lib/llm-usage-install')\nconst c = new OpenAI();\n"), /only in a comment/);
  assert.equal(meterProblem("import './lib/llm-usage-install.js';\nimport OpenAI from 'openai';\nconst c = new OpenAI();\n"), null);
  assert.equal(meterProblem("'use strict';\nrequire('./lib/llm-usage-install');\nconst OpenAI = require('openai');\n"), null);
});
