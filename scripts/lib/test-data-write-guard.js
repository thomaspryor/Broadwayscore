#!/usr/bin/env node
// scripts/lib/test-data-write-guard.js — flag tests that write to a real
// tracked data/*.json path instead of a tmp()/mkdtemp() fixture.
//
// Task #1662 (Notion 3be637c5416f812f802ac82f43e9789c). Two tests independently
// grew the same anti-pattern: backing up/mutating/restoring (or renaming out of
// place and back) a real, symlinked, tracked data/*.json file as a test
// fixture, racing ~20 parallel sessions + CI that write those files on their
// own cadence (fixed in b4d6c619317 and 8bf5f00eb08, task #1649). Both were
// only caught by a manual grep sweep. This is that sweep, automated.
//
// Pure functions only — no fs walking here (see the CLI wrapper,
// scripts/test-data-write-guard.js, for file discovery). Modeled on the
// WRITE_COMMANDS/bashWriteTargets heuristic in scripts/lib/infra-review-scope.js:
// best-effort static analysis, not a real JS parser. Identifier resolution
// picks the NEAREST PRECEDING declaration of a name before the call site
// (not a file-wide "is this name ever safe anywhere" set) — a 590+-file test
// suite reuses names like `target`/`fixturePath` across unrelated blocks, and
// a file-scoped resolution would let an unsafe literal hide behind an
// unrelated safe declaration elsewhere in the file (or the reverse: flag a
// legitimate tmp write because of an unrelated unsafe same-named decl later
// in the file). This is still not real lexical/block scoping — just
// textual order — but it matches how test files are actually structured
// (declare immediately before use) far better than a global set did.
//
// KNOWN GAPS (false negatives, by design — see isUnsafeDataPathExpr): dynamic
// paths built via `path.resolve()`, template-literal interpolation, or
// spread/computed args are not statically resolvable and are silently NOT
// flagged, per the card's "statically resolves" framing. Also not covered:
// (1) a declaration whose RHS spans multiple lines (collectDeclarations'
// regex captures to end-of-line) — reformat as single-line or the write must
// be caught by a direct literal check instead of identifier resolution;
// (2) indirection through a function parameter or object property
// (`function restore(target) { renameSync(target, ...) }` called with a real
// path) — this tool has no call-graph, only textual declaration order;
// (3) `.test.sh` bash integration tests — this scans JS/TS call syntax only.
// A bash-level equivalent would reuse the WRITE_COMMANDS/bashWriteTargets
// shape in scripts/lib/infra-review-scope.js, but that machinery scans tool
// *invocations* at hook time, not committed .sh file text — a real gap, not
// yet built (audited at ship time: the only 2 current .test.sh files
// referencing data/*.json write into synthetic tmp repos, not the real tree,
// so this is not a live incident today). This tool catches the *shape* of
// bug that already landed twice; it is not a general taint tracker.
//
// ESCAPE HATCH: a genuine false positive can be suppressed inline —
// `// test-data-write-guard-allow: <reason>` on the SAME LINE as the flagged
// call. Deliberately no separate allowlist file (unlike the sibling
// *-write-guard-exempt.txt files scripts/lint-write-routing.sh reads): an
// inline comment is self-documenting at the call site and can't drift out of
// sync with a renamed/deleted file the way an allowlist entry can.

'use strict';

// Functions whose target argument(s) actually write/remove a file. renameSync
// writes its destination AND removes its source — the diary bug renamed the
// REAL file out of place as its source, so both positions matter. copyFileSync
// only writes its destination (arg 1) — the source (arg 0) is read-only, so a
// real data/*.json path there (a fixture's read-only origin, as in the fixed
// sentinel test) is fine and must not be flagged. writeFile (no Sync suffix)
// covers both the fs.promises/fsPromises callback-free API and the
// legacy fs.writeFile(path, data, cb) callback form — both take the path
// first.
const WRITE_CALLS = {
  writeFileSync: [0],
  writeFile: [0],
  appendFileSync: [0],
  renameSync: [0, 1],
  copyFileSync: [1],
};

const INLINE_ALLOW_RE = /test-data-write-guard-allow:\s*\S/;

// A real tracked data/*.json path, as a bare RELATIVE literal — 'data/' must
// be the leading real segment (start of string, quote, backtick, or after a
// run of leading './'/'../' segments — `join(__dirname,
// '../../data/shows.json')` is the dominant relative idiom for locating
// data/ from tests/unit/*.test.mjs). Deliberately does NOT match 'data/'
// nested deeper in a relative path (`'../fixtures/data/sample.json'` is a
// test's own unrelated fixtures/data/ subdir, not the repo root's data/ —
// pinned by its own test case) — only ABSOLUTE_DATA_JSON_RE below reaches
// past the leading segment, and only because an absolute path's leading
// segments are never "some other relative base the test made up".
const DATA_JSON_RE = /(?:^|['"`])(?:\.\.?\/)*data\/[\w.-]+(?:\/[\w.-]+)*\.json/;

// A real tracked data/*.json path reached via an ALREADY-ABSOLUTE literal,
// e.g. a hardcoded `/Users/x/Broadwayscore/data/shows.json`, or a variable
// holding a `path.join(process.cwd(), 'data', 'reviews.json')` result. This
// was a genuine false-negative gap (BRO-343 dispatcher, verified live:
// findUnsafeDataWrites returned [] for writeFileSync of the repo's absolute
// data/reviews.json path) — the original DATA_JSON_RE only matched a
// RELATIVE 'data/' segment, on the assumption "an absolute path is always
// tmp-derived", which is false whenever a test resolves an absolute path to
// the REAL repo root instead of a tmp root. Anchored to a leading '/' (a
// true absolute path) so an unrelated RELATIVE fixtures/data/ nesting is
// never affected — only a path that is unambiguously rooted at the
// filesystem root is checked for a 'data/…json' segment anywhere within it.
// ABS_TMP_ROOT_RE below excludes the one absolute shape that's legitimately
// safe regardless of what it contains further in: an OS tmp directory.
// Two conditions, checked separately in isAbsoluteDataJsonLiteral() rather
// than fused into one regex: (1) the literal starts with a leading '/'
// (unambiguously absolute, never "some other relative base the test made
// up"), and (2) a '/data/…json' segment appears anywhere within it.
const ABSOLUTE_LEADING_SLASH_RE = /^(['"`])\//;
const DATA_JSON_SEGMENT_ANYWHERE_RE = /\/data\/[\w.-]+(?:\/[\w.-]+)*\.json/;

function isAbsoluteDataJsonLiteral(quotedText) {
  return ABSOLUTE_LEADING_SLASH_RE.test(quotedText) && DATA_JSON_SEGMENT_ANYWHERE_RE.test(quotedText);
}

// A literal absolute path rooted at a known OS tmp directory (Linux/CI's
// os.tmpdir() is /tmp; macOS local dev resolves through /var/folders/... or
// sometimes /tmp via TMPDIR). A hardcoded literal in this shape is tmp-safe
// regardless of what segment names it contains further down the path —
// the one absolute shape ABSOLUTE_DATA_JSON_RE must not flag.
const ABS_TMP_ROOT_RE = /^(['"`])\/(?:tmp|private\/tmp|var\/folders)\//;

// Same shape, anchored for matching a slash-joined reconstruction of a
// multi-segment join() call (e.g. join(ROOT, 'data', 'shows.json'), or
// join(__dirname, '..', '..', 'data', 'shows.json') — each path segment is
// its own string-literal argument, not one literal).
const DATA_JSON_TAIL_RE = /^(?:\.\.?\/)*data\/[\w.-]+(?:\/[\w.-]+)*\.json$/;

// A tmp base, inline in an expression (not via a declared variable).
const SAFE_ASSIGNMENT_RE = /\b(?:mkdtempSync|mkdtemp|tmpdir)\s*\(/;
const SAFE_ENV_RE = /process\.env\.RUNNER_TEMP/;

// A base that's confidently a real repo root (never a tmp dir), used to gate
// the multi-segment join() reconstruction below — see isKnownRealRootExpr.
const REAL_ROOT_HINT_RE = /import\.meta\.dirname|__dirname|process\.cwd\s*\(/;

const MAX_RESOLVE_DEPTH = 12;

// Split a balanced argument list (text between the outer parens of a call)
// into top-level comma-separated argument strings, ignoring commas nested
// inside (), [], {}, or quotes.
function splitArgs(argsText) {
  const args = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (quote) {
      current += ch;
      if (ch === quote && argsText[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

// Given source text and the index right after a call's opening '(', find the
// matching ')' and return the raw text of the argument list.
function extractCallArgs(text, openParenIdx) {
  let depth = 1;
  let i = openParenIdx + 1;
  let quote = null;
  for (; i < text.length && depth > 0; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  return text.slice(openParenIdx + 1, i - 1);
}

// Every top-level `const|let|var NAME = RHS` declaration in the file, with
// its character offset, sorted by position. RHS capture is single-line
// (matches up to end of line) — a known limitation for multi-line RHS, same
// tradeoff the original bashWriteTargets-style heuristics accept.
function collectDeclarations(source) {
  const decls = [];
  const re = /\b(?:const|let|var)\s+(\w+)\s*=\s*(.+?);?\s*$/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    decls.push({ name: m[1], rhs: m[2], index: m.index });
  }
  return decls;
}

// The RHS text of the declaration of `name` nearest before (or at)
// `usageIndex` — approximates lexical scoping by textual order rather than
// AST scope. Returns null if no such declaration exists (unresolvable).
function resolveIdentifierRhs(name, usageIndex, decls) {
  let best = null;
  for (const d of decls) {
    if (d.name !== name || d.index > usageIndex) continue;
    if (!best || d.index > best.index) best = d;
  }
  return best ? best.rhs : null;
}

// Does `expr` resolve to a tmp/mkdtemp-derived base? Recurses through
// join()/path.join() (safe if ANY leading segment is tmp-safe) and through
// identifiers (via their nearest preceding declaration).
function isTmpSafeExpr(expr, usageIndex, decls, depth = 0) {
  if (depth > MAX_RESOLVE_DEPTH) return false;
  const trimmed = String(expr).trim();

  if (SAFE_ASSIGNMENT_RE.test(trimmed) || SAFE_ENV_RE.test(trimmed)) return true;

  const joinCall = trimmed.match(/^(?:path\s*\.\s*)?join\s*\(/);
  if (joinCall) {
    const openIdx = trimmed.indexOf('(');
    const innerArgs = splitArgs(extractCallArgs(trimmed, openIdx));
    return innerArgs.some((a) => isTmpSafeExpr(a, usageIndex, decls, depth + 1));
  }

  if (/^\w+$/.test(trimmed)) {
    const rhs = resolveIdentifierRhs(trimmed, usageIndex, decls);
    if (rhs === null) return false;
    return isTmpSafeExpr(rhs, usageIndex, decls, depth + 1);
  }

  return false;
}

// Does `expr` confidently resolve to a real repo root (import.meta.dirname /
// __dirname / process.cwd(), or a variable derived from one)? Gates the
// multi-segment join() reconstruction in isUnsafeDataPathExpr: without this,
// an UNRESOLVABLE base (a template literal, a function param, string
// concatenation) was being treated as "assume real repo root" by default,
// which false-positived on e.g. `${seedDir}-writer` in
// scripts/lib/reconcile-coverage.test.mjs — seedDir traces to mkdtempSync,
// but the template-literal concatenation isn't statically resolvable, and an
// unresolvable base must mean "unknown", never "assume unsafe".
function isKnownRealRootExpr(expr, usageIndex, decls, depth = 0) {
  if (depth > MAX_RESOLVE_DEPTH) return false;
  const trimmed = String(expr).trim();

  if (REAL_ROOT_HINT_RE.test(trimmed)) return true;

  const joinCall = trimmed.match(/^(?:path\s*\.\s*)?join\s*\(/);
  if (joinCall) {
    const openIdx = trimmed.indexOf('(');
    const innerArgs = splitArgs(extractCallArgs(trimmed, openIdx));
    return innerArgs.some((a) => isKnownRealRootExpr(a, usageIndex, decls, depth + 1));
  }

  if (/^\w+$/.test(trimmed)) {
    const rhs = resolveIdentifierRhs(trimmed, usageIndex, decls);
    if (rhs === null) return false;
    return isKnownRealRootExpr(rhs, usageIndex, decls, depth + 1);
  }

  return false;
}

// Does `expr` statically resolve to a real tracked data/*.json path that is
// NOT tmp-safe? Returns false (not just "unsafe=false" but genuinely
// "unresolvable, so don't flag") for anything this heuristic can't trace —
// see KNOWN GAPS above.
function isUnsafeDataPathExpr(expr, usageIndex, decls, depth = 0) {
  if (depth > MAX_RESOLVE_DEPTH) return false;
  const trimmed = String(expr).trim();

  const strMatch = trimmed.match(/^(['"`])(.*)\1$/s);
  if (strMatch) {
    if (ABS_TMP_ROOT_RE.test(trimmed)) return false;
    if (isAbsoluteDataJsonLiteral(trimmed)) return true;
    return DATA_JSON_RE.test(`'${strMatch[2]}'`);
  }

  const joinCall = trimmed.match(/^(?:path\s*\.\s*)?join\s*\(/);
  if (joinCall) {
    const openIdx = trimmed.indexOf('(');
    const innerArgs = splitArgs(extractCallArgs(trimmed, openIdx));
    if (innerArgs.some((a) => isTmpSafeExpr(a, usageIndex, decls, depth + 1))) return false;
    if (innerArgs.some((a) => isUnsafeDataPathExpr(a, usageIndex, decls, depth + 1))) return true;

    // A single-segment 'data/foo.json' literal is caught above; a real path
    // is just as often spread across multiple join() segments —
    // join(ROOT, 'data', 'shows.json') — where no single segment alone
    // contains the full 'data/...json' shape. Reconstruct the path from the
    // literal segments and test the joined shape — but ONLY when every
    // non-literal arg (the base) is a CONFIRMED real root, not merely
    // "not provably tmp-safe". An unresolvable base (template literal,
    // string concat, function param) is unknown, not "assume real root" —
    // see isKnownRealRootExpr's docstring for the false positive this fixes.
    const nonLiteralArgs = innerArgs.filter((a) => !/^(['"`])(.*)\1$/s.test(a.trim()));
    if (!nonLiteralArgs.every((a) => isKnownRealRootExpr(a, usageIndex, decls, depth + 1))) return false;

    const literalSegments = [];
    for (const a of innerArgs) {
      const m = a.trim().match(/^(['"`])(.*)\1$/s);
      if (m) literalSegments.push(m[2]);
    }
    return literalSegments.length > 0 && DATA_JSON_TAIL_RE.test(literalSegments.join('/'));
  }

  if (/^\w+$/.test(trimmed)) {
    const rhs = resolveIdentifierRhs(trimmed, usageIndex, decls);
    if (rhs === null) return false;
    if (isTmpSafeExpr(rhs, usageIndex, decls, depth + 1)) return false;
    return isUnsafeDataPathExpr(rhs, usageIndex, decls, depth + 1);
  }

  return false;
}

// Scan one file's source text for write calls that target a real tracked
// data/*.json path. Returns an array of { line, fn, target, snippet }.
function findUnsafeDataWrites(source) {
  const decls = collectDeclarations(source);
  const findings = [];
  const lines = source.split('\n');
  const lineStarts = [0];
  for (const line of lines) lineStarts.push(lineStarts[lineStarts.length - 1] + line.length + 1);

  function lineNumberAt(idx) {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  }

  for (const fnName of Object.keys(WRITE_CALLS)) {
    const callRe = new RegExp(`\\b${fnName}\\s*\\(`, 'g');
    let m;
    while ((m = callRe.exec(source)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      const argsText = extractCallArgs(source, openIdx);
      const args = splitArgs(argsText);
      for (const argIdx of WRITE_CALLS[fnName]) {
        const arg = args[argIdx];
        if (arg === undefined) continue;
        const trimmed = arg.trim();

        // usageIndex = the call site's own position. All of a call's
        // arguments are resolved against the same site — they're a few
        // dozen characters apart at most, and a declaration between them
        // would be a false split-scope anyway (no real code declares a
        // variable in the middle of a call's argument list).
        if (isUnsafeDataPathExpr(trimmed, m.index, decls)) {
          const lineNo = lineNumberAt(m.index);
          if (INLINE_ALLOW_RE.test(lines[lineNo - 1] || '')) continue;
          findings.push({
            line: lineNo,
            fn: fnName,
            target: trimmed,
            snippet: source.slice(m.index, Math.min(source.length, openIdx + argsText.length + 1)).replace(/\s+/g, ' ').trim(),
          });
        }
      }
    }
  }
  return findings;
}

module.exports = {
  DATA_JSON_RE,
  DATA_JSON_TAIL_RE,
  ABS_TMP_ROOT_RE,
  isAbsoluteDataJsonLiteral,
  WRITE_CALLS,
  INLINE_ALLOW_RE,
  splitArgs,
  extractCallArgs,
  collectDeclarations,
  resolveIdentifierRhs,
  isTmpSafeExpr,
  isKnownRealRootExpr,
  isUnsafeDataPathExpr,
  findUnsafeDataWrites,
};
