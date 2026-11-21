/**
 * BRO-8016 class guard. Skill and command markdown holds runnable curl and CLI
 * lines that sessions copy verbatim, but the code-only pin guards
 * (gemini-retiring-ids.test.mjs, gemini-thinking-budget-guard.test.mjs) skip
 * dot directories and .md files. So plan-review.md kept calling gemini-2.5-flash
 * (shut down 2026-12-01) with nothing to flag it. A call-shaped line in a skill
 * doc must take the Gemini model from scripts/lib/models.js (e.g.
 * `$(node -p "require('./scripts/lib/models').GEMINI_REVIEW")`), never a literal
 * id, so the next retirement is one line in models.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Model id in call position: a REST path, a --model flag, or a JSON/YAML model field.
const CALL_PIN = /(?:models\/|--model[= ]|\bmodel["']?\s*[:=]\s*["']?)gemini-\d/;
export const hasCallPin = (src) => src.split('\n').some((l) => CALL_PIN.test(l));

function skillDocs() {
  const out = [];
  const cmd = path.join(ROOT, '.claude/commands');
  if (fs.existsSync(cmd)) for (const f of fs.readdirSync(cmd)) if (f.endsWith('.md')) out.push(path.join(cmd, f));
  for (const base of ['.claude/skills', '.agents/skills']) {
    const dir = path.join(ROOT, base);
    if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir)) {
      const p = path.join(dir, d, 'SKILL.md');
      if (fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

test('skill docs scanned include the command, skill-source and mirror folders', () => {
  const rel = skillDocs().map((p) => path.relative(ROOT, p));
  assert.ok(rel.includes('.claude/commands/plan-review.md'));
  assert.ok(rel.some((r) => r.startsWith('.agents/skills/')));
});

test('no skill or command doc hardcodes a Gemini model id in a call (take it from models.js)', () => {
  const offenders = skillDocs().filter((p) => hasCallPin(fs.readFileSync(p, 'utf8'))).map((p) => path.relative(ROOT, p));
  assert.deepEqual(offenders, [], `read the model from scripts/lib/models.js instead: ${offenders.join(', ')}`);
});

test('the detector catches the call forms and ignores prose (red-then-green)', () => {
  assert.equal(hasCallPin('curl -s "https://x/v1beta/models/gemini-2.5-flash:generateContent?key=$K"'), true);
  assert.equal(hasCallPin('node scripts/log-llm-call.js --provider=gemini --model=gemini-4-carbon'), true);
  assert.equal(hasCallPin('  model: "gemini-3.8-flash",'), true);
  assert.equal(hasCallPin('curl -s "https://x/v1beta/models/$GM:generateContent"'), false);
  assert.equal(hasCallPin('about $0.02 a review on gemini-2.5-flash, which opened the files'), false);
  assert.equal(hasCallPin('--model="$(node -p "require(\'./scripts/lib/models\').GEMINI_REVIEW")"'), false);
});
