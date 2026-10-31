'use strict';

// Owner voice rules for on-screen copy (BRO-5812). Walks the TypeScript AST and
// checks only strings that can reach the screen (JSX text, string and template
// literals), so code comments and console messages keep their punctuation.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// JSX text keeps HTML entities undecoded, so &mdash; needs its own alternative.
const EM_DASH = /—|&mdash;|&#8212;|&#x2014;|\\u2014/i;
const BANNED_PHRASES = new RegExp(
  '\\b(?:truly|genuinely|delve|robust|leverages?|leveraged|unlock(?:s|ed|ing)?|tapestry|realm|deep dive'
  + '|landscape of|journey of|navigate the|moreover|furthermore|additionally|serves as|worth noting'
  + "|it(?:'s|&apos;s| is) not just|not just [^.]{1,40}, but)\\b",
  'i',
);

// A spaced en dash is an em dash in disguise (template-literal date ranges like `${a} – ${b}` are typography and stay). A bare "–" is the empty-cell placeholder and is fine.
const SPACED_EN_DASH = /(?:^|\s)–(?:\s|$)/;

// "–" alone, or alone on its own JSX line, is an empty-cell placeholder. " – " between expressions is a separator.
const isPlaceholder = (text) => /^\s*–\s*$/.test(text) && (text === '–' || text.includes('\n'));

// A find-and-replace that eats an ampersand leaves text like "navigateapos;ll".
const BROKEN_ENTITY = /(?<![&\w])\w+(?:apos|quot|amp|mdash);|[A-Za-z](?:apos|quot);/;

function isConsoleArg(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p)) {
      const e = p.expression;
      return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'console';
    }
  }
  return false;
}

function copyViolationsIn(file, root = process.cwd()) {
  const text = fs.readFileSync(file, 'utf8');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits = [];
  const visit = (node) => {
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
    if (literal && (EM_DASH.test(node.text) || BANNED_PHRASES.test(node.text) || BROKEN_ENTITY.test(node.text)
      || (!ts.isTemplateMiddle(node) && !ts.isTemplateTail(node) && !ts.isTemplateHead(node) && !ts.isNoSubstitutionTemplateLiteral(node)
        && SPACED_EN_DASH.test(node.text) && !isPlaceholder(node.text))) && !isConsoleArg(node)) {
      const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
      hits.push(`${path.relative(root, file)}:${line + 1}: ${node.text.trim().replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return hits;
}

function listTsFiles(dir) {
  return fs.readdirSync(dir, { recursive: true })
    .filter((f) => /\.tsx?$/.test(f) && !f.includes('__dev-mock'))
    .map((f) => path.join(dir, f));
}

module.exports = { EM_DASH, BANNED_PHRASES, copyViolationsIn, listTsFiles };
