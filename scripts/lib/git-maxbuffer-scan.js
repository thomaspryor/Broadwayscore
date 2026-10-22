'use strict';
/**
 * git-maxbuffer-scan.js (BRO-3156) — pure scanner behind
 * scripts/audit-git-show-maxbuffer.js.
 *
 * execFileSync's default 1MB maxBuffer throws ENOBUFS on a large tracked file.
 * Callers that wrap the call in try/catch and treat any failure as "absent"
 * silently misreport a real file as missing. This finds every
 * execFileSync('git', ['<output-heavy subcommand>', ...]) call whose statement
 * carries no maxBuffer option.
 */

const SUBCOMMANDS = ['show', 'cat-file', 'ls-tree', 'diff', 'log'];

const CALL_RE = new RegExp(
  "\\bexecFileSync\\s*\\(\\s*['\"`]git['\"`]\\s*,\\s*\\[\\s*(?:(?:['\"`]-[^'\"`]*['\"`]|[A-Za-z_$][\\w$.]*)\\s*,\\s*)*['\"`](" +
    SUBCOMMANDS.join('|') + ")['\"`]",
  'g'
);

// Index just past the ')' matching the '(' at openIdx. Skips string/template
// literals and comments so a ')' inside a ref string cannot end the call early.
function findCallEnd(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return src.length; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) return src.length; i++; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return src.length;
}

// Calls whose stdout cannot be large: existence/type probes, ignored stdout,
// name-only listings, single-commit log formats.
function isBoundedOutput(sub, stmt) {
  if (/stdio\s*:\s*(?:'ignore'|"ignore"|\[\s*['"]\w+['"]\s*,\s*['"]ignore['"])/.test(stmt)) return true;
  if (sub === 'cat-file') return /\[\s*['"]cat-file['"]\s*,\s*(?:['"]-[ets]['"]|fileOnly\s*\?\s*['"]-t['"])/.test(stmt);
  if (sub === 'diff') return /--name-only|--name-status|--numstat|--quiet|--shortstat/.test(stmt);
  if (sub === 'log') return /['"]-1['"]|['"]-n['"]\s*,\s*['"]1['"]|--max-count=1['"]/.test(stmt);
  return false;
}

/** @returns {{line:number, sub:string, snippet:string}[]} */
function scanSource(src) {
  const out = [];
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (/^\s*(\*|\/\/)/.test(src.slice(lineStart, m.index + 1))) continue;
    const open = src.indexOf('(', m.index);
    const stmt = src.slice(m.index, findCallEnd(src, open));
    const code = stmt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    if (/\bmaxBuffer\b/.test(code)) continue;
    if (isBoundedOutput(m[1], stmt)) continue;
    // Options passed as a bare identifier (`..., opts)`): accept when the file
    // defines that identifier alongside a maxBuffer.
    const idArg = /,\s*([A-Za-z_$][\w$]*)\s*\)\s*$/.exec(stmt);
    if (idArg && new RegExp('\\b' + idArg[1].replace(/\$/g, '\\$') + '\\b[^;]*?maxBuffer', 's').test(src)) continue;
    out.push({
      line: src.slice(0, m.index).split('\n').length,
      sub: m[1],
      snippet: stmt.replace(/\s+/g, ' ').slice(0, 140),
    });
  }
  return out;
}

const SCAN_DIRS = ['scripts', 'src', 'tests', 'tools', '.github', '.claude/hooks'];
const SKIP = new Set(['node_modules', '.next', '.git', 'worktrees', 'out']);

function* walk(dir) {
  const fs = require('fs');
  const path = require('path');
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(js|mjs|cjs)$/.test(e.name) && !/\.test\.(js|mjs|cjs)$/.test(e.name)) yield p;
  }
}

/** Scan every non-test script under root; returns [{file, line, sub, snippet}]. */
function scanTree(root) {
  const fs = require('fs');
  const path = require('path');
  const findings = [];
  for (const d of SCAN_DIRS) {
    for (const f of walk(path.join(root, d))) {
      for (const hit of scanSource(fs.readFileSync(f, 'utf8'))) {
        findings.push({ file: path.relative(root, f), ...hit });
      }
    }
  }
  return findings;
}

module.exports = { scanSource, scanTree, SUBCOMMANDS };
