/**
 * Hand-kept copies of the excerpt field list drift: critic-consensus-inputs.js,
 * adjudication-prompt.js and fix-critic-name-duplicates.js each missed the West
 * End fields (stagedoorExcerpt, theStageExcerpt, ...) that the scorer accepts
 * (BRO-6226 cousins). scripts/lib/excerpt-fields.js is the single source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// An array literal that opens with two aggregator excerpt names, any order or quote style.
const INLINE_LIST = /\[\s*['"](?:dtli|bww|showScore)Excerpt['"]\s*,\s*['"](?:dtli|bww|showScore)Excerpt['"]/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(c?js|mjs|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('no script restates the excerpt field list inline', () => {
  const offenders = walk(path.join(ROOT, 'scripts'))
    .filter(f => !f.endsWith(path.join('lib', 'excerpt-fields.js')))
    .filter(f => !/\.test\.m?js$/.test(f))
    .filter(f => fs.readFileSync(f, 'utf8').split('\n').some(l => INLINE_LIST.test(l) && !l.includes('excerpt-subset-ok')))
    .map(f => path.relative(ROOT, f));
  assert.deepEqual(offenders, [], 'import EXCERPT_FIELDS from scripts/lib/excerpt-fields.js instead');
});

test('the adjudication prompt carries West End excerpts', () => {
  const { buildUserPrompt } = require('../../scripts/lib/adjudication-prompt.js');
  const prompt = buildUserPrompt(
    { outlet: 'Stagedoor', outletId: 'stagedoor', criticName: 'A Critic' },
    { stagedoorExcerpt: 'A thrilling, moving revival.' },
    'Some Show',
  );
  assert.match(prompt, /thrilling, moving revival/);
});

test('the metaExcerpt is labelled as the page headline, not an aggregator quote', () => {
  const { buildUserPrompt } = require('../../scripts/lib/adjudication-prompt.js');
  const prompt = buildUserPrompt({ outlet: 'X', outletId: 'x', criticName: 'A' }, { metaExcerpt: 'Headline here' }, 'Show');
  assert.match(prompt, /Review page headline and standfirst/);
  assert.doesNotMatch(prompt, /META Excerpt/);
});
