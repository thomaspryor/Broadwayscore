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

function gather(input) {
  const file = input.tool_input && input.tool_input.file_path;
  if (!file) return null;
  const top = git(['rev-parse', '--show-toplevel'], path.dirname(file).replace(/^$/, '.')).trim();
  const abs = path.resolve(file);
  const rel = path.relative(top, abs);
  if (rel.startsWith('..')) return null;
  const isNewFile = !fs.existsSync(abs);
  const dir = path.dirname(rel);
  let dirIsNew = false;
  let newFilesInDir = 1;
  if (isNewFile && dir !== '.') {
    const tracked = git(['ls-files', '--', dir + '/'], top).split('\n').filter(Boolean);
    dirIsNew = tracked.length === 0;
    if (dirIsNew) {
      const present = fs.existsSync(path.join(top, dir)) ? fs.readdirSync(path.join(top, dir)).filter((f) => fs.statSync(path.join(top, dir, f)).isFile()).length : 0;
      newFilesInDir = present + 1;
    }
  }
  let knownSecrets = new Set();
  const content = (input.tool_input && input.tool_input.content) || '';
  if (isNewFile && /secrets\./.test(content)) {
    try { for (const m of git(['grep', '-ohE', 'secrets\\.[A-Z][A-Z0-9_]+', '--', '.github'], top).split('\n')) if (m) knownSecrets.add(m.slice(8)); } catch { /* no matches */ }
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
  try { const rg = await import(path.join(__dirname, 'review-gate.mjs')); verdicts = rg.readLedger(rg.canonicalRoot(g.top)); } catch { verdicts = []; }
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
