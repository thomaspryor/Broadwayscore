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
const { validateScriptPath, BEGIN, END } = require('./cloud-run-script');

const MAX_OUTPUT = 8 * 1024 * 1024;
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
  const child = spawn(cmd, cmdArgs, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    // A script that traps SIGTERM must not outlive its time limit.
    setTimeout(() => child.kill('SIGKILL'), 15000).unref();
  }, timeoutMin * 60 * 1000);

  child.on('close', (code, signal) => {
    clearTimeout(timer);
    let out = Buffer.concat(chunks).toString('utf8');
    if (truncated) out += `\n[run-script] output truncated at ${MAX_OUTPUT} bytes`;
    if (timedOut) out += `\n[run-script] killed after ${timeoutMin} min`;
    const exitCode = code == null ? (signal ? 128 : 1) : code;
    console.log(BEGIN);
    console.log(JSON.stringify(seal(out, pub)));
    console.log(END);
    console.log(`=== RUN-SCRIPT EXIT ${exitCode} ===`);
    process.exit(0);
  });
  child.on('error', (err) => refuse(`could not start ${cmd}: ${err.message}`));
}

if (require.main === module) main();

module.exports = { parseArgsJson };
