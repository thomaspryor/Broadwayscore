'use strict';
// BRO-2484: pure logic for scripts/audit-guard-call-sites.js.
// A guard unit test proves the guard works; it does NOT prove the shipping
// script still calls it (the 2026-08 pre-send banner leak: stripPreSendBanner
// was unit-tested but the call site in create-broadcast-draft.mjs was not).
// This flags audience-facing guards that have a unit test but no test that
// exercises a real call-site script (spawn/exec/import of that entry script).
// Scope (owner triage): audience-facing guards only, advisory.

const fs = require('fs');
const path = require('path');

const GUARD_NAME_RE = /^(strip|guard|validate|assert|check|sanitize|sanitise|redact|scrub|block|reject)[A-Z_]/;
// Heuristic scope: the lib FILE NAME says it serves email/newsletter/audience output.
const AUDIENCE_FILE_RE = /subscriber|audience|broadcast|newsletter|pre-?send|digest|email/i;
// Explicit allowlist: guards known to gate subscriber/audience output even if
// the heuristic (name pattern AND audience wording in the lib file) misses them.
const ALLOWLIST = [{ file: 'scripts/lib/pre-send-banner.js', name: 'stripPreSendBanner' }];
const SPAWN_RE = /\b(execFileSync|execFile|spawnSync|spawn|execSync|exec|fork)\s*\(/;

/** Names listed in `module.exports = { a, b: x }` / `exports.a =` / `module.exports.a =`. */
function exportedNames(src) {
  const names = new Set();
  const block = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\}\s*;?/);
  if (block) {
    for (const part of block[1].replace(/\/\/.*$/gm, '').split(',')) {
      const m = part.trim().match(/^([A-Za-z_$][\w$]*)/);
      if (m) names.add(m[1]);
    }
  }
  for (const m of src.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  return [...names];
}

function isAudienceGuard(rel, name, _src, allowlist = ALLOWLIST) {
  if (allowlist.some(a => a.file === rel && a.name === name)) return true;
  return GUARD_NAME_RE.test(name) && AUDIENCE_FILE_RE.test(path.basename(rel));
}

const base = rel => path.basename(rel);
const mentions = (src, rel) => src.includes(rel) || src.includes(base(rel));
const usesName = (src, name) => new RegExp(`\\b${name}\\b`).test(src);

/** True when a test proves the entry script's call site: names it AND spawns or imports it. */
function provesCallSite(testSrc, entryRel) {
  if (!mentions(testSrc, entryRel)) return false;
  if (SPAWN_RE.test(testSrc)) return true;
  const b = base(entryRel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:import[^;]*from|import\\(|require\\()\\s*[^;)]*${b}`).test(testSrc);
}

/**
 * Pure. libFiles/scriptFiles/testFiles: { relPath: source }.
 * Returns { checked: [...], findings: [...] }; a finding is a guard that has a
 * unit test using it but no test proving any of its call sites.
 */
function evaluateGuards({ libFiles, scriptFiles, testFiles, allowlist = ALLOWLIST }) {
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
