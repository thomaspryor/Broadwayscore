// Guards the defect that put 77 junk `launch` rows into the production
// dispatch ledger (task #1789, root-caused 2026-08-18).
//
// THE DEFECT: a test called the real `main([...], deps)` from bsc-next.js but
// omitted `appendLedgerEntry` from its deps object. bsc-next.js defaults that
// dep to `dispatchLedger.appendEntry`, whose LEDGER_PATH is HARDCODED to
// /Users/tompryor/Broadwayscore/data/audit/dispatch-ledger.jsonl (deliberately,
// so worktrees share one ledger — see dispatch-ledger.js:28-39). The test's
// fs.mkdtempSync isolated only the TASKS dir, so the ledger write escaped into
// the real file every time the suite ran locally — 17-19 rows on a busy day.
//
// Those rows carried `workspaceRef: "workspace:1"` (the literal string in the
// test's launchCmux stub), which read exactly like a dispatcher adopting an
// unrelated live owner workspace. Two sessions chased that ghost.
//
// This is LOCAL-ONLY exposure: CI runs on ubuntu-latest, where that macOS path
// cannot be created, so the write throws and is swallowed by the caller's
// try/catch. A CI line-count check would therefore never fire — which is why
// this guard is a STATIC check on the test source instead. It runs everywhere
// and fails at authoring time, before a single junk row is written.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Modules whose main() reaches a dispatch-ledger append site.
const LEDGER_WRITERS = ['bsc-next.js', 'bsc-prune.js', 'bsc-reconcile.js', 'dispatch-watchdog.js'];

function testFiles() {
  const out = [];
  for (const dir of [SCRIPTS, path.join(SCRIPTS, 'lib')]) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.test.mjs') || f.endsWith('.test.js')) out.push(path.join(dir, f));
    }
  }
  return out;
}

// Balanced-delimiter scan from `start` (which must sit on `open`).
function matchFrom(src, start, open, close) {
  if (start < 0) return -1;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// A `main(` sitting inside a quoted string is source-inspection code, not a call
// (e.g. src.indexOf('function main(argv = ...)')). An odd quote count before the
// match on its own line means we are inside a literal.
function insideStringLiteral(src, idx) {
  const lineStart = src.lastIndexOf('\n', idx) + 1;
  const before = src.slice(lineStart, idx);
  for (const q of ["'", '"', '`']) {
    if ((before.split(q).length - 1) % 2 === 1) return true;
  }
  return false;
}

function mainCallSlices(src) {
  const slices = [];
  const re = /\bmain\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (insideStringLiteral(src, m.index)) continue;
    const open = m.index + m[0].length - 1;
    const end = matchFrom(src, open, '(', ')');
    if (end === -1) continue;
    slices.push({ index: m.index, text: src.slice(m.index, end + 1) });
  }
  return slices;
}

// Does this object-literal text stub appendLedgerEntry, directly or through any
// spread it inherits? Resolves both `...helper()` and `...variable` forms.
function stubsLedgerWrite(src, text, depth = 0) {
  if (text.includes('appendLedgerEntry')) return true;
  if (depth > 3) return false;

  // `...helperName(...)` — resolve the function body.
  for (const m of text.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const def = src.indexOf(`function ${m[1]}(`);
    if (def === -1) continue;
    // Skip the parameter list first: a default like `x = { ok: true }` puts a
    // `{` ahead of the real body.
    const parenEnd = matchFrom(src, src.indexOf('(', def), '(', ')');
    const open = src.indexOf('{', parenEnd);
    const end = matchFrom(src, open, '{', '}');
    if (open === -1 || end === -1) continue;
    if (stubsLedgerWrite(src, src.slice(open, end + 1), depth + 1)) return true;
  }

  // `...variableName` — resolve `const variableName = { ... }`.
  for (const m of text.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)\s*(?![\w$(])/g)) {
    const def = src.search(new RegExp(`\\b(?:const|let|var)\\s+${m[1]}\\s*=`));
    if (def === -1) continue;
    const open = src.indexOf('{', def);
    const end = matchFrom(src, open, '{', '}');
    if (open === -1 || end === -1) continue;
    if (stubsLedgerWrite(src, src.slice(open, end + 1), depth + 1)) return true;
  }
  return false;
}

test('no test invokes a ledger-writing main() without stubbing appendLedgerEntry', () => {
  const offenders = [];
  for (const file of testFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    if (!LEDGER_WRITERS.some(w => src.includes(w))) continue;
    for (const slice of mainCallSlices(src)) {
      if (!slice.text.includes('{')) continue; // no deps object to stub
      if (stubsLedgerWrite(src, slice.text)) continue;
      offenders.push(`${path.relative(SCRIPTS, file)}:${src.slice(0, slice.index).split('\n').length}`);
    }
  }
  assert.deepEqual(offenders, [],
    'These main() calls omit appendLedgerEntry, so it defaults to dispatchLedger.appendEntry '
    + 'and writes the REAL ledger at dispatch-ledger.js LEDGER_PATH (hardcoded — mkdtempSync does '
    + 'NOT isolate it). Add `appendLedgerEntry: () => {}` to each deps object:\n  '
    + offenders.join('\n  '));
});

test('dispatch-ledger LEDGER_PATH is still hardcoded, so the guard above is still required', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'lib', 'dispatch-ledger.js'), 'utf8');
  assert.match(src, /const REPO = '\/Users\/tompryor\/Broadwayscore'/,
    'LEDGER_PATH stopped being hardcoded — if appendEntry now resolves relative to cwd or takes an '
    + 'injected path by default, revisit this guard; the escape route changed.');
});
