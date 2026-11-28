'use strict';
// BRO-2688: orphan-audit detector. BRO-2620 found an audit-*.js script that
// wrote a report while nothing in CI ran or read it. This lists every
// scripts/audit-*.js that no workflow, composite action, package.json script
// or other non-test code references, so a new one cannot land unclassified.
// JSON files other than package.json are never read (lint baselines list
// every script name and would clear everything). Known gap: a workflow that
// builds the script name dynamically is invisible here.
// docs/triage-audit-scripts.md holds the reasoning for each baseline entry.

const fs = require('fs');
const path = require('path');

const CODE_DIRS = ['scripts', '.claude', 'src'];
const CODE_EXT = /\.(js|mjs|cjs|sh|ts|tsx|yml|yaml)$/;
const SKIP_DIR = new Set(['node_modules', '.next', 'worktrees', '.git']);

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (CODE_EXT.test(e.name)) out.push(p);
  }
}

// test.yml lists scripts in its on.push.paths trigger ("- 'scripts/x.js'"),
// which proves nothing runs the script. Only count a test.yml line that is not
// a bare path-list entry.
function isPathTriggerLine(line) {
  return /^\s*-\s*['"]?[\w./-]+\.(js|mjs|sh)['"]?\s*$/.test(line);
}

// Comment-only mentions are not wiring ("pure helpers behind audit-x.js").
// Drops whole-line comments (// * /* #) and trailing " # ..." in shell/yaml.
function stripComments(text) {
  return text.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l))
    .map((l) => l.replace(/\s#\s.*$/, ''))
    .join('\n');
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function findUnreferencedAuditScripts(root) {
  const scriptsDir = path.join(root, 'scripts');
  const audits = fs.readdirSync(scriptsDir).filter((f) => /^audit-.*\.js$/.test(f));

  const workflowsDir = path.join(root, '.github', 'workflows');
  const workflowTexts = [];
  for (const f of fs.existsSync(workflowsDir) ? fs.readdirSync(workflowsDir) : []) {
    if (!/\.ya?ml$/.test(f)) continue;
    let text = stripComments(readIfExists(path.join(workflowsDir, f)));
    if (f === 'test.yml') text = text.split('\n').filter((l) => !isPathTriggerLine(l)).join('\n');
    workflowTexts.push(text);
  }
  const actionsDir = path.join(root, '.github', 'actions');
  const actionTexts = [];
  for (const d of fs.existsSync(actionsDir) ? fs.readdirSync(actionsDir) : []) {
    actionTexts.push(stripComments(readIfExists(path.join(actionsDir, d, 'action.yml'))));
  }
  const infra = workflowTexts.concat(actionTexts, [readIfExists(path.join(root, 'package.json'))]).join('\n');

  const codeFiles = [];
  for (const d of CODE_DIRS) walk(path.join(root, d), codeFiles);
  const codeTexts = codeFiles
    .filter((p) => !/\.test\.(m?js|ts)$/.test(p))
    .map((p) => ({ p, text: stripComments(fs.readFileSync(p, 'utf8')) }));

  return audits.filter((f) => {
    if (infra.includes(f)) return false;
    const stem = f.replace(/\.js$/, '');
    const self = path.join(scriptsDir, f);
    return !codeTexts.some(({ p, text }) => p !== self && (text.includes(f) || text.includes(`/${stem}'`) || text.includes(`/${stem}"`)));
  }).sort();
}

module.exports = { findUnreferencedAuditScripts, isPathTriggerLine };
