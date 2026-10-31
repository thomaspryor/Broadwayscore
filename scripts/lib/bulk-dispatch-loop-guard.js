#!/usr/bin/env node
'use strict';
/**
 * bulk-dispatch-loop-guard.js (BRO-6536): spot a session's Bash command that
 * dispatches a capped bulk workflow (CAPS in workflow-queue-cap.js) over and
 * over without going through scripts/capped-workflow-dispatch.js.
 *
 * WHY: on 2026-10-29 the 359 ingest-urls.yml runs that queued a Land run for
 * 2h37m had triggering_actor=thomaspryor: sessions' own
 * `for s in ...; do gh workflow run ingest-urls.yml ...; done` loops. BRO-6532
 * capped the scripted fan-outs; this catches the hand-written ones.
 *
 * ADVISORY (CLAUDE.md §19, land advisory first): .claude/hooks/bulk-dispatch-loop-guard.sh
 * pipes the PreToolUse JSON here; a hit prints a warning for the model and
 * appends a row to the ledger, and the command still runs. A later card flips
 * it to blocking once `--report` shows how often it fires and that the hits are real.
 *
 * Counted as a bare dispatch: a statement whose command is `gh workflow run`,
 * `gh api .../dispatches`, `curl .../dispatches` or scripts/cloud-dispatch.js
 * (wrappers like env/timeout/xargs/parallel skipped) naming a capped workflow
 * by file or display name. Warns when the command has a loop
 * (for/while/until, xargs, parallel) around one, or holds two or more.
 * Commit-message text and heredoc bodies are stripped first, so a commit or
 * doc that quotes such a loop is silent; so is `grep "gh workflow run ..."`.
 * Not seen: a loop inside a script file it runs, a script fed to a shell as
 * a heredoc, `eval`, and MCP dispatch calls. Ledger rows are attempts (written
 * before the command runs; another hook may still deny it).
 * On the Mac, ~/.claude/hooks/gh-poll-block.sh Rule 3 already hard-blocks
 * dispatch loops with `sleep`; this one also covers loops without sleep, xargs and cloud.
 *
 * CLI: (hook) reads PreToolUse JSON on stdin.  --report: ledger hit counts.
 * Kill switch: BULK_DISPATCH_GUARD_OFF=1 or the file ~/.claude/BULK_DISPATCH_GUARD_OFF (checked in the .sh).
 * Ledger: $BULK_DISPATCH_GUARD_LEDGER or ~/.claude/state/bulk-dispatch-loop-guard.jsonl.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CAPS, WORKFLOW_DISPLAY_NAMES } = require('./workflow-queue-cap');
const { stripForDangerScan } = require('../../.claude/hooks/lib/strip-git-commit-noise');

const DISPLAY = Object.fromEntries(Object.entries(WORKFLOW_DISPLAY_NAMES).map(([n, wf]) => [n.toLowerCase(), wf]));

/**
 * A dispatch operand to its capped workflow file, or null. Accepts the file
 * name, a .github/workflows/ path, the bare stem (cloud-dispatch.js adds .yml)
 * and the display name (any case).
 */
function cappedWorkflow(operand) {
  const t = String(operand || '').replace(/^\.?\/?\.github\/workflows\//, '');
  if (CAPS[t]) return t;
  if (CAPS[`${t}.yml`]) return `${t}.yml`;
  return DISPLAY[t.toLowerCase()] || null;
}

// Leading words that run the next word as the command.
const WRAPPERS = new Set(['env', 'timeout', 'gtimeout', 'nohup', 'nice', 'command', 'exec', 'time', 'sudo', 'xargs', 'parallel', 'do', 'then', 'else', '{', '!']);
const FANOUT = new Set(['xargs', 'parallel']);
// Flags of those wrappers that take a separate value (`xargs -I {}`, `env -u X`).
const VALUE_FLAGS = new Set(['-I', '-n', '-P', '-L', '-d', '-s', '-E', '-j', '--jobs', '-k', '-u', '-g']);
// `gh workflow run` / `gh api` / `curl` flags whose value is the next token.
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '-r', '--ref', '-f', '-F', '--field', '--raw-field', '-X', '--method', '-H', '--header', '-d', '--data', '--input', '--json']);

/**
 * Split into statements on newline ; & && || | outside quotes, so a loop
 * quoted as an argument (echo/printf/a JSON payload) stays inside its statement.
 */
function splitStatements(command) {
  const segs = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < command.length) { cur += c + command[++i]; continue; }
      if (c === q) q = null;
      cur += c;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) { cur += c + command[++i]; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { segs.push(cur); cur = ''; i++; continue; }
    // `&` backgrounds a statement; `2>&1` and `&>` are redirections.
    if (c === '&' && /[<>]$/.test(cur)) { cur += c; continue; }
    if (c === '&' && command[i + 1] === '>') { cur += c; continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&') { segs.push(cur); cur = ''; continue; }
    cur += c;
  }
  segs.push(cur);
  return segs;
}

/** Words of one statement, quotes removed, subshell/backtick wrappers peeled. */
function tokenize(segment) {
  const out = [];
  let cur = null;
  let q = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < segment.length) { cur += segment[++i]; continue; }
      if (c === q) { q = null; continue; }
      cur += c;
      continue;
    }
    if (/\s/.test(c)) { if (cur !== null) out.push(cur); cur = null; continue; }
    if (cur === null) cur = '';
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '\\' && i + 1 < segment.length) { cur += segment[++i]; continue; }
    cur += c;
  }
  if (cur !== null) out.push(cur);
  return out.map((t) => t.replace(/^(\$\(|\(|`)+/, '').replace(/[)`]+$/, '')).filter(Boolean);
}

/** { cmd: the command word and its args (wrappers skipped), fanout: under xargs/parallel }. */
function commandOf(toks) {
  let i = 0;
  let fanout = false;
  while (i < toks.length) {
    const t = toks[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; } // VAR=x
    if (!WRAPPERS.has(t)) break;
    if (FANOUT.has(t)) fanout = true;
    i++;
    // Wrapper options, and a bare duration for timeout (`timeout 30 gh ...`).
    while (i < toks.length && (/^-/.test(toks[i]) || /^\d+[smhd]?$/.test(toks[i]))) {
      if (VALUE_FLAGS.has(toks[i])) i++;
      i++;
    }
  }
  return { cmd: toks.slice(i), fanout };
}

/** First positional argument from `from`, skipping flags and their values. */
function firstOperand(args, from) {
  for (let i = from; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) return a;
    if (GH_VALUE_FLAGS.has(a)) i++;
  }
  return null;
}

/** The workflow operand of a dispatch statement, '' if it names none, or null if not a dispatch. */
function dispatchOperand(cmd) {
  const base = (cmd[0] || '').split('/').pop();
  const args = cmd.slice(1);
  const restPath = () => {
    const m = args.join(' ').match(/actions\/workflows\/([^/\s]+)\/dispatches\b/);
    return m ? m[1] : '';
  };
  if (base === 'gh') {
    const r = args.findIndex((a, i) => a === 'run' && args[i - 1] === 'workflow');
    if (r >= 0) return firstOperand(args, r + 1) || '';
    return /\/dispatches\b/.test(args.join(' ')) ? restPath() : null;
  }
  if (base === 'curl') return /\/dispatches\b/.test(args.join(' ')) ? restPath() : null;
  if (base === 'cloud-dispatch.js') return firstOperand(args, 0) || '';
  if (base === 'node' && /(^|\/)cloud-dispatch\.js$/.test(args[0] || '')) return firstOperand(args, 1) || '';
  return null;
}

/**
 * Pure. Returns { warn, workflows, dispatches, loop }. `dispatches` counts the
 * bare dispatch statements naming a capped workflow; `loop` is true when one
 * of them runs inside a for/while/until body or under xargs/parallel.
 */
function classify(command) {
  const scan = stripForDangerScan(String(command || ''));
  const workflows = new Set();
  let dispatches = 0;
  let loop = false;
  let depth = 0;
  // Words a `$var` operand may take: `for x in <list>` lists and VAR=value.
  const candidates = [];
  for (const seg of splitStatements(scan)) {
    let toks = tokenize(seg);
    if (/^(for|select)$/.test(toks[0] || '')) {
      const at = toks.indexOf('in');
      if (at > 0) candidates.push(...toks.slice(at + 1));
    }
    toks.filter((t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)).forEach((t) => candidates.push(t.slice(t.indexOf('=') + 1)));
    if (toks[0] === 'done') { depth = Math.max(0, depth - 1); continue; }
    if (toks[0] === 'do') { depth++; toks = toks.slice(1); }
    const { cmd, fanout } = commandOf(toks);
    const inLoop = depth > 0 || fanout;
    // `bash -c "<script>"` / `bash -lc ...`: judge the script itself.
    const shellC = /^(bash|sh|zsh)$/.test((cmd[0] || '').split('/').pop()) ? cmd.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a)) : -1;
    if (shellC > 0 && cmd[shellC + 1]) {
      const inner = classify(cmd[shellC + 1]);
      dispatches += inner.dispatches;
      loop = loop || inner.loop || (inLoop && inner.dispatches > 0);
      inner.workflows.forEach((w) => workflows.add(w));
      continue;
    }
    const operand = dispatchOperand(cmd);
    if (operand === null) continue;
    let wfs = [cappedWorkflow(operand)].filter(Boolean);
    // `gh workflow run "$wf"`: the name sits in the loop list or an assignment.
    if (!wfs.length && operand.includes('$')) wfs = [...new Set(candidates.map(cappedWorkflow).filter(Boolean))];
    if (!wfs.length) continue;
    dispatches++;
    loop = loop || inLoop;
    wfs.forEach((w) => workflows.add(w));
  }
  const warn = dispatches > 0 && (loop || dispatches >= 2);
  return { warn, workflows: [...workflows], dispatches, loop };
}

function warningText(workflows) {
  const wf = workflows[0];
  return `⚠️ bulk-dispatch-loop-guard (BRO-6536, advisory): this command dispatches ${workflows.join(', ')} repeatedly without the queue cap. `
    + 'On 2026-10-29 session loops like this queued 359 ingest-urls runs and starved land.yml for 2h37m. '
    + `Dispatch each one through the cap and stop at the first DEFERRED (exit 3): for s in ...; do node scripts/capped-workflow-dispatch.js --workflow=${wf} -f k=v --wait-min=5 || break; done `
    + '(long lists: run it with run_in_background). It only dispatches: if you relied on cloud-dispatch.js --wait for each result, wait on the runs separately. '
    + 'Opening-night work: add --priority.';
}

function ledgerPath(env = process.env) {
  return env.BULK_DISPATCH_GUARD_LEDGER || path.join(os.homedir(), '.claude', 'state', 'bulk-dispatch-loop-guard.jsonl');
}

function record(row, env = process.env) {
  try {
    const p = ledgerPath(env);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(row) + '\n');
  } catch { /* advisory: a ledger failure never stops the command */ }
}

/** Hook entry: PreToolUse JSON in, hook JSON reply (or '') out. */
function handle(input, env = process.env) {
  if (!input || input.tool_name !== 'Bash') return '';
  const command = (input.tool_input && input.tool_input.command) || '';
  const r = classify(command);
  if (!r.warn) return '';
  record({
    ts: new Date().toISOString(),
    session: input.session_id || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_CODE_REMOTE_SESSION_ID || null,
    cwd: input.cwd || null,
    workflows: r.workflows, dispatches: r.dispatches, loop: r.loop,
    command: command.slice(0, 300),
  }, env);
  const msg = warningText(r.workflows);
  return JSON.stringify({ systemMessage: msg, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg } });
}

/** --report: hits per workflow and session count, from the ledger. */
function report(env = process.env) {
  let rows = [];
  try {
    rows = fs.readFileSync(ledgerPath(env), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* no ledger yet */ }
  const byWf = {};
  for (const r of rows) for (const w of r.workflows || []) byWf[w] = (byWf[w] || 0) + 1;
  const sessions = new Set(rows.map((r) => r.session).filter(Boolean)).size;
  return { ledger: ledgerPath(env), hits: rows.length, sessions, byWorkflow: byWf, last: rows.length ? rows[rows.length - 1].ts : null };
}

if (require.main === module) {
  if (process.argv.includes('--report')) {
    console.log(JSON.stringify(report(), null, 2));
  } else {
    let raw = '';
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => {
      try {
        const out = handle(JSON.parse(raw));
        if (out) process.stdout.write(out + '\n');
      } catch { /* fail open */ }
    });
  }
}

module.exports = { classify, handle, report, warningText, splitStatements, tokenize, cappedWorkflow };
