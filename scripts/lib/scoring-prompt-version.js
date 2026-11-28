'use strict';
/**
 * The scorer's current PROMPT_VERSION, readable from plain JS (BRO-5047).
 *
 * PROMPT_VERSION lives in scripts/llm-scoring/config.ts, which the workflow's
 * JS cascade counter (scoring-queue-counts.js) cannot import. The sticky
 * not_a_review rejection must lift when the prompt changes, so the counter and
 * the TS scorer both need the same value: this reads it from the source file
 * rather than keeping a second copy that could drift. Returns null when it
 * cannot be read; callers treat that as "do not block" (fail open costs one
 * re-evaluation, fail closed could hide a review for good).
 */
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'llm-scoring', 'config.ts');
const DECL_RE = /^export const PROMPT_VERSION\s*=\s*'([^']+)';/m;

let cached;
function readScoringPromptVersion() {
  if (cached !== undefined) return cached;
  try {
    const m = fs.readFileSync(CONFIG_PATH, 'utf8').match(DECL_RE);
    cached = m ? m[1] : null;
  } catch {
    cached = null;
  }
  return cached;
}

module.exports = { readScoringPromptVersion, CONFIG_PATH, DECL_RE };
