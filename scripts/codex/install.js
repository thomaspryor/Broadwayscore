#!/usr/bin/env node
'use strict';
// scripts/codex/install.js: give this machine's Codex the same guards and reach
// Claude has in this repo. Run once per machine (or per fresh cloud container)
// before `codex exec`; it is idempotent.
//
// BRO-4745: Codex 0.160 here does not load the repo's .codex/ layer (only
// ~/.codex is read, even for a trusted project), so the repo's .codex/hooks.json
// and .codex/config.toml are the source of truth and this copies them into
// ~/.codex. The hook command only runs when the session's git root carries
// scripts/codex/hook-adapter.js, so other repos keep their own guards. The
// config keys (live web search, sandbox network) are global: every Codex
// session on the machine gets them. Skills need no install: Codex reads
// .agents/skills from the repo. --uninstall takes back exactly what was added
// (each added line is marked); the first install also keeps
// <file>.before-bro-4745.
//
// Usage: node scripts/codex/install.js [--codex-home <dir>] [--check | --uninstall]

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const MARK = '# bro-4745 codex install';

// Drop a trailing `# comment` that sits outside quotes.
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '#') return line.slice(0, i).trim();
  }
  return line.trim();
}

const HEADER_RE = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/;

// Top-level keys and [tables], as { key: value-line } / { table: { key: value-line } },
// with comments stripped so a marked line compares equal to the repo line.
function parseSimpleToml(text) {
  const top = {};
  const tables = {};
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = stripComment(raw);
    if (!line) continue;
    const t = HEADER_RE.exec(line);
    if (t) { cur = t[1].trim(); tables[cur] = tables[cur] || {}; continue; }
    if (/^\s*\[\[/.test(line)) { cur = null; continue; } // array of tables: not ours to touch
    const kv = /^([A-Za-z0-9_."-]+)\s*=/.exec(line);
    if (!kv) continue;
    (cur ? tables[cur] : top)[kv[1]] = line;
  }
  return { top, tables };
}

// Add any key the repo config sets that the home config lacks. Never overwrite
// a value the owner set by hand; report it instead. Every added line carries
// MARK so --uninstall can take exactly those lines back out.
function mergeToml(homeText, repoText) {
  const repo = parseSimpleToml(repoText);
  const home = parseSimpleToml(homeText);
  const conflicts = [];
  let out = homeText;
  const topAdds = [];
  for (const [k, line] of Object.entries(repo.top)) {
    if (!(k in home.top)) topAdds.push(`${line} ${MARK}`);
    else if (home.top[k] !== line) conflicts.push(`${k}: home has \`${home.top[k]}\`, repo wants \`${line}\``);
  }
  if (topAdds.length) {
    // Top-level keys must precede the first [table] header to stay top-level.
    const idx = out.search(/^\s*\[/m);
    const block = `${topAdds.join('\n')}\n`;
    out = idx === -1 ? `${out.replace(/\n*$/, '\n').replace(/^\n$/, '')}${block}` : `${out.slice(0, idx)}${block}${out.slice(idx)}`;
  }
  for (const [table, keys] of Object.entries(repo.tables)) {
    // The owner may set the same table inline (`t = { k = v }`) or with dotted
    // keys (`t.k = v`). Appending a [t] header then would make the file invalid
    // TOML, so leave it and report it.
    const inline = Object.keys(home.top).filter((k) => k === table || k.startsWith(`${table}.`));
    if (inline.length) {
      conflicts.push(`[${table}]: home sets it as \`${inline.map((k) => home.top[k]).join('; ')}\`, repo wants ${Object.values(keys).join('; ')}`);
      continue;
    }
    const have = home.tables[table];
    if (!have) {
      out = `${out.replace(/\n*$/, '\n')}\n[${table}] ${MARK}\n${Object.values(keys).map((l) => `${l} ${MARK}`).join('\n')}\n`;
      continue;
    }
    const lines = out.split('\n');
    const at = lines.findIndex((l) => { const m = HEADER_RE.exec(l); return m && m[1].trim() === table; });
    const adds = [];
    for (const [k, line] of Object.entries(keys)) {
      if (!(k in have)) adds.push(`${line} ${MARK}`);
      else if (have[k] !== line) conflicts.push(`[${table}] ${k}: home has \`${have[k]}\`, repo wants \`${line}\``);
    }
    if (adds.length && at >= 0) { lines.splice(at + 1, 0, ...adds); out = lines.join('\n'); }
  }
  return { text: out, conflicts };
}

// Take back exactly what mergeToml added. A table header we added stays when
// the owner has since put their own keys under it.
function unmergeToml(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.includes(MARK)) { out.push(l); continue; }
    if (HEADER_RE.test(l.replace(MARK, ''))) {
      let j = i + 1;
      let foreign = false;
      for (; j < lines.length && !HEADER_RE.test(lines[j]); j++) if (stripComment(lines[j]) && !lines[j].includes(MARK)) foreign = true;
      if (foreign) out.push(l.replace(` ${MARK}`, ''));
      else if (out.length && out[out.length - 1] === '') out.pop();
    }
  }
  return out.join('\n');
}

// Replace our own entries (marked by the adapter path) and keep anyone else's.
function mergeHooks(homeHooks, repoHooks) {
  const isOurs = (h) => /scripts\/codex\/hook-adapter\.js/.test(h.command || '');
  const out = { ...(homeHooks || {}), hooks: { ...((homeHooks && homeHooks.hooks) || {}) } };
  for (const [event, groups] of Object.entries(out.hooks)) {
    out.hooks[event] = groups.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
    if (!out.hooks[event].length) delete out.hooks[event];
  }
  for (const [event, groups] of Object.entries(repoHooks.hooks || {})) {
    out.hooks[event] = [...(out.hooks[event] || []), ...groups];
  }
  return out;
}

// Write via a temp file and rename, so a crash or a second installer never
// leaves a half-written config; keep one copy of the owner's original.
function writeAtomic(file, text) {
  const backup = `${file}.before-bro-4745`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function main() {
  const homeIdx = process.argv.indexOf('--codex-home');
  const codexHome = homeIdx > 0 ? process.argv[homeIdx + 1] : (process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const check = process.argv.includes('--check');
  const uninstall = process.argv.includes('--uninstall');
  const repoHooks = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.codex', 'hooks.json'), 'utf8'));
  const repoToml = fs.readFileSync(path.join(REPO_ROOT, '.codex', 'config.toml'), 'utf8');
  const hooksPath = path.join(codexHome, 'hooks.json');
  const tomlPath = path.join(codexHome, 'config.toml');
  const homeHooks = fs.existsSync(hooksPath) ? JSON.parse(fs.readFileSync(hooksPath, 'utf8')) : {};
  const homeToml = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, 'utf8') : '';

  if (uninstall) {
    writeAtomic(hooksPath, JSON.stringify(mergeHooks(homeHooks, { hooks: {} }), null, 2) + '\n');
    writeAtomic(tomlPath, unmergeToml(homeToml));
    console.log(`Removed this repo's Codex hooks and config lines from ${codexHome}.`);
    return;
  }

  const hooksOut = JSON.stringify(mergeHooks(homeHooks, repoHooks), null, 2) + '\n';
  const toml = mergeToml(homeToml, repoToml);
  const hooksStale = !fs.existsSync(hooksPath) || fs.readFileSync(hooksPath, 'utf8') !== hooksOut;
  const tomlStale = toml.text !== homeToml;

  if (check) {
    if (hooksStale || tomlStale) {
      console.error(`Codex not set up for this repo (${[hooksStale && 'hooks', tomlStale && 'config'].filter(Boolean).join(', ')}). Run: node scripts/codex/install.js`);
      process.exit(1);
    }
    console.log('Codex guards and config are installed.');
    return;
  }
  fs.mkdirSync(codexHome, { recursive: true });
  if (hooksStale) writeAtomic(hooksPath, hooksOut);
  if (tomlStale) writeAtomic(tomlPath, toml.text);
  console.log(`Codex hooks ${hooksStale ? 'installed' : 'already current'} at ${hooksPath}; config ${tomlStale ? 'updated' : 'already current'} at ${tomlPath}.`);
  for (const c of toml.conflicts) console.log(`  left as is (set by hand): ${c}`);
}

if (require.main === module) main();

module.exports = { parseSimpleToml, mergeToml, unmergeToml, mergeHooks };
