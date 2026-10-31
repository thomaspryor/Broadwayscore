/**
 * Regression guard: every gemini-2.5-flash (GEMINI_FLASH) generateContent call
 * must set thinkingConfig.thinkingBudget.
 *
 * Bug (2026-06-07): the gemini-2.0-flash → gemini-2.5-flash migration left every
 * caller's generationConfig untouched. 2.5-flash spends "thinking" tokens that
 * count against maxOutputTokens, so a 300-token budget got eaten by ~285 thinking
 * tokens and the visible response was truncated mid-sentence. 1,296 pull quotes
 * shipped cut off ("Hell yeah!", "The show stands as a rip-roaring"). Fix:
 * thinkingConfig: { thinkingBudget: 0 } on every short-output caller.
 *
 * This guard scans scripts/ source for GEMINI_FLASH generateContent usage and
 * fails if the file does not also reference thinkingConfig. It is intentionally
 * coarse (file-level) — a file that calls GEMINI_FLASH must opt into a thinking
 * decision somewhere. See memory/feedback_gemini_thinking_token_budget.md.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, '../../scripts');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'evals') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(js|ts|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('gemini-2.5-flash thinking-budget guard', () => {
  test('every GEMINI_FLASH generateContent caller sets thinkingConfig', () => {
    const offenders = [];
    for (const file of walk(SCRIPTS_DIR)) {
      const src = fs.readFileSync(file, 'utf8');
      // Only files that actually fire a generateContent request with the flash model.
      const usesFlash = /GEMINI_FLASH|gemini-2\.5-flash/.test(src);
      const callsGenerate = /generateContent/.test(src) || /generationConfig/.test(src);
      if (!usesFlash || !callsGenerate) continue;
      if (!/thinkingConfig/.test(src)) {
        offenders.push(path.relative(SCRIPTS_DIR, file));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `These files call gemini-2.5-flash without thinkingConfig — thinking tokens will ` +
      `truncate the response. Add thinkingConfig: { thinkingBudget: 0 } (or a real ` +
      `budget + larger maxOutputTokens). Offenders:\n  ${offenders.join('\n  ')}`
    );
  });
});
