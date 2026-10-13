#!/usr/bin/env node
/**
 * audit-set-u-expansions — find `set -u` shell scripts with array expansions
 * that crash on macOS bash 3.2 when the array is empty (BRO-2555).
 *
 * bash 3.2 (stock /bin/bash on macOS, never upgraded) treats "${arr[@]}" on a
 * zero-element array as an unbound variable under `set -u`. Fixed upstream in
 * bash 4.4, so Linux CI never sees it; the Mac's cron and hook runs do. Two
 * live crashes were found by tripping over them (BRO-2186
 * gc-merged-worktrees.sh, BRO-2554 push-with-retry.sh) before this sweep.
 *
 * An expansion is SAFE when any of these holds:
 *   - it is guarded: ${arr[@]+"${arr[@]}"} (slices too: ${arr[@]+"${arr[@]:1}"}),
 *     ${arr[@]:-…}, ${arr[@]-…}
 *   - it is a count or key list: ${#arr[@]}, ${!arr[@]}
 *   - every assignment to the array in the file is a literal, non-empty list
 *     (`arr=(a b c)`, no `$`, no `+=`-only, never `arr=()`/read -a/mapfile)
 *   - the line, or one of the 3 lines above it, carries `# set-u-safe: <why>`
 * Anything else is reported. Fix with the ${arr[@]+"${arr[@]}"} idiom (see
 * scripts/gc-merged-worktrees.sh) or annotate with the reason it can't be
 * empty.
 *
 * Arithmetic: BRO-2554's variant was a CLI argument (MAX_RETRIES=${1:-7})
 * reaching $(( )) unvalidated, where a non-numeric value is read as a
 * variable name and trips `set -u`. Reported when a variable assigned from a
 * positional parameter is used in $(( )) / (( )) and the file never tests it
 * with `=~` or a `case "$VAR" in` block. Same annotation silences it.
 *
 * Report-only by default (exit 0). --strict exits 1 on findings.
 * Usage: node scripts/lib/audit-set-u-expansions.js [--strict] [--json] [files...]
 * Wrapper: scripts/audit-set-u-expansions.sh. Tests:
 * scripts/lib/audit-set-u-expansions.test.mjs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SAFE_MARK_RE = /#\s*set-u-safe:\s*\S/;
const SAFE_MARK_LOOKBACK = 3;

/** True when the script enables nounset (set -u / -eu / -o nounset, or a -u shebang). */
function usesSetU(src) {
  return /^\s*set\s+-[a-zA-Z]*u[a-zA-Z]*\b/m.test(src)
    || /^\s*set\s+(?:-[a-zA-Z]+\s+)*-o\s+nounset\b/m.test(src)
    || /^#!.*\bbash\b.*\s-[a-zA-Z]*u/.test(src);
}

/** Strip a trailing comment (a `#` preceded by whitespace, outside quotes). Heuristic. */
function stripComment(line) {
  let sq = false;
  let dq = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && !sq) { i++; continue; }
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (c === '#' && !sq && !dq && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/**
 * Arrays whose every assignment is a literal non-empty list, so they can never
 * be empty at an expansion site.
 */
function alwaysNonEmptyArrays(lines) {
  const verdict = new Map(); // name -> bool
  const mark = (name, ok) => verdict.set(name, (verdict.has(name) ? verdict.get(name) : true) && ok);
  for (const raw of lines) {
    const line = stripComment(raw);
    for (const m of line.matchAll(/(?:^|[\s;(])(?:local\s+|declare\s+(?:-[a-zA-Z]+\s+)*|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)=\(([^)]*)\)?/g)) {
      const body = (m[2] || '').trim();
      mark(m[1], body.length > 0 && !body.includes('$') && !body.includes('`'));
    }
    for (const m of line.matchAll(/\b(?:read\s+(?:-[a-zA-Z]+\s+)*-a\s+|mapfile\s+(?:-[a-zA-Z]+\s+(?:\S+\s+)?)*|readarray\s+(?:-[a-zA-Z]+\s+(?:\S+\s+)?)*)([A-Za-z_][A-Za-z0-9_]*)/g)) {
      mark(m[1], false);
    }
    for (const m of line.matchAll(/\b(?:local|declare(?:\s+-[a-zA-Z]+)*)\s+([A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*)*)\s*(?:$|;)/g)) {
      for (const name of m[1].trim().split(/\s+/)) mark(name, false); // declared without a value
    }
  }
  return new Set([...verdict].filter(([, ok]) => ok).map(([n]) => n));
}

function annotated(lines, idx) {
  for (let j = idx; j >= Math.max(0, idx - SAFE_MARK_LOOKBACK); j--) {
    if (SAFE_MARK_RE.test(lines[j])) return true;
  }
  return false;
}

/** Unguarded ${arr[@]} / ${arr[*]} sites in one script's source. */
function findArrayFindings(src) {
  const lines = src.split('\n');
  const nonEmpty = alwaysNonEmptyArrays(lines);
  const out = [];
  let heredocEnd = null;
  lines.forEach((raw, idx) => {
    if (heredocEnd) {
      if (raw.trim() === heredocEnd) heredocEnd = null;
      return;
    }
    const hd = raw.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (/^\s*#/.test(raw)) return;
    const line = stripComment(raw);
    // Mask guarded forms so only bare expansions remain.
    const masked = line
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]\+("?)\$\{\1\[[@*]\](?::[^}]*)?\}\2\}/g, '')
      .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\[[@*]\](?::?[-+=?])/g, '')
      .replace(/\$\{[#!][A-Za-z_][A-Za-z0-9_]*\[[@*]\]\}/g, '');
    for (const m of masked.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\[([@*])\](?:[:/%#^,][^}]*)?\}/g)) {
      const name = m[1];
      if (nonEmpty.has(name)) continue;
      if (annotated(lines, idx)) continue;
      out.push({ line: idx + 1, kind: 'array', name, text: raw.trim() });
    }
    if (hd && !/<<</.test(raw)) heredocEnd = hd[1];
  });
  return out;
}

/** Positional-parameter-fed variables reaching arithmetic without validation. */
function findArithmeticFindings(src) {
  const lines = src.split('\n');
  const fed = new Set();
  for (const raw of lines) {
    const line = stripComment(raw);
    const m = line.match(/^\s*(?:local\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)=["']?\$\{?([1-9])\b/);
    if (m) fed.add(m[1]);
  }
  if (!fed.size) return [];
  const validated = new Set();
  for (const name of fed) {
    const re = new RegExp(String.raw`(?:\[\[\s*(?:!\s*)?"?\$\{?${name}\}?"?\s*=~)|(?:case\s+"?\$\{?${name}\}?"?\s+in)`);
    if (re.test(src)) validated.add(name);
  }
  const out = [];
  lines.forEach((raw, idx) => {
    if (/^\s*#/.test(raw)) return;
    const line = stripComment(raw);
    for (const am of line.matchAll(/\(\(([^()]*(?:\([^()]*\)[^()]*)*)\)\)/g)) {
      for (const name of fed) {
        if (validated.has(name)) continue;
        if (!new RegExp(String.raw`(?:^|[^A-Za-z0-9_])\$?\{?${name}\}?(?:[^A-Za-z0-9_]|$)`).test(am[1])) continue;
        if (annotated(lines, idx)) continue;
        out.push({ line: idx + 1, kind: 'arithmetic', name, text: raw.trim() });
      }
    }
  });
  return out;
}

/** All findings for one file's source; [] when the file does not use set -u. */
function auditSource(src) {
  if (!usesSetU(src)) return [];
  return [...findArrayFindings(src), ...findArithmeticFindings(src)].sort((a, b) => a.line - b.line);
}

/** Tracked *.sh files (plus extensionless bash scripts under scripts/hooks). */
function listShellFiles(repoRoot) {
  let files;
  try {
    files = execFileSync('git', ['-C', repoRoot, 'ls-files', '*.sh', 'scripts/hooks/*'], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch {
    return [];
  }
  return files.filter((f) => {
    if (f.endsWith('.sh')) return true;
    try { return /^#!.*\bbash\b/.test(fs.readFileSync(path.join(repoRoot, f), 'utf8').split('\n', 1)[0]); } catch { return false; }
  });
}

function main(argv = process.argv.slice(2), { repoRoot = path.resolve(__dirname, '..', '..'), log = console.log } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    log('Usage: audit-set-u-expansions [--strict] [--json] [files...]\n'
      + 'Reports set -u shell scripts with unguarded array expansions (bash 3.2 empty-array crash)\n'
      + 'or positional-fed variables in arithmetic. Report-only unless --strict.');
    return 0;
  }
  const strict = argv.includes('--strict');
  const json = argv.includes('--json');
  const explicit = argv.filter((a) => !a.startsWith('--'));
  const files = explicit.length ? explicit : listShellFiles(repoRoot);
  const report = [];
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(path.isAbsolute(f) ? f : path.join(repoRoot, f), 'utf8'); } catch { continue; }
    for (const finding of auditSource(src)) report.push({ file: f, ...finding });
  }
  if (json) {
    log(JSON.stringify(report, null, 2));
  } else if (!report.length) {
    log(`audit-set-u-expansions: OK (${files.length} shell file(s) scanned, no unguarded expansions)`);
  } else {
    for (const r of report) log(`${r.file}:${r.line}: ${r.kind} ${r.name}: ${r.text}`);
    log(`\naudit-set-u-expansions: ${report.length} finding(s). Fix arrays with \${arr[@]+"\${arr[@]}"}, `
      + 'validate positional input before arithmetic, or annotate `# set-u-safe: <why>`.');
  }
  return strict && report.length ? 1 : 0;
}

module.exports = {
  usesSetU,
  stripComment,
  alwaysNonEmptyArrays,
  findArrayFindings,
  findArithmeticFindings,
  auditSource,
  listShellFiles,
  main,
};

if (require.main === module) process.exit(main());
