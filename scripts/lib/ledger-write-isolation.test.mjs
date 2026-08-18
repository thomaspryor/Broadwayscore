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
//
// PARSER NOTE: all scanning happens on a MASKED copy of the source in which
// string literals and comments are blanked out (maskSource below). An earlier
// draft counted quote characters per line to detect string context; an
// adversarial review pointed out that an apostrophe in a comment — `// don't
// call main(` — flips the parity and would red CI on an innocent file. Masking
// removes that whole class rather than special-casing it.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Modules whose main() reaches a dispatch-ledger append site. Matched without
// the extension too, so `require('./bsc-next')` is not a blind spot.
// SCOPE, stated honestly: this guard covers modules whose ledger write is
// reachable through an INJECTABLE dep on `main(argv, deps)`. That is the only
// shape it can check, because stubbing that dep is the only remediation it can
// recommend.
//
// linear-next.js belongs here — it defaults appendLedgerEntry the same way
// (scripts/linear-next.js:257) with append sites at :453/:504/:551/:564.
//
// bsc-reconcile and dispatch-watchdog were listed here and have been REMOVED,
// because listing them was worse than omitting them — it advertised coverage
// the guard cannot provide, and the offender message would have taught a fix
// that does nothing:
//   - scripts/bsc-reconcile.js:812 is `async function main()` with ZERO params.
//     Its `appendLedgerFn` dep (:360) belongs to `reconcileStalledTasks` (:355),
//     which this guard never scans. Listing it caused a measured false negative:
//     the alias was accepted at 0 sites where it was correct and 23 where it was
//     wrong, so a bsc-next test stubbing only `appendLedgerFn` passed while
//     writing the real ledger.
//   - scripts/dispatch-watchdog.js:549 is likewise `async function main()` with
//     no params, and :281/:295/:408 call dispatchLedger.appendEntry DIRECTLY,
//     with no seam to stub at all.
// Neither leaks today (verified by running their suites against the real ledger
// line count). Covering them needs a different mechanism, tracked separately.
const LEDGER_WRITERS = ['bsc-next', 'bsc-prune', 'linear-next'];

const MAX_SPREAD_DEPTH = 8;

function testFiles() {
  const out = [];
  // tests/unit is included because linear-next's test lives there — scanning
  // only scripts/** left a ledger writer completely uncovered.
  const REPO_TESTS = path.join(SCRIPTS, '..', 'tests', 'unit');
  for (const dir of [SCRIPTS, path.join(SCRIPTS, 'lib'), path.join(SCRIPTS, 'tests'), REPO_TESTS]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.test.mjs') || f.endsWith('.test.js')) out.push(path.join(dir, f));
    }
  }
  return out;
}

// Replace the CONTENTS of comments and string/template literals with spaces,
// preserving length and newlines so every index still maps to the original.
// Everything downstream then scans real code only.
function maskSource(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i); const stop = end === -1 ? src.length : end;
      blank(i, stop); i = stop; continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2); const stop = end === -1 ? src.length : end + 2;
      blank(i, stop); i = stop; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      blank(i, Math.min(j + 1, src.length)); i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

// True when the file imports/requires one of the ledger-writing modules.
// Runs on RAW source: the module path is a string literal, which maskSource blanks.
function importsLedgerWriter(raw) {
  const alt = LEDGER_WRITERS.join('|');
  const re = new RegExp(`(?:from|require\\s*\\()\\s*['"][^'"]*\\b(?:${alt})(?:\\.js)?['"]`);
  return re.test(raw);
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

// Every `main(` / `<alias>(` call that could reach a ledger-writing main().
// Aliases (`const run = main`) are resolved so `run(argv, deps)` is covered.
function callSlices(masked) {
  const names = new Set(['main']);
  for (const m of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*main\b\s*[;\n]/g)) {
    names.add(m[1]);
  }
  const slices = [];
  const re = new RegExp(`\\b(${[...names].join('|')})\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(masked)) !== null) {
    // Skip the declaration site itself (`function main(` / `= main(`-less forms).
    const before = masked.slice(Math.max(0, m.index - 9), m.index);
    if (/\bfunction\s+$/.test(before)) continue;
    const open = m.index + m[0].length - 1;
    const end = matchFrom(masked, open, '(', ')');
    if (end === -1) continue;
    slices.push({ index: m.index, argsStart: open, text: masked.slice(m.index, end + 1) });
  }
  return slices;
}

// Body of a helper declared as `function NAME(`, `const NAME = (...) =>`,
// `const NAME = function`, or `const NAME = { ... }`. Returns masked text.
function resolveBinding(masked, name) {
  const esc = name.replace(/[$]/g, '\\$');
  const fnDecl = masked.search(new RegExp(`\\bfunction\\s+${esc}\\s*\\(`));
  if (fnDecl !== -1) {
    const parenEnd = matchFrom(masked, masked.indexOf('(', fnDecl), '(', ')');
    const open = masked.indexOf('{', parenEnd);
    const end = matchFrom(masked, open, '{', '}');
    if (open !== -1 && end !== -1) return masked.slice(open, end + 1);
  }
  const bind = masked.search(new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*=`));
  if (bind === -1) return null;
  const eq = masked.indexOf('=', bind);
  const firstBrace = masked.indexOf('{', eq);
  const arrow = masked.indexOf('=>', eq);
  // An arrow BEFORE the first brace means the initializer is `= (...) => body`,
  // so the body starts after the `=>` — taking the first delimiter instead grabs
  // the (often empty) parameter list and silently resolves to nothing.
  // Anything else (`= { ... }`, `= function () { ... }`) is the brace group.
  let start;
  if (arrow !== -1 && (firstBrace === -1 || arrow < firstBrace)) {
    const b = masked.indexOf('{', arrow);
    const p = masked.indexOf('(', arrow);
    const cands = [b, p].filter(x => x !== -1);
    if (!cands.length) return null;
    start = Math.min(...cands);
  } else {
    start = firstBrace;
  }
  if (start === -1 || start === undefined) return null;
  const end = masked[start] === '{'
    ? matchFrom(masked, start, '{', '}')
    : matchFrom(masked, start, '(', ')');
  if (end === -1) return null;
  return masked.slice(start, end + 1);
}

// Anchored to KEY position on purpose. A bare `text.includes('appendLedgerEntry')`
// also matches the key `appendLedgerEntryFn:` — which is the LOCAL alias the
// writer modules destructure into (scripts/bsc-next.js:749), not the dep key.
// A deps object carrying `appendLedgerEntryFn:` overrides nothing, so the
// substring form judged a real ledger write as safe.
const STUB_KEY = /[{,]\s*appendLedgerEntry\s*[:,}]/;

// Does this text stub the ledger writer, directly or via anything it inherits?
function stubsLedgerWrite(masked, text, depth = 0, seen = new Set()) {
  if (!text) return false;
  if (STUB_KEY.test(text)) return true;
  if (depth > MAX_SPREAD_DEPTH) return false;

  const names = new Set();
  // `...helper(...)`, `...variable`, and `Object.assign({}, base)` forms.
  for (const m of text.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/Object\.assign\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().replace(/\(\s*\)$/, '');
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (stubsLedgerWrite(masked, resolveBinding(masked, name), depth + 1, seen)) return true;
  }
  return false;
}

// The deps argument of a call: either an inline object literal or an identifier
// (`main(argv, deps)`), which must then be resolved to its binding.
function depsText(masked, slice) {
  const inner = slice.text.slice(slice.text.indexOf('(') + 1, slice.text.length - 1);
  const brace = inner.indexOf('{');
  if (brace !== -1) return inner.slice(brace);
  const parts = inner.split(',');
  if (parts.length < 2) return null; // no deps argument at all
  const ident = parts[parts.length - 1].trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return null;
  // Only an identifier bound to an OBJECT LITERAL is a deps bag. Other main()
  // signatures in this repo take a function in that position (bsc-conductor's
  // `main(argv, fn, spawnFn)`), and resolving those produced false positives.
  const esc = ident.replace(/[$]/g, '\\$');
  if (!new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*=\\s*\\{`).test(masked)) return null;
  return resolveBinding(masked, ident);
}

test('no test invokes a ledger-writing main() without stubbing appendLedgerEntry', () => {
  const offenders = [];
  for (const file of testFiles()) {
    const raw = fs.readFileSync(file, 'utf8');
    const masked = maskSource(raw);
    // Gate on an actual import/require of a ledger-writing module, checked
    // against the RAW source (module paths live inside string literals, which
    // maskSource blanks). A bare substring match pulled in bsc-conductor.test,
    // whose unrelated main(argv, fn, spawnFn) is not a ledger writer at all.
    if (!importsLedgerWriter(raw)) continue;
    for (const slice of callSlices(masked)) {
      const deps = depsText(masked, slice);
      if (deps === null) continue; // no deps object passed — nothing to stub
      if (stubsLedgerWrite(masked, deps)) continue;
      offenders.push(`${path.relative(SCRIPTS, file)}:${raw.slice(0, slice.index).split('\n').length}`);
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

// The parser is the risky part of this guard, so it is itself tested. Each case
// below is a bypass an adversarial review proposed against the first draft.
test('guard parser: catches the bypasses that defeated the first draft', () => {
  const cases = [
    ['arrow helper', "const baseDeps = () => ({ launchCmux: () => ({ ok: true }) });\nmain(['--id','1'], { ...baseDeps() });"],
    ['bare identifier deps', "const deps = { launchCmux: () => ({ ok: true }) };\nmain(['--id','1'], deps);"],
    ['aliased main', "const run = main;\nrun(['--id','1'], { launchCmux: () => ({ ok: true }) });"],
    ['Object.assign', "const base = { launchCmux: () => ({ ok: true }) };\nmain(['--id','1'], Object.assign({}, base));"],
  ];
  for (const [label, src] of cases) {
    const masked = maskSource(src);
    const slices = callSlices(masked).filter(s => depsText(masked, s) !== null);
    assert.ok(slices.length > 0, `${label}: parser found no deps-bearing call`);
    assert.ok(slices.some(s => !stubsLedgerWrite(masked, depsText(masked, s))),
      `${label}: should be flagged as unstubbed, but the guard thinks it is safe`);
  }
});

test('guard parser: resolves legitimate stubs through helpers, and ignores comments/strings', () => {
  const viaFunction = "function baseDeps() { return { appendLedgerEntry: () => {} }; }\nmain(['--id','1'], { ...baseDeps() });";
  const viaArrow = "const baseDeps = () => ({ appendLedgerEntry: () => {} });\nmain(['--id','1'], { ...baseDeps() });";
  const viaVariable = "const base = { appendLedgerEntry: () => {} };\nconst deps = { ...base };\nmain(['--id','1'], deps);";
  for (const [label, src] of [['function', viaFunction], ['arrow', viaArrow], ['variable chain', viaVariable]]) {
    const masked = maskSource(src);
    for (const s of callSlices(masked)) {
      const d = depsText(masked, s);
      if (d === null) continue;
      assert.ok(stubsLedgerWrite(masked, d), `${label}: legitimate stub was not resolved (false positive)`);
    }
  }
  // An apostrophe inside a comment must not be read as an unterminated string —
  // the per-line quote-parity draft red-lit CI on exactly this shape.
  const commented = "// don't call main( here\nconst x = 1;";
  assert.equal(callSlices(maskSource(commented)).length, 0, 'comment text was parsed as code');
});

// These two NEGATIVE cases each correspond to a real defect that shipped and had
// to be reverted. Without them the guard silently stops protecting.
test('guard parser: near-miss names do NOT count as stubbing the writer', () => {
  const cases = [
    // Shipped 2026-08-18 and reverted: `appendLedgerFn` is bsc-reconcile's dep for
    // reconcileStalledTasks, NOT for main(). Accepting it globally meant a bsc-next
    // test could stub the wrong name and still write the real ledger.
    ['appendLedgerFn on a main() call', "main(['--id','1'], { appendLedgerFn: () => {} });"],
    // `appendLedgerEntryFn` is the LOCAL alias the writer destructures into
    // (bsc-next.js:749). As a deps key it overrides nothing, so it must not pass.
    ['appendLedgerEntryFn as a deps key', "main(['--id','1'], { appendLedgerEntryFn: () => {} });"],
  ];
  for (const [label, src] of cases) {
    const masked = maskSource(src);
    const slices = callSlices(masked).filter(s => depsText(masked, s) !== null);
    assert.ok(slices.length > 0, `${label}: parser found no deps-bearing call`);
    assert.ok(slices.every(s => !stubsLedgerWrite(masked, depsText(masked, s))),
      `${label}: was accepted as a stub, but it does not override the real dep`);
  }
});
