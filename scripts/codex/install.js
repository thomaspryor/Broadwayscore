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
// scripts/codex/hook-adapter.js, so other repos on the same machine are
// unaffected. Skills need no install: Codex reads .agents/skills from the repo.
//
// Usage: node scripts/codex/install.js [--codex-home <dir>] [--check]

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Top-level keys and [tables] from the repo config, as { key: line } / { table: { key: line } }.
function parseSimpleToml(text) {
  const top = {};
  const tables = {};
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const t = /^\[(.+)\]$/.exec(line);
    if (t) { cur = t[1]; tables[cur] = tables[cur] || {}; continue; }
    const kv = /^([A-Za-z0-9_."-]+)\s*=/.exec(line);
    if (!kv) continue;
    (cur ? tables[cur] : top)[kv[1]] = line;
  }
  return { top, tables };
}

// Add any key the repo config sets that the home config lacks. Never overwrite
// a value the owner set by hand; report it instead.
function mergeToml(homeText, repoText) {
  const repo = parseSimpleToml(repoText);
  const home = parseSimpleToml(homeText);
  const conflicts = [];
  let out = homeText;
  const topAdds = [];
  for (const [k, line] of Object.entries(repo.top)) {
    if (!(k in home.top)) topAdds.push(line);
    else if (home.top[k] !== line) conflicts.push(`${k}: home has \`${home.top[k]}\`, repo wants \`${line}\``);
  }
  if (topAdds.length) {
    // Top-level keys must precede the first [table] header to stay top-level.
    const idx = out.search(/^\[/m);
    const block = `# added by scripts/codex/install.js (BRO-4745)\n${topAdds.join('\n')}\n`;
    out = idx === -1 ? `${out.replace(/\n*$/, '\n')}${block}` : `${out.slice(0, idx)}${block}\n${out.slice(idx)}`;
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
      out = `${out.replace(/\n*$/, '\n')}\n[${table}]\n${Object.values(keys).join('\n')}\n`;
      continue;
    }
    for (const [k, line] of Object.entries(keys)) {
      if (!(k in have)) {
        out = out.replace(new RegExp(`^\\[${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*$`, 'm'), (m) => `${m}\n${line}`);
      } else if (have[k] !== line) conflicts.push(`[${table}] ${k}: home has \`${have[k]}\`, repo wants \`${line}\``);
    }
  }
  return { text: out, conflicts };
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

function main() {
  const homeIdx = process.argv.indexOf('--codex-home');
  const codexHome = homeIdx > 0 ? process.argv[homeIdx + 1] : (process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const check = process.argv.includes('--check');
  const repoHooks = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.codex', 'hooks.json'), 'utf8'));
  const repoToml = fs.readFileSync(path.join(REPO_ROOT, '.codex', 'config.toml'), 'utf8');
  const hooksPath = path.join(codexHome, 'hooks.json');
  const tomlPath = path.join(codexHome, 'config.toml');
  const homeHooks = fs.existsSync(hooksPath) ? JSON.parse(fs.readFileSync(hooksPath, 'utf8')) : {};
  const homeToml = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, 'utf8') : '';

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
  if (hooksStale) fs.writeFileSync(hooksPath, hooksOut);
  if (tomlStale) fs.writeFileSync(tomlPath, toml.text);
  console.log(`Codex hooks ${hooksStale ? 'installed' : 'already current'} at ${hooksPath}; config ${tomlStale ? 'updated' : 'already current'} at ${tomlPath}.`);
  for (const c of toml.conflicts) console.log(`  left as is (set by hand): ${c}`);
}

if (require.main === module) main();

module.exports = { parseSimpleToml, mergeToml, mergeHooks };
