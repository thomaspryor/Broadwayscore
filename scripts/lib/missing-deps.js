'use strict';

// BRO-5431: inspect source, never require the audited scripts (many send email
// or scrape on import). This intentionally checks module initialization only,
// not arbitrary function calls, computed require paths, or shell scripts.
const fs = require('fs');
const path = require('path');
const { isBuiltin } = require('module');
const { readWorkflowJobBlocks, splitWorkflowSteps, runLineMatches } = require('./audit-workflow-hygiene-rules');

function sourceRequires(source) {
  const acorn = require('acorn'); // Direct devDependency, installed by lint-workflows.
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowReturnOutsideFunction: true });
  } catch {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  }
  const found = [];
  function visit(node, kind = 'eager', invoked = false) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) visit(child, kind); return; }
    if (!invoked && /^(Function|ArrowFunction)/.test(node.type)) kind = 'lazy';
    if (node.type === 'CallExpression' && /^(FunctionExpression|ArrowFunctionExpression)$/.test(node.callee.type)) {
      visit(node.callee, kind, true);
      visit(node.arguments, kind);
      return;
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require'
      && node.arguments.length === 1 && typeof node.arguments[0].value === 'string') {
      found.push({ specifier: node.arguments[0].value, kind, line: node.loc.start.line });
    }
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      if (node.source) found.push({ specifier: node.source.value, kind, line: node.loc.start.line });
    }
    for (const [key, child] of Object.entries(node)) {
      // A catch guards only its try block. Requires in catch/finally can throw.
      const next = node.type === 'TryStatement' && key === 'block' && node.handler && kind === 'eager' ? 'guarded' : kind;
      if (key !== 'loc') visit(child, next);
    }
  }
  visit(ast);
  return found;
}

function resolveLocal(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  for (const suffix of ['', '.js', '.cjs', '.mjs', '.json', '/index.js', '/index.cjs']) {
    const file = base + suffix;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

function dependencyGraph(entry, cache = new Map()) {
  const packages = [];
  const errors = [];
  const seen = new Set();
  function walk(file, inherited, chain) {
    const key = file + ':' + inherited;
    if (seen.has(key) || file.endsWith('.json')) return;
    seen.add(key);
    if (!cache.has(file)) {
      try { cache.set(file, { requires: sourceRequires(fs.readFileSync(file, 'utf8')) }); }
      catch (err) { cache.set(file, { error: err.message }); }
    }
    const parsed = cache.get(file);
    if (parsed.error) { errors.push({ file, error: parsed.error }); return; }
    for (const dep of parsed.requires) {
      const kind = inherited === 'eager' ? dep.kind : inherited;
      const nextChain = [...chain, { file, line: dep.line, specifier: dep.specifier }];
      if (dep.specifier.startsWith('.')) {
        const local = resolveLocal(file, dep.specifier);
        if (local) walk(local, kind, nextChain);
        else if (kind === 'eager') errors.push({ file, error: `Unresolved local module: ${dep.specifier}` });
      } else if (!isBuiltin(dep.specifier) && !path.isAbsolute(dep.specifier)) {
        const name = dep.specifier.startsWith('@') ? dep.specifier.split('/').slice(0, 2).join('/') : dep.specifier.split('/')[0];
        packages.push({ package: name, kind, chain: nextChain });
      }
    }
  }
  walk(path.resolve(entry), 'eager', []);
  return { packages, errors };
}

// Small shell lexer: quoted arguments stay arguments, comments and heredoc
// bodies never become commands. No evaluation, command execution or network IO.
function shellCommands(source) {
  const commands = [];
  let words = [], word = '', quote = null, heredoc = null;
  const flushWord = () => { if (word) words.push(word); word = ''; };
  const flush = () => { flushWord(); if (words.length) commands.push(words); words = []; };
  for (const line of source.replace(/\\\n/g, '').split('\n')) {
    if (heredoc) { if (line.trim() === heredoc) heredoc = null; continue; }
    let nextHeredoc = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '\\' && quote !== "'") { word += line[++i] || ''; continue; }
      if (quote) { if (c === quote) quote = null; else word += c; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '#' && !word) break;
      if (c === '<' && line[i + 1] === '<') {
        const match = line.slice(i).match(/^<<-?\s*['"]?(\w+)['"]?/);
        if (match) { nextHeredoc = match[1]; i += match[0].length - 1; continue; }
      }
      if (/[;&|()]/.test(c)) { flush(); continue; }
      if (/\s/.test(c)) flushWord(); else word += c;
    }
    if (!quote) flush(); else word += '\n';
    heredoc = nextHeredoc;
  }
  flush();
  return commands;
}

function commandEvents(source) {
  const events = [];
  for (const words of shellCommands(source)) {
    let i = 0;
    while (/^(?:env|if|then|do|[A-Za-z_]\w*=.*)$/.test(words[i] || '')) i++;
    if (words[i] === 'timeout') i += 2;
    if (words[i] === 'node' || words[i] === 'nodejs') {
      i++;
      while (/^--(?:no-warnings|experimental-[\w-]+)$/.test(words[i] || '')) i++;
      if (/^(?:\.\/)?scripts\/[\w./-]+\.(?:js|cjs|mjs)$/.test(words[i] || '')) {
        events.push({ type: 'script', script: words[i].replace(/^\.\//, '') });
      }
    } else if (words[i] === 'npm' && /^(?:ci|install)$/.test(words[i + 1] || '')) {
      const args = words.slice(i + 2);
      // Installing a named package, in a different directory, or without dev
      // dependencies is not proof that the repo's entire graph is available.
      if (args.every(arg => /^--(?:ignore-scripts|no-audit|no-fund|prefer-offline)$/.test(arg))) events.push({ type: 'install' });
    }
  }
  return events;
}

// Prove only simple boolean implications. An install gated by A is available
// to A && B, but not to B alone. DNF also handles an install gated by A || B.
// Unknown/overly complex expressions stay unproven rather than hiding a gap.
function conditionCovered(scriptCondition, installCondition) {
  if (installCondition === 'true') return true;
  try {
    const acorn = require('acorn');
    function terms(source) {
      const ast = acorn.parseExpressionAt(source, 0, { ecmaVersion: 'latest' });
      function expand(node) {
        if (node.type === 'LogicalExpression') {
          const left = expand(node.left), right = expand(node.right);
          if (left.length * right.length > 64) throw new Error('condition too complex');
          return node.operator === '&&' ? left.flatMap(a => right.map(b => [...a, ...b])) : [...left, ...right];
        }
        return [[JSON.stringify(node, (key, value) => key === 'start' || key === 'end' || key === 'raw' ? undefined : value)]];
      }
      return expand(ast);
    }
    const installedWhen = terms(installCondition);
    return terms(scriptCondition).every(clause => installedWhen.some(required => required.every(atom => clause.includes(atom))));
  } catch { return false; }
}

function auditWorkflow(raw, { root, cache = new Map() }) {
  const findings = [], errors = [], scripts = [];
  for (const [job, lines] of Object.entries(readWorkflowJobBlocks(raw))) {
    const installs = [];
    for (const step of splitWorkflowSteps('jobs:\n' + lines.join('\n'))) {
      const text = step.lines.filter(line => !line.trimStart().startsWith('#')).join('\n');
      const condition = (text.match(/^\s*(?:- )?if:\s*(.+)$/m)?.[1] || 'true').trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
      const failureSetting = text.match(/^\s*(?:- )?continue-on-error:\s*([^\n#]+)/m)?.[1].trim();
      const toleratesFailure = failureSetting !== undefined && failureSetting !== 'false';
      const subdirectory = /^\s*(?:- )?working-directory:/m.test(text)
        || /^\s*defaults:\s*\n\s*run:\s*\n\s*working-directory:/m.test(raw);
      if (!toleratesFailure && /(?:^|\n)\s*(?:- )?uses:\s*['"]?\.\/\.github\/actions\/setup-node(?:['"\s]|$)/.test(text)) installs.push(condition);
      const run = runLineMatches(text, /./).map(hit => hit.text.replace(/^\s*(?:- )?run:\s*/, '').trim());
      const events = commandEvents(run.map(line => /^(['"]).*\1$/.test(line) ? line.slice(1, -1) : line).join('\n'));
      const changesDirectory = events.length && /(?:^|\n)\s*cd\s+/m.test(run.join('\n'));
      const installSource = run.join('\n').replace(/npm\s+ci\s*\|\|\s*npm\s+install\b/g, 'npm ci');
      const shellConditional = /(?:^|\n)\s*(?:if|for|while|until|case)\b|\|\||&&\s*npm\s+(?:ci|install)\b/.test(installSource);
      for (const event of events) {
        if (event.type === 'install') {
          if (!toleratesFailure && !subdirectory && !changesDirectory && !shellConditional) installs.push(condition);
          continue;
        }
        const installed = installs.some(when => conditionCovered(condition, when));
        const graph = dependencyGraph(path.join(root, event.script), cache);
        scripts.push({ job, script: event.script, installed, packages: graph.packages });
        if (installed) continue;
        for (const error of graph.errors) errors.push({ job, script: event.script, ...error });
        const eager = graph.packages.filter(dep => dep.kind === 'eager');
        const unique = [...new Set(eager.map(dep => dep.package))].sort();
        if (unique.length) findings.push({ job, script: event.script, packages: unique, chains: eager.map(dep => dep.chain) });
      }
    }
  }
  return { findings, errors, scripts };
}

function auditDirectory(directory, root) {
  const cache = new Map();
  const findings = [], errors = [], scripts = [];
  for (const file of fs.readdirSync(directory).filter(file => /\.ya?ml$/.test(file)).sort()) {
    const result = auditWorkflow(fs.readFileSync(path.join(directory, file), 'utf8'), { root, cache });
    for (const key of ['findings', 'errors', 'scripts']) {
      ({ findings, errors, scripts })[key].push(...result[key].map(row => ({ workflow: file, ...row })));
    }
  }
  return { findings, errors, scripts };
}

module.exports = { sourceRequires, dependencyGraph, commandEvents, conditionCovered, auditWorkflow, auditDirectory };
