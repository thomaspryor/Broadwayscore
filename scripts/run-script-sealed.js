#!/usr/bin/env node
'use strict';

/**
 * run-script-sealed.js — the Actions side of run-script.yml (BRO-5008).
 *
 * Runs one committed script (argv from JSON, never a shell), captures its stdout
 * and stderr together, encrypts them to the caller's one-time public key
 * (scripts/lib/sealed-output.js) and prints only the sealed blob between markers.
 * Refuses to run without a public key: this repo's Actions logs are public, so
 * plaintext output is never an option.
 *
 * Env: RS_SCRIPT, RS_ARGS_JSON, RS_PUBKEY_B64, RS_TIMEOUT_MIN (default 30, max 55).
 * Exit: 0 when the script ran (its own exit code travels inside the markers),
 * 2 when the request was refused.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { seal } = require('./lib/sealed-output');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { validateScriptPath, BEGIN, END } = require('./cloud-run-script');

const MAX_OUTPUT = 8 * 1024 * 1024;
// GitHub's log is line-based; keep each line of the sealed blob short.
const CHUNK = 60000;
// Files Actions publishes (step summary) or feeds back into the job: a script
// writing its results there would bypass the sealing, so the child never sees them.
const STRIPPED_ENV = ['GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_STATE'];

const BLOCKING_STDIO = path.join(__dirname, 'lib', 'blocking-stdio.js');

function childEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (STRIPPED_ENV.includes(k) || k.startsWith('RS_')) delete out[k];
  }
  // BRO-4317: blocking stdout/stderr in the child, so process.exit() right after a
  // large print cannot drop the buffered tail (see lib/blocking-stdio.js).
  const preload = `--require ${JSON.stringify(BLOCKING_STDIO)}`;
  out.NODE_OPTIONS = out.NODE_OPTIONS ? `${out.NODE_OPTIONS} ${preload}` : preload;
  return out;
}

function chunk(str, size = CHUNK) {
  const parts = [];
  for (let i = 0; i < str.length; i += size) parts.push(str.slice(i, i + size));
  return parts;
}
const ROOT = path.join(__dirname, '..');

function refuse(msg) {
  console.error(`::error::run-script refused: ${msg}`);
  process.exit(2);
}

function parseArgsJson(raw) {
  let args;
  try { args = JSON.parse(raw || '[]'); } catch { return null; }
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return null;
  return args;
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: RS_SCRIPT=scripts/x.js RS_ARGS_JSON=\'[]\' RS_PUBKEY_B64=<b64 PEM> node scripts/run-script-sealed.js');
    console.log('Runs inside run-script.yml; use scripts/cloud-run-script.js from a session.');
    return;
  }
  const script = process.env.RS_SCRIPT || '';
  const bad = validateScriptPath(script);
  if (bad) refuse(bad);
  if (!fs.existsSync(path.join(ROOT, script))) refuse(`${script} does not exist on main`);
  const args = parseArgsJson(process.env.RS_ARGS_JSON);
  if (!args) refuse('args_json must be a JSON array of strings');
  let pub;
  try { pub = Buffer.from(process.env.RS_PUBKEY_B64 || '', 'base64').toString('utf8'); } catch { pub = ''; }
  if (!pub.includes('BEGIN PUBLIC KEY')) refuse('pubkey_b64 is missing or not a PEM public key');
  const timeoutMin = Math.min(Math.max(Number(process.env.RS_TIMEOUT_MIN) || 30, 1), 55);

  const [cmd, cmdArgs] = script.endsWith('.ts')
    ? ['npx', ['--no-install', 'tsx', script, ...args]]
    : [process.execPath, [script, ...args]];

  const chunks = [];
  let size = 0;
  let truncated = false;
  const take = (buf) => {
    if (size >= MAX_OUTPUT) { truncated = true; return; }
    chunks.push(buf.subarray(0, MAX_OUTPUT - size));
    size += buf.length;
  };
  // Own process group, so a timeout reaches grandchildren too (npx -> tsx -> node).
  const child = spawn(cmd, cmdArgs, { cwd: ROOT, env: childEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup('SIGTERM');
    // A script that traps SIGTERM must not outlive its time limit.
    setTimeout(() => killGroup('SIGKILL'), 15000).unref();
  }, timeoutMin * 60 * 1000);

  child.on('close', (code, signal) => {
    clearTimeout(timer);
    let out = Buffer.concat(chunks).toString('utf8');
    if (truncated) out += `\n[run-script] output truncated at ${MAX_OUTPUT} bytes`;
    if (timedOut) out += `\n[run-script] killed after ${timeoutMin} min`;
    const exitCode = code == null ? (signal ? 128 : 1) : code;
    const lines = [BEGIN, ...chunk(JSON.stringify(seal(out, pub))), END, `=== RUN-SCRIPT EXIT ${exitCode} ===`];
    // stdout to a pipe is async: process.exit() right after console.log cut a
    // large sealed blob off after two chunks and dropped END (2026-10-12, a
    // 200KB audit-review-contamination --json). Exit once the write has flushed.
    process.stdout.write(lines.join('\n') + '\n', () => process.exit(0));
  });
  child.on('error', (err) => refuse(`could not start ${cmd}: ${err.message}`));
}

if (require.main === module) main();

module.exports = { parseArgsJson, childEnv, chunk };
