// House style bans em dashes in on-screen copy. The account and My Shows
// screens shipped a dozen of them in labels, notices and tooltips before the
// soft launch (BRO-4525). This walks the real source with the TypeScript
// parser and checks only what can reach the screen (JSX text and string or
// template literals), so comments and console messages keep theirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The signed-in feature surface: My Shows, account UI, imports, the menu and
// header, the rating hero on show pages and the diary page.
const SCOPE = [
  'src/app/my-shows',
  'src/app/diary-show',
  'src/components/user',
  'src/components/auth',
  'src/components/show-page/ShowHeroRedesign.tsx',
  'src/components/HamburgerMenu.tsx',
  'src/components/HeaderHamburger.tsx',
  'src/components/HeaderUserIcon.tsx',
  'src/contexts/AuthContext.tsx',
  'src/lib/show-import.ts',
];

// JSX text keeps HTML entities undecoded, so &mdash; would slip past a
// character check.
const EM_DASH = /—|&mdash;|&#8212;|&#x2014;/i;

function files(rel) {
  const abs = path.join(root, rel);
  if (fs.statSync(abs).isFile()) return [abs];
  return fs.readdirSync(abs, { recursive: true })
    .filter((f) => /\.tsx?$/.test(f) && !f.includes('__dev-mock'))
    .map((f) => path.join(abs, f));
}

// Strings passed straight to console.* never reach the screen. Everything
// else might, thrown Error messages included (the rating editor shows them).
function isConsoleArg(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p)) {
      const e = p.expression;
      return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'console';
    }
  }
  return false;
}

export function emDashesIn(file) {
  const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits = [];
  const visit = (node) => {
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
    if (literal && EM_DASH.test(node.text) && !isConsoleArg(node)) {
      const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
      hits.push(`${path.relative(root, file)}:${line + 1}: ${node.text.trim().slice(0, 80)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return hits;
}

test('the scanner sees JSX text, entities and literals but not comments', (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'emdash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tmp = path.join(dir, 'x.tsx');
  fs.writeFileSync(tmp, [
    '// comment — fine',
    'const a = <p>Bad — copy</p>;',
    "const b = 'also — bad';",
    'const c = `t — ${a}`;',
    "console.warn('log — fine');",
    'const d = <p>Entity &mdash; bad</p>;',
    "const e = 'escape \\u2014 bad';",
    "throw new Error('shown — bad');",
  ].join('\n'));
  assert.deepEqual(emDashesIn(tmp).map((h) => h.split(':')[1]), ['2', '3', '4', '6', '7', '8']);
});

test('no em dash in on-screen copy for accounts and My Shows', () => {
  const hits = SCOPE.flatMap(files).flatMap(emDashesIn);
  assert.deepEqual(hits, [], `use a comma, colon, period or parentheses instead:\n${hits.join('\n')}`);
});
