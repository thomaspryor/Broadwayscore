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

// BRO-7096: the same list restated as an || chain (also across a line break).
const EXCERPT_NAME = /\b(?:dtli|bww|showScore|nycTheatre|lboRoundup|westEndTheatre|theatreReviews|theStage|stagedoor|playbillVerdict|meta)Excerpt\b/g;

function chainOffenders(text) {
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    // join a chain broken across lines: this line plus the next when this one ends in ||
    const joined = /\|\|\s*$/.test(lines[i]) && lines[i + 1] ? lines[i] + ' ' + lines[i + 1] : lines[i];
    if (joined.includes('excerpt-subset-ok') || !joined.includes('||')) continue;
    const names = new Set(joined.match(EXCERPT_NAME) || []);
    if (names.size >= 3) hits.push(i + 1);
  }
  return hits;
}

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

test('no script restates the excerpt field list as an || chain', () => {
  const offenders = walk(path.join(ROOT, 'scripts'))
    .filter(f => !f.endsWith(path.join('lib', 'excerpt-fields.js')))
    .filter(f => !/\.test\.m?js$/.test(f))
    .filter(f => !f.includes(`${path.sep}llm-scoring${path.sep}`)) // one-off experiments (.ts), left on their own subsets
    .flatMap(f => chainOffenders(fs.readFileSync(f, 'utf8')).map(n => `${path.relative(ROOT, f)}:${n}`));
  assert.deepEqual(offenders, [], 'use hasExcerpt()/getLongestExcerpt() from scripts/lib/excerpt-fields.js');
});

test('chain detector flags a 3-name chain and a split chain, not a 2-name one', () => {
  assert.equal(chainOffenders('x = d.dtliExcerpt || d.bwwExcerpt || d.stagedoorExcerpt').length, 1);
  assert.equal(chainOffenders('x = d.dtliExcerpt || d.bwwExcerpt ||\n  d.stagedoorExcerpt').length, 1);
  assert.equal(chainOffenders('x = d.dtliExcerpt || d.bwwExcerpt').length, 0);
});

test('a West End-only excerpt is seen as an excerpt by the content tier', () => {
  const { classifyContentTier } = require('../../scripts/lib/content-quality.js');
  const r = classifyContentTier({ stagedoorExcerpt: 'A thrilling, moving revival with a superb cast and a clear sense of purpose throughout.' });
  assert.equal(r.contentTier, 'excerpt');
  assert.match(r.tierReason, /aggregator excerpts/);
});

// BRO-7096 review: a boolean hasExcerpt() result used as text (`.length`, or as a `||` text fallback after fullText) is silently wrong.
test('hasExcerpt() is never used as a string', () => {
  const BAD = /\bhas(?:Any)?Excerpt\([^)]*\)\s*\./;
  const BAD_TEXT = /has(?:Any)?Excerpt\([^)]*\)\s*\|\|\s*(?:''|\w+\.(?:fullText|pullQuote))/;
  const offenders = walk(path.join(ROOT, 'scripts'))
    .filter(f => !/\.test\.m?js$/.test(f))
    .flatMap(f => fs.readFileSync(f, 'utf8').split('\n').map((l, i) => (BAD.test(l) || BAD_TEXT.test(l) ? `${path.relative(ROOT, f)}:${i + 1}` : null)).filter(Boolean));
  assert.deepEqual(offenders, []);
});
