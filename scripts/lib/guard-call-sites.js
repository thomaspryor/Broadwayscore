'use strict';
// BRO-2484: pure logic for scripts/audit-guard-call-sites.js.
// A guard unit test proves the guard works; it does NOT prove the shipping
// script still calls it (the 2026-08 pre-send banner leak: stripPreSendBanner
// was unit-tested but the call site in create-broadcast-draft.mjs was not).
// This flags audience-facing guards that have a unit test but no test that
// exercises a real call-site script (spawn/exec/import of that entry script).
// Scope (owner triage): audience-facing guards only, advisory.
//
// CAVEAT: "proven" here means a test spawns or imports the call-site script
// (path appears inside the spawn/import argument). It does NOT prove the guard
// actually ran or that its result was honoured. Static, advisory heuristic.

const fs = require('fs');
const path = require('path');

const GUARD_NAME_RE = /^(strip|guard|validate|assert|check|sanitize|sanitise|redact|scrub|block|reject)[A-Z_]/;
// Heuristic scope: the lib FILE NAME says it serves email/newsletter/audience output.
const AUDIENCE_FILE_RE = /subscriber|audience|broadcast|newsletter|pre-?send|digest|email/i;
// Explicit allowlist: guards known to gate subscriber/audience output even if
// the heuristic (name pattern AND audience wording in the lib file) misses them.
const ALLOWLIST = [{ file: 'scripts/lib/pre-send-banner.js', name: 'stripPreSendBanner' }];
// (?<![.\w]) so `/re/.exec(` and `obj.spawn(` are not process spawns.
const SPAWN_RE = /(?<![.\w])(execFileSync|execFile|spawnSync|spawn|execSync|exec|fork)\s*\(/g;
// This audit's own test names every fixture; it must never count as proof.
const SELF_EXCLUDE = new Set(['tests/unit/audit-guard-call-sites.test.mjs']);
const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Index of the `}` matching the `{` at `open` (skips strings/comments loosely). */
function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) break; i++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Names exported via `module.exports = { ... }` (top nesting level only) / `exports.a =`. */
function exportedNames(src) {
  const names = new Set();
  const m = /module\.exports\s*=\s*\{/.exec(src);
  if (m) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(src, open);
    const body = src.slice(open + 1, close < 0 ? src.length : close);
    let depth = 0, seg = '';
    const flush = () => {
      const k = seg.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().match(/^(?:\.\.\.)?([A-Za-z_$][\w$]*)/);
      if (k) names.add(k[1]);
      seg = '';
    };
    for (const c of body) {
      if ('{[('.includes(c)) depth++;
      else if ('}])'.includes(c)) depth--;
      if (c === ',' && depth === 0) flush(); else seg += c;
    }
    flush();
  }
  for (const x of src.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(x[1]);
  return [...names];
}

function isAudienceGuard(rel, name, _src, allowlist = ALLOWLIST) {
  if (allowlist.some(a => a.file === rel && a.name === name)) return true;
  return GUARD_NAME_RE.test(name) && AUDIENCE_FILE_RE.test(path.basename(rel));
}

const base = rel => path.basename(rel);
const usesName = (src, name) => new RegExp(`\\b${name}\\b`).test(src);

/** Repo-relative path, or the basename anchored on a path separator/quote. */
function entryRefRe(entryRel) {
  return new RegExp(`${esc(entryRel)}(?![\\w.-])|(?<=[/'"\`])${esc(base(entryRel))}(?![\\w.-])`);
}

/** Text of the balanced (...) argument list opening at `open`. */
function argText(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** True when the entry script is named inside a spawn/exec call or an import/require argument. */
function provesCallSite(testSrc, entryRel) {
  const ref = entryRefRe(entryRel);
  for (const m of testSrc.matchAll(SPAWN_RE)) {
    if (ref.test(argText(testSrc, m.index + m[0].length - 1))) return true;
  }
  for (const m of testSrc.matchAll(/(?<![.\w])(?:require|import)\s*\(/g)) {
    if (ref.test(argText(testSrc, m.index + m[0].length - 1))) return true;
  }
  for (const m of testSrc.matchAll(/\b(?:import|export)\b[^;'"`]*?\bfrom\s*(['"`][^'"`]+['"`])/g)) {
    if (ref.test(m[1])) return true;
  }
  for (const m of testSrc.matchAll(/^\s*import\s*(['"`][^'"`]+['"`])/gm)) {
    if (ref.test(m[1])) return true;
  }
  return false;
}

/**
 * Pure. libFiles/scriptFiles/testFiles: { relPath: source }.
 * Returns { checked: [...], findings: [...] }; a finding is a guard that has a
 * unit test using it but no test proving any of its call sites.
 */
function evaluateGuards({ libFiles, scriptFiles, testFiles: allTests, allowlist = ALLOWLIST }) {
  const testFiles = Object.fromEntries(Object.entries(allTests).filter(([r]) => !SELF_EXCLUDE.has(r)));
  const checked = [];
  const findings = [];
  for (const [rel, src] of Object.entries(libFiles)) {
    for (const name of exportedNames(src)) {
      if (!isAudienceGuard(rel, name, src, allowlist)) continue;
      const libBase = base(rel).replace(/\.js$/, '');
      const unitTests = Object.entries(testFiles)
        .filter(([, t]) => usesName(t, name) && t.includes(libBase)).map(([r]) => r);
      if (!unitTests.length) continue; // no unit test requiring it: out of this audit's scope
      const callSites = Object.entries(scriptFiles)
        .filter(([r, s]) => r !== rel && !r.startsWith('scripts/lib/guard-call-sites') && usesName(s, name) && s.includes(libBase)).map(([r]) => r);
      const proven = callSites.filter(site =>
        Object.values(testFiles).some(t => provesCallSite(t, site)));
      const rec = { guard: name, lib: rel, unitTests, callSites, provenCallSites: proven };
      checked.push(rec);
      if (!proven.length) {
        findings.push({ ...rec, reason: callSites.length
          ? 'unit-tested but no test exercises its call site(s): ' + callSites.join(', ')
          : 'unit-tested but no non-test script calls it (dead guard?)' });
      }
    }
  }
  return { checked, findings };
}

function walk(root, dir, out, skip) {
  let ents;
  try { ents = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walk(root, rel, out, skip);
    else if (/\.(mjs|js|ts)$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** Reads the repo at `root` and runs evaluateGuards. */
function auditRepo(root = path.join(__dirname, '..', '..')) {
  const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
  const isTest = r => /\.test\.(mjs|js|ts)$/.test(r);
  const libFiles = {}, scriptFiles = {}, testFiles = {};
  for (const rel of walk(root, 'scripts', [])) {
    if (isTest(rel)) testFiles[rel] = read(rel);
    else if (/^scripts\/lib\/[^/]+\.js$/.test(rel)) { libFiles[rel] = read(rel); scriptFiles[rel] = libFiles[rel]; }
    else scriptFiles[rel] = read(rel);
  }
  for (const rel of walk(root, 'tests', [])) if (isTest(rel)) testFiles[rel] = read(rel);
  return evaluateGuards({ libFiles, scriptFiles, testFiles });
}

module.exports = { exportedNames, isAudienceGuard, provesCallSite, evaluateGuards, auditRepo, ALLOWLIST };
