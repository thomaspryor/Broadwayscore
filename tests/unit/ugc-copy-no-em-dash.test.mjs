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

// The signed-in feature surface: My Shows, account UI, imports.
const SCOPE = [
  'src/app/my-shows',
  'src/components/user',
  'src/components/auth',
  'src/contexts/AuthContext.tsx',
  'src/lib/show-import.ts',
];

function files(rel) {
  const abs = path.join(root, rel);
  if (fs.statSync(abs).isFile()) return [abs];
  return fs.readdirSync(abs, { recursive: true })
    .filter((f) => /\.tsx?$/.test(f) && !f.includes('__dev-mock'))
    .map((f) => path.join(abs, f));
}

// Strings passed to console.* or new Error(...) inside a catch-and-log never
// reach the screen; everything else might.
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
    if (literal && node.text.includes('—') && !isConsoleArg(node)) {
      const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
      hits.push(`${path.relative(root, file)}:${line + 1}: ${node.text.trim().slice(0, 80)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return hits;
}

test('the scanner sees JSX text and literals but not comments', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'emdash-')), 'x.tsx');
  fs.writeFileSync(tmp, [
    '// comment — fine',
    'const a = <p>Bad — copy</p>;',
    "const b = 'also — bad';",
    'const c = `t — ${a}`;',
    "console.warn('log — fine');",
  ].join('\n'));
  assert.deepEqual(emDashesIn(tmp).map((h) => h.split(':')[1]), ['2', '3', '4']);
});

test('no em dash in on-screen copy for accounts and My Shows', () => {
  const hits = SCOPE.flatMap(files).flatMap(emDashesIn);
  assert.deepEqual(hits, [], `use a comma, colon, period or parentheses instead:\n${hits.join('\n')}`);
});
