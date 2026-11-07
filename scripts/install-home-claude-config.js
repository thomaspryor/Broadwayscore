#!/usr/bin/env node
'use strict';
/**
 * scripts/install-home-claude-config.js: give cloud sessions that start in
 * /home/user this repo's hooks, slash commands, skills and agents (BRO-5221).
 *
 * A cloud session's working directory is /home/user whenever it holds more than
 * one repo (the usual phone setup: each repo is passed with --add-dir, which
 * loads the repo's commands but never its hooks) or was started by
 * create_session with a source_url not spelled exactly like the repo. Claude
 * Code then reads /home/user/.claude as the project config, and nothing was
 * there: no Stop finish-chain gate, no create_session URL guard, no SessionStart
 * setup, and for the second shape no /ship-check, /what-else or /wrap-up either
 * (incident: session_01SBtqUQy2vUqYa7GK6mAnCU, 2026-10-12).
 *
 * This writes <target>/.claude/settings.json with every hook in this repo's
 * .claude/settings.json, each routed through .claude/hooks/lib/home-hook-runner.sh
 * (which keeps tool hooks off the other repos' work), and symlinks
 * <target>/.claude/commands, skills and agents (review-panelist,
 * repo-sweeper: /ship-check needs them) to this repo's. A session whose working
 * directory is this checkout never reads <target>/.claude, so it is unaffected.
 * The hook commands find the checkout at run time, so a re-clone or a rename of
 * the checkout's directory case does not break them; the hook LIST is fixed at
 * install time, so run this again after adding a hook (--check reports drift).
 *
 * Run it from the cloud environment's setup script (runs after the clones,
 * before Claude starts):
 *   the one-line loop in .claude/CLOUD.md, "Owner one-time setup" (it globs
 *   the checkouts under /home/user and runs this file from each).
 *
 * Usage: node scripts/install-home-claude-config.js [--target <dir>] [--check | --uninstall] [--adopt-hookless-settings]
 *   --target defaults to the directory holding this checkout (/home/user in cloud,
 *   which is $HOME there; $HOME needs CLAUDE_CODE_REMOTE=true).
 */
require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MARK_KEY = '_generatedBy';
const MARK = 'Broadwayscore scripts/install-home-claude-config.js (BRO-5221). Regenerated on install; do not edit by hand.';
const RUNNER_REL = '.claude/hooks/lib/home-hook-runner.sh';
const LINKS = ['commands', 'skills', 'agents'];
const HOOK_RE = /\.claude\/hooks\/([A-Za-z0-9._-]+\.sh)/;

// Shell that finds the checkout under <target> at run time and runs one hook through
// the runner. Case-insensitive on the directory name; fails open (exit 0).
function hookCommand(target, hookName) {
  const t = target.replace(/'/g, `'\\''`);
  // The exact name first, so a stale lowercase clone never wins on collation order.
  return `R=""; for d in '${t}'/Broadwayscore/ '${t}'/*/; do [ -f "\${d}${RUNNER_REL}" ] && [ -f "\${d}scripts/install-home-claude-config.js" ] && { R="\${d%/}"; break; }; done; `
    + `[ -n "$R" ] && exec bash "$R/${RUNNER_REL}" ${hookName}; exit 0`;
}

// Repo settings keys copied as-is: the context window (env) and default effort (BRO-6684).
const SPEND_KEYS = ['env', 'effortLevel'];
// What this installer last wrote for them, so an owner's own values are told apart on every run.
const SPEND_RECORD_KEY = '_installedSpend';

// The owner's part of a settings file: env entries and effortLevel that differ from what we wrote.
function ownerSpend(existing) {
  const ours = (existing && existing[SPEND_RECORD_KEY]) || {};
  const env = Object.fromEntries(Object.entries((existing && existing.env) || {}).filter(([k, v]) => !(ours.env && ours.env[k] === v)));
  const effort = existing && existing.effortLevel !== undefined && existing.effortLevel !== ours.effortLevel ? existing.effortLevel : undefined;
  return { env, effortLevel: effort };
}

// Repo spend keys merged under the owner's own values: env per entry, effortLevel whole.
function mergeSpend(repoSpend, owner) {
  const out = {};
  const env = { ...(repoSpend.env || {}), ...owner.env };
  if (Object.keys(env).length) out.env = env;
  const effort = owner.effortLevel !== undefined ? owner.effortLevel : repoSpend.effortLevel;
  if (effort !== undefined) out.effortLevel = effort;
  return out;
}

// The generated settings for <target>: every hook in the repo settings, same
// events, matchers and timeouts, commands rewritten to hookCommand().
function buildSettings(repoSettings, target) {
  const hooks = {};
  const wired = [];
  for (const [event, groups] of Object.entries(repoSettings.hooks || {})) {
    for (const group of groups) {
      const out = [];
      for (const h of group.hooks || []) {
        const m = HOOK_RE.exec(h.command || '');
        if (h.type !== 'command' || !m) continue;
        out.push({ ...h, command: hookCommand(target, m[1]) });
        wired.push(`${event}:${m[1]}`);
      }
      if (!out.length) continue;
      const g = { ...group, hooks: out };
      (hooks[event] = hooks[event] || []).push(g);
    }
  }
  // BRO-6684: the spend knobs too. Without them a multi-repo session (the app's default)
  // ran with the 1M context window and no effort default; the Oct 25-31 coordinator hit 780k.
  const spend = {};
  for (const key of SPEND_KEYS) if (repoSettings[key] !== undefined) spend[key] = repoSettings[key];
  return { settings: { [MARK_KEY]: MARK, ...spend, hooks }, wired };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function plan(target, adoptHookless = false) {
  const repoSettings = readJson(path.join(REPO_ROOT, '.claude', 'settings.json'));
  if (!repoSettings) throw new Error('cannot read .claude/settings.json in this checkout');
  const { settings, wired } = buildSettings(repoSettings, target);
  const repoSpend = Object.fromEntries(SPEND_KEYS.filter((k) => settings[k] !== undefined).map((k) => [k, settings[k]]));
  const links = LINKS
    .filter((name) => fs.existsSync(path.join(REPO_ROOT, '.claude', name)))
    .map((name) => ({ name, from: path.join(target, '.claude', name), to: path.join(REPO_ROOT, '.claude', name) }));
  const settingsPath = path.join(target, '.claude', 'settings.json');
  const existing = readJson(settingsPath);
  const isObject = existing && typeof existing === 'object' && !Array.isArray(existing);
  const mayAdopt = !!(adoptHookless && isObject && !Object.hasOwn(existing, 'hooks') && !Object.hasOwn(existing, MARK_KEY));
  const preserve = isObject && (existing[MARK_KEY] === MARK || mayAdopt);
  const merged = preserve ? { ...existing, ...settings } : { ...settings };
  // The owner's own env entries / effortLevel survive every run; ours are recorded (BRO-6684).
  const owner = preserve ? ownerSpend(existing) : { env: {} };
  for (const key of [...SPEND_KEYS, SPEND_RECORD_KEY]) delete merged[key]; // fixed key order: re-runs write nothing
  Object.assign(merged, mergeSpend(repoSpend, owner));
  if (Object.keys(repoSpend).length) merged[SPEND_RECORD_KEY] = repoSpend;
  return { settingsPath, settings: merged, wired, links, mayAdopt, repoSpend };
}

// Problems that make installing unsafe; empty when it is fine to write.
function refusals(target, p) {
  const out = [];
  const real = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  const home = real(os.homedir());
  // In cloud, /home/user IS $HOME and ~/.claude is the only place Claude Code loads
  // (BRO-6126), so the cloud setup line and runner set CLAUDE_CODE_REMOTE=true to
  // allow it. Without it $HOME is refused: on a Mac it would fire every hook twice.
  if (real(target) === home && process.env.CLAUDE_CODE_REMOTE !== 'true') {
    out.push(`target ${target} is $HOME: its .claude/settings.json would be user settings and fire every hook twice in single-repo sessions (cloud: run with CLAUDE_CODE_REMOTE=true)`);
  }
  if (path.resolve(target) === REPO_ROOT || REPO_ROOT.startsWith(path.resolve(target, '.claude') + path.sep)) {
    out.push(`target ${target} is this checkout`);
  }
  const existing = readJson(p.settingsPath);
  if (fs.existsSync(p.settingsPath) && (!existing || existing[MARK_KEY] !== MARK) && !p.mayAdopt) {
    out.push(`${p.settingsPath} exists and was not written by this script; leaving it alone`);
  }
  for (const l of p.links) {
    let st = null;
    try { st = fs.lstatSync(l.from); } catch { /* absent */ }
    if (st && !st.isSymbolicLink()) out.push(`${l.from} exists and is not a symlink; leaving it alone`);
  }
  return out;
}

function drift(p) {
  const out = [];
  const existing = readJson(p.settingsPath);
  if (!existing || JSON.stringify(existing) !== JSON.stringify(p.settings)) out.push(`${p.settingsPath} is missing or out of date`);
  for (const l of p.links) {
    let cur = null;
    try { cur = fs.readlinkSync(l.from); } catch { /* absent */ }
    if (cur !== l.to) out.push(`${l.from} does not link to ${l.to}`);
  }
  return out;
}

function install(target, p) {
  fs.mkdirSync(path.dirname(p.settingsPath), { recursive: true });
  const next = JSON.stringify(p.settings, null, 2) + '\n';
  let cur = null;
  try { cur = fs.readFileSync(p.settingsPath, 'utf8'); } catch { /* absent */ }
  // Unchanged output writes nothing, so a re-run never touches a live session's settings.
  if (cur !== next) {
    const tmp = `${p.settingsPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, p.settingsPath);
  }
  for (const l of p.links) {
    let cur2 = null;
    try { cur2 = fs.readlinkSync(l.from); } catch { /* absent */ }
    if (cur2 === l.to) continue;
    if (cur2 !== null) fs.unlinkSync(l.from);
    fs.symlinkSync(l.to, l.from);
  }
}

function uninstall(p) {
  const existing = readJson(p.settingsPath);
  if (existing && existing[MARK_KEY] === MARK) {
    const remaining = { ...existing };
    delete remaining[MARK_KEY];
    delete remaining.hooks;
    // Keep only the owner's own env entries / effortLevel (what differs from what we recorded).
    const owner = ownerSpend(remaining);
    for (const key of [...SPEND_KEYS, SPEND_RECORD_KEY]) delete remaining[key];
    if (Object.keys(owner.env).length) remaining.env = owner.env;
    if (owner.effortLevel !== undefined) remaining.effortLevel = owner.effortLevel;
    if (Object.keys(remaining).length) fs.writeFileSync(p.settingsPath, JSON.stringify(remaining, null, 2) + '\n');
    else fs.unlinkSync(p.settingsPath);
  }
  for (const l of p.links) {
    let cur = null;
    try { cur = fs.readlinkSync(l.from); } catch { /* absent */ }
    if (cur === l.to) fs.unlinkSync(l.from);
  }
}

function main(argv) {
  const ti = argv.indexOf('--target');
  const target = path.resolve(ti >= 0 ? argv[ti + 1] || '' : path.dirname(REPO_ROOT));
  const p = plan(target, argv.includes('--adopt-hookless-settings'));
  if (argv.includes('--uninstall')) {
    uninstall(p);
    console.log(`[home-claude-config] removed what this script installed under ${target}/.claude`);
    return 0;
  }
  if (argv.includes('--check')) {
    const d = [...refusals(target, p).filter((x) => !/is \$HOME|is this checkout/.test(x)), ...drift(p)];
    if (d.length) { d.forEach((x) => console.log(`[home-claude-config] DRIFT: ${x}`)); return 1; }
    console.log(`[home-claude-config] OK: ${p.wired.length} hooks wired, ${p.links.map((l) => l.name).join(' + ')} linked under ${target}/.claude`);
    return 0;
  }
  const r = refusals(target, p);
  if (r.length) { r.forEach((x) => console.error(`[home-claude-config] REFUSED: ${x}`)); return 2; }
  install(target, p);
  console.log(`[home-claude-config] wired ${p.wired.length} hooks and linked ${p.links.map((l) => l.name).join(' + ')} under ${target}/.claude`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    console.error(`[home-claude-config] ERROR: ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = { buildSettings, hookCommand, plan, refusals, drift, MARK, MARK_KEY };
