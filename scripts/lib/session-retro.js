#!/usr/bin/env node
'use strict';
/**
 * session-retro.js (BRO-7629 item 6): hard-signal retro for one Claude Code session transcript (JSONL), no self-report.
 *   node scripts/lib/session-retro.js [--transcript=PATH] [--json] [--check] [--record]
 *   node scripts/lib/session-retro.js --rollup [--days=7] [--file-card]
 * Signals: edit-to-end wall clock, land refusals, hook blocks by code, bypasses (NO-VERIFY etc.), restarts (worker
 * restart, compaction), commands rerun 3+ times, waits over 10 min. --check exits 10 when a wrap-up threshold is crossed
 * (over 2h, any land refusal, 3+ hook blocks, any restart that killed work); wrap-up then needs each finding turned into
 * a fix or a card. --record appends one line to data/audit/session-retro.jsonl for the weekly --rollup, which counts
 * signals across sessions and (with --file-card) files a Linear card for the top recurring friction.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEDGER = path.join(__dirname, '..', '..', 'data', 'audit', 'session-retro.jsonl');
const T = { hours: 2, hookBlocks: 3, gapMin: 10, repeats: 3 };

function textOf(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (typeof b === 'string' ? b : b.text || (typeof b.content === 'string' ? b.content : textOf(b.content)) || (b.input ? JSON.stringify(b.input) : ''))).join('\n');
}

function analyze(lines) {
  const ev = [];
  for (const l of lines) { try { ev.push(JSON.parse(l)); } catch { /* skip */ } }
  const out = { sessionId: null, firstEditAt: null, endAt: null, hours: 0, landRefusals: [], hookBlocks: {}, bypasses: {}, restarts: 0, compactions: 0, repeats: [], longWaits: [] };
  const cmdCount = new Map();
  let prev = null;
  for (const e of ev) {
    out.sessionId = out.sessionId || e.sessionId || null;
    const ts = e.timestamp ? Date.parse(e.timestamp) : null;
    if (ts) {
      if (!out.startAt) out.startAt = e.timestamp;
      if (prev && ts - prev > T.gapMin * 60000 && e.type !== 'queue-operation') out.longWaits.push({ at: e.timestamp, minutes: Math.round((ts - prev) / 60000) });
      if (e.type !== 'queue-operation') prev = ts;
      out.endAt = e.timestamp;
    }
    if (e.type === 'system' && e.subtype === 'compact_boundary') out.compactions++;
    const msg = e.message && e.message.content;
    const txt = textOf(msg);
    if (e.type === 'assistant' && Array.isArray(msg)) {
      for (const b of msg) {
        if (b.type !== 'tool_use') continue;
        if (!out.firstEditAt && /^(Edit|Write|NotebookEdit)$/.test(b.name) && e.timestamp) out.firstEditAt = e.timestamp;
        const cmd = b.input && b.input.command;
        if (cmd) {
          const k = cmd.replace(/\s+/g, ' ').slice(0, 90);
          cmdCount.set(k, (cmdCount.get(k) || 0) + 1);
          // A real bypass rides a git push or gh command ("# NO-VERIFY: reason"); mentions inside grep/cat/echo are not bypasses.
          if (/\bgit push\b|\bgh (pr|api)\b/.test(cmd)) for (const m of cmd.matchAll(/\b(NO-VERIFY|NO-SHIP-CHECK|NO-EXECUTE|NO-EFFECT-CHECK|NO-ROOT-CAUSE):\s*\S/g)) out.bypasses[m[1]] = (out.bypasses[m[1]] || 0) + 1;
        }
      }
    }
    if (e.type === 'user') {
      if (/Stop hook feedback|🛑 BLOCKED|\[VE:[A-Z]+\]|land preflight BLOCK/.test(txt)) {
        const codes = txt.match(/\[VE:[A-Z]+\]/g) || ['hook'];
        for (const c of new Set(codes)) out.hookBlocks[c] = (out.hookBlocks[c] || 0) + 1;
      }
      // Land refusals are tool output (wait-for-land.js "REFUSED: land/..."), never the human's or the brief's prose.
      if (Array.isArray(msg)) for (const b of msg) {
        if (b.type !== 'tool_result') continue;
        const t = textOf(b.content);
        const m = t.match(/^[^\n]*REFUSED: (land\/\S+)[^\n]*/m);
        if (m) out.landRefusals.push({ at: e.timestamp || null, why: m[0].slice(0, 160) });
      }
      if (/worker process was restarted/.test(txt)) out.restarts++;
    }
  }
  for (const [k, n] of cmdCount) if (n >= T.repeats && !/^(git (status|diff|log)|ls|cat|sed|grep|node --test)/.test(k)) out.repeats.push({ command: k, times: n });
  if (!out.firstEditAt) out.firstEditAt = out.startAt;
  if (out.firstEditAt && out.endAt) out.hours = +((Date.parse(out.endAt) - Date.parse(out.firstEditAt)) / 3600000).toFixed(2);
  const blocks = Object.values(out.hookBlocks).reduce((a, b) => a + b, 0);
  out.triggers = [];
  if (out.hours > T.hours) out.triggers.push(`over ${T.hours}h from first edit (${out.hours}h)`);
  if (out.landRefusals.length) out.triggers.push(`${out.landRefusals.length} land refusal(s)`);
  if (blocks >= T.hookBlocks) out.triggers.push(`${blocks} hook blocks`);
  if (out.restarts) out.triggers.push(`${out.restarts} container restart(s)`);
  return out;
}

function report(r) {
  const L = [`Session ${r.sessionId || '?'}: ${r.hours}h from first edit to end`];
  L.push(`Land refusals: ${r.landRefusals.length}${r.landRefusals.map((x) => `\n  - ${x.why}`).join('')}`);
  L.push(`Hook blocks: ${JSON.stringify(r.hookBlocks)}  Bypasses: ${JSON.stringify(r.bypasses)}`);
  L.push(`Restarts: ${r.restarts}  Compactions: ${r.compactions}`);
  if (r.repeats.length) L.push('Reruns: ' + r.repeats.map((x) => `${x.times}x ${x.command}`).join(' | '));
  if (r.longWaits.length) L.push(`Waits over ${T.gapMin} min: ${r.longWaits.length} (longest ${Math.max(...r.longWaits.map((w) => w.minutes))} min)`);
  L.push(r.triggers.length ? `RETRO REQUIRED (${r.triggers.join('; ')}): turn each finding into a fix now or a card. A memory note is not a fix.` : 'No retro threshold crossed.');
  return L.join('\n');
}

function signals(r) {
  const s = [];
  for (const c of Object.keys(r.hookBlocks)) s.push(`hook:${c}`);
  for (const c of Object.keys(r.bypasses)) s.push(`bypass:${c}`);
  for (const x of r.landRefusals) s.push(`land:${(x.why || 'refused').replace(/[0-9a-f]{7,}|\d+/g, '#').slice(0, 60)}`);
  if (r.restarts) s.push('restart');
  for (const x of r.repeats) s.push(`rerun:${x.command.slice(0, 40)}`);
  return s;
}

function readLedger(file = LEDGER) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
}

function rollup(days, fileCard, { ledger = LEDGER, ifDue = false, log = console.log, spawn = require('child_process').spawnSync } = {}) {
  const cutoff = Date.now() - days * 86400000;
  const all = readLedger(ledger);
  if (ifDue && all.some((r) => r.rollup && Date.parse(r.recordedAt) >= cutoff)) { log('session-retro: weekly rollup already done'); return -1; }
  const rows = all.filter((r) => !r.rollup && Date.parse(r.endAt || r.recordedAt) >= cutoff);
  const count = new Map();
  for (const r of rows) for (const s of new Set(r.signals || [])) count.set(s, (count.get(s) || 0) + 1);
  const top = [...count.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5);
  log(`${rows.length} session(s) in the last ${days} days`);
  for (const [s, n] of top) log(`${n}x ${s}`);
  const mark = () => { if (ifDue) fs.appendFileSync(ledger, JSON.stringify({ rollup: true, recordedAt: new Date().toISOString(), sessions: rows.length, top }) + '\n'); };
  if (fileCard && top.length) {
    const [s, n] = top[0];
    const r = spawn('node', [path.join(__dirname, '..', 'linear-brain.js'), 'create', `Recurring session friction: ${s} (${n} sessions this week)`, '--dispatch', '--notes', `Weekly session-retro rollup. Signal ${s} hit ${n} of ${rows.length} sessions. Top five: ${top.map(([a, b]) => `${a} x${b}`).join('; ')}. Fix the cause (guard, test, hook), not a memory note.\n\n## Acceptance criteria\nVERIFY: node scripts/lib/session-retro.js --rollup --days=7`], { encoding: 'utf8' });
    if (r.error || r.status !== 0) { log(`session-retro: card filing failed (${r.error ? r.error.message : 'exit ' + r.status}); weekly marker not written, will retry next time`); return top; }
    log((r.stdout || '').split('\n').slice(0, 3).join('\n'));
  }
  mark();
  return top.length ? top : [];
}

function findTranscript() {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!fs.existsSync(base)) return null;
  const all = fs.readdirSync(base).flatMap((d) => { try { return fs.readdirSync(path.join(base, d)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(base, d, f)); } catch { return []; } });
  if (sid) { const hit = all.find((f) => f.includes(sid)); if (hit) return hit; }
  return all.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

function main(argv) {
  const opt = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
  if (opt.rollup) { rollup(Number(opt.days) || 7, !!opt['file-card'], { ifDue: !!opt['if-due'] }); return 0; }
  const file = opt.transcript || findTranscript();
  if (!file || !fs.existsSync(file)) { console.error('session-retro: no transcript found (use --transcript=PATH)'); return 1; }
  const r = analyze(fs.readFileSync(file, 'utf8').split('\n'));
  if (opt.record) {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify({ sessionId: r.sessionId, endAt: r.endAt, recordedAt: new Date().toISOString(), hours: r.hours, signals: signals(r), triggers: r.triggers }) + '\n');
  }
  console.log(opt.json ? JSON.stringify(r, null, 2) : report(r));
  return opt.check && r.triggers.length ? 10 : 0;
}

if (require.main === module) require('./exit-flushed').exitFlushed(main(process.argv.slice(2)));
module.exports = { rollup, analyze, report, signals, T };
