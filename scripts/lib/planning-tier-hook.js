#!/usr/bin/env node
// scripts/lib/planning-tier-hook.js (BRO-6249) — PreToolUse(Write) driver for planning-tier.js.
// stdin: hook JSON. stdout: hook JSON ({systemMessage}) on warn. exit 2 + stderr on block.
// Fails OPEN on every error (a crashed PreToolUse hook would wedge Write for every session).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 });
}

// A dir is "new" if origin/main (not the index: staged/committed files must not hide it) has nothing under it.
function existsOnMain(top, d) {
  let ref = 'origin/main';
  try { git(['rev-parse', '--verify', '-q', ref], top); } catch { ref = 'HEAD'; }
  try { return git(['ls-tree', '-r', '--name-only', ref, '--', d + '/'], top).split('\n').filter(Boolean).length > 0; } catch { return true; }
}

function gather(input) {
  const file = input.tool_input && input.tool_input.file_path;
  if (!file) return null;
  let cwd = path.dirname(path.resolve(file));
  while (!fs.existsSync(cwd) && cwd !== path.dirname(cwd)) cwd = path.dirname(cwd); // new nested dir: nearest existing ancestor
  const top = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const abs = path.resolve(file);
  const rel = path.relative(top, abs);
  if (rel.startsWith('..')) return null;
  const isNewFile = !fs.existsSync(abs);
  const dir = path.dirname(rel);
  let dirIsNew = false;
  let newFilesInDir = 1;
  if (isNewFile && dir !== '.') {
    // Topmost ancestor directory (below the repo root) with no tracked files = the new system's root.
    const parts = dir.split('/');
    let rootDir = null;
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (existsOnMain(top, d)) continue; rootDir = d; break;
    }
    if (rootDir) {
      let ignored = false;
      try { git(['check-ignore', '-q', '--', path.join(rootDir, 'x')], top); ignored = true; } catch { /* exit 1 = not ignored */ }
      if (!ignored) {
        dirIsNew = true;
        const count = (d) => { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? count(path.join(d, e.name)) : 1; } catch { /* gone */ } return n; };
        newFilesInDir = count(path.join(top, rootDir)) + 1;
      }
    }
  }
  let knownSecrets = new Set();
  const content = (input.tool_input && input.tool_input.content) || '';
  if (isNewFile && /secrets\./.test(content)) {
    try { for (const m of git(['grep', '-ohE', 'secrets(\\.|\\[ *[\'\"])[A-Z][A-Z0-9_]+', '--', '.github'], top).split('\n')) if (m) knownSecrets.add(m.replace(/^secrets(\.|\[\s*['\"])/, '')); } catch { /* no matches */ }
  }
  return { top, facts: { relPath: rel.split(path.sep).join('/'), isNewFile, dirIsNew, newFilesInDir, content, knownSecrets } };
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  if (input.tool_name && input.tool_name !== 'Write') return 0;
  const g = gather(input);
  if (!g) return 0;
  const pt = require('./planning-tier.js');
  const { tier, triggers } = pt.classify(g.facts);
  if (tier === 'simple') return 0;
  let verdicts = [];
  try { const rg = await import(path.join(__dirname, 'review-gate.mjs')); verdicts = rg.readLedger(rg.canonicalRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd())); } catch { verdicts = []; }
  let transcriptText = '';
  try { if (input.transcript_path) transcriptText = fs.readFileSync(input.transcript_path, 'utf8'); } catch { /* none */ }
  const approved = pt.isApproved({ verdicts: Array.isArray(verdicts) ? verdicts : [], sessionId: input.session_id || null, now: Date.now(), transcriptText }).ok;
  const mode = process.env.PLANNING_TIER_MODE || 'auto'; // auto | warn | block | off
  const d = pt.decide({ tier, triggers, approved, now: Date.now(), mode });
  if (d.action === 'warn') process.stdout.write(JSON.stringify({ systemMessage: d.message }) + '\n');
  if (d.action === 'block') { process.stderr.write(d.message + '\n'); return 2; }
  return 0;
}

main().then((c) => process.exit(c), () => process.exit(0));
