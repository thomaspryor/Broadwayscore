#!/usr/bin/env node
'use strict';
/**
 * session-retro.js (BRO-7629 item 6): hard-signal retro for one Claude Code session transcript (JSONL), no self-report.
 *   node scripts/lib/session-retro.js [--transcript=PATH] [--json] [--check] [--record]
 *   node scripts/lib/session-retro.js --rollup [--days=7] [--file-card]
 * Signals: edit-to-end wall clock, land refusals, hook blocks by code, bypasses (NO-VERIFY etc.), restarts (worker
 * restart, compaction), commands rerun 3+ times, waits over 10 min. --check exits 10 when a wrap-up threshold is crossed
 * (over 4h active, any land refusal, 15+ hook blocks, a restart, 2+ bypasses); wrap-up then needs each finding turned into
 * a fix or a card, recorded with --record --fixes=BRO-N,<sha> or --no-action=<reason> (checked by retro-coverage-stop.mjs). --record appends one line to data/audit/session-retro.jsonl for the weekly --rollup, which counts
 * signals across sessions and (with --file-card) files a Linear card for the top recurring friction.
 * A bare --check exits 0 once this session has a ledger row with links or a no-action reason. SESSION_RETRO_LEDGER overrides the ledger path (tests).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEDGER = process.env.SESSION_RETRO_LEDGER || path.join(__dirname, '..', '..', 'data', 'audit', 'session-retro.jsonl');
// BRO-7645: recalibrated so --check flags outliers. First 15h of data: every session crossed the old
// (2h wall clock, 3 hook blocks) pair, so the 'fix or card every finding' ask was noise. activeHours is
// wall clock minus owner idle gaps over gapMin after the first edit (a long CI wait is friction, not idle); a legacy row has only wall clock.
const T = { activeHours: 4, hookBlocks: 15, restarts: 1, bypasses: 2, gapMin: 10, repeats: 3 };
const GENERIC_HOOK = /^(hook|hook:hook|unclassified)$/;

/**
 * Real hook identity for a block, never free text that merely mentions a script: the [VE:X] code, else the
 * hook script basename from the attachment's own command, else its hookName, else 'unclassified'.
 */
function hookLabel(x) {
  const str = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v || {}); } catch { return ''; } };
  const code = str(x).match(/\[VE:([A-Z0-9]+)\]/);
  if (code) return `[VE:${code[1]}]`;
  if (!x || typeof x !== 'object') return 'unclassified';
  const be = x.blockingError && typeof x.blockingError === 'object' ? x.blockingError : {};
  const script = String(be.command || x.command || '').match(/([\w.-]+\.(?:sh|mjs|js))\b/);
  if (script) return script[1];
  const name = typeof x.hookName === 'string' && x.hookName.trim();
  return name ? name.slice(0, 40) : 'unclassified';
}

function textOf(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (!b ? '' : typeof b === 'string' ? b : b.text || (typeof b.content === 'string' ? b.content : textOf(b.content)) || (b.input ? JSON.stringify(b.input) : ''))).join('\n');
}

function analyze(lines) {
  const ev = [];
  for (const l of lines) { try { const o = JSON.parse(l); if (o && typeof o === 'object') ev.push(o); } catch { /* skip */ } }
  const humanGaps = [];
  const out = { sessionId: null, firstEditAt: null, endAt: null, hours: 0, landRefusals: [], hookBlocks: {}, bypasses: {}, restarts: 0, compactions: 0, idleMinutes: 0, landPushes: 0, repeats: [], longWaits: [] };
  const cmdCount = new Map();
  let prev = null;
  for (const e of ev) {
    out.sessionId = out.sessionId || e.sessionId || null;
    const ts = e.timestamp ? Date.parse(e.timestamp) : null;
    if (ts) {
      if (!out.startAt && e.type !== 'queue-operation') out.startAt = e.timestamp;
      const human = e.type === 'user' && !(Array.isArray(e.message && e.message.content) && e.message.content.some((b) => b && b.type === 'tool_result'));
      if (prev && ts - prev > T.gapMin * 60000 && e.type !== 'queue-operation') {
        if (human) humanGaps.push({ at: ts, minutes: Math.round((ts - prev) / 60000) });
        if (!human) out.longWaits.push({ at: e.timestamp, minutes: Math.round((ts - prev) / 60000) });
      }
      if (e.type !== 'queue-operation') prev = ts;
      out.endAt = e.timestamp;
    }
    if (e.type === 'system' && e.subtype === 'compact_boundary') out.compactions++;
    const msg = e.message && e.message.content;
    // Text the session itself wrote or the harness injected, never tool output (which echoes this script and any cat/grep of hook sources).
    const txt = Array.isArray(msg) ? textOf(msg.filter((b) => b && b.type !== 'tool_result')) : textOf(msg);
    if (e.type === 'attachment' && e.attachment && e.attachment.type === 'hook_blocking_error') { const k = hookLabel(e.attachment); out.hookBlocks[k] = (out.hookBlocks[k] || 0) + 1; }
    if (e.type === 'assistant' && Array.isArray(msg)) {
      for (const b of msg) {
        if (!b || b.type !== 'tool_use') continue;
        const cmd = b.input && b.input.command;
        if (!out.firstEditAt && e.timestamp && (/^(Edit|Write|NotebookEdit)$/.test(b.name) || (cmd && /\bgit commit\b|\bsed -i\b|\bpython3? - ?<<|\bcat >|\btee /.test(cmd)))) out.firstEditAt = e.timestamp;
        if (cmd) {
          const k = cmd.replace(/^\s*cd \S+ (&&|;)\s*/, '').replace(/\s+/g, ' ').slice(0, 90);
          const head = cmd.split(/<<-?\s*['"]?\w+/)[0]; // a heredoc body is data, not a push
          cmdCount.set(k, (cmdCount.get(k) || 0) + 1);
          // A real bypass rides a git push or gh command ("# NO-VERIFY: reason"); mentions inside grep/cat/echo are not bypasses.
          if (/\bgit push\b[^\n]*refs\/heads\/land\//.test(head)) out.landPushes++;
          if (/\bgit push\b|\bgh (pr|api)\b/.test(head)) for (const m of head.matchAll(/\b(NO-VERIFY|NO-SHIP-CHECK|NO-EXECUTE|NO-EFFECT-CHECK|NO-ROOT-CAUSE):\s*\S/g)) out.bypasses[m[1]] = (out.bypasses[m[1]] || 0) + 1;
        }
      }
    }
    if (e.type === 'user') {
      if (/Stop hook feedback|land preflight BLOCK/.test(txt)) {
        const git = /unpushed commit|uncommitted changes/.test(txt) ? ['git-check'] : [];
        const ve = txt.match(/\[VE:[A-Z0-9]+\]/g) || [];
        const codes = ve.length || git.length ? [...ve, ...git] : [hookLabel(txt)];
        for (const c of new Set(codes)) out.hookBlocks[c] = (out.hookBlocks[c] || 0) + 1;
      }
      // Land refusals are tool output (wait-for-land.js "REFUSED: land/..."), never the human's or the brief's prose.
      if (Array.isArray(msg)) for (const b of msg) {
        if (!b || b.type !== 'tool_result') continue;
        const t = textOf(b.content);
        const m = t.match(/^(?:\d\d:\d\d:\d\dZ )?REFUSED: (land\/\S+)[^\n]*/m);
        if (m) out.landRefusals.push({ at: e.timestamp || null, why: m[0].slice(0, 160) });
        // BRO-7701: a PreToolUse block (the tool never ran) is a hook block too. The land preflight's counts as a hook block,
        // not a land refusal: the review gate stopping an unreviewed push is the gate working, not a refused landing.
        const pre = b.is_error === true && t.match(/^PreToolUse:(\S+) hook error/); // real blocks are is_error; a cat of a log is not
        if (pre) {
          const code = t.match(/\[VE:[A-Z0-9]+\]/);
          const k = code ? code[0] : /LAND BLOCKED/.test(t) ? 'pre:land-preflight' : /outside a worktree/.test(t) ? 'pre:worktree-enforce' : `pre:${pre[1].split('__').pop()}`;
          out.hookBlocks[k] = (out.hookBlocks[k] || 0) + 1;
        }
      }
      if (/worker process was restarted/.test(txt)) out.restarts++;
    }
  }
  for (const [k, n] of cmdCount) if (n >= T.repeats && !/^(git (status|diff|log)|ls|cat|sed|grep|node --test)/.test(k)) out.repeats.push({ command: k, times: n });
  if (!out.firstEditAt) out.firstEditAt = out.startAt;
  if (out.firstEditAt && out.endAt) out.hours = +((Date.parse(out.endAt) - Date.parse(out.firstEditAt)) / 3600000).toFixed(2);
  // Owner idle time (a gap that ends in a human message) after the first edit is not friction; a long CI or tool wait is.
  const firstEditTs = out.firstEditAt ? Date.parse(out.firstEditAt) : 0;
  out.idleMinutes = humanGaps.filter((g) => g.at >= firstEditTs).reduce((a, g) => a + g.minutes, 0);
  out.activeHours = +Math.max(0, out.hours - out.idleMinutes / 60).toFixed(2);
  out.hookBlockCount = Object.values(out.hookBlocks).reduce((a, b) => a + b, 0);
  out.bypassCount = Object.values(out.bypasses).reduce((a, b) => a + b, 0);
  out.triggers = triggersFor({ activeHours: out.activeHours, landRefusalCount: out.landRefusals.length, hookBlockCount: out.hookBlockCount, restarts: out.restarts, bypassCount: out.bypassCount });
  return out;
}

/** PURE threshold check on the numbers a ledger row stores. */
function triggersFor(n) {
  const t = [];
  if (n.activeHours > T.activeHours) t.push(`over ${T.activeHours}h active (${n.activeHours}h)`);
  if (n.landRefusalCount) t.push(`${n.landRefusalCount} land refusal(s)`);
  if (n.hookBlockCount >= T.hookBlocks) t.push(`${n.hookBlockCount} hook blocks`);
  if (n.restarts >= T.restarts) t.push(`${n.restarts} container restart(s)`);
  if (n.bypassCount >= T.bypasses) t.push(`${n.bypassCount} bypasses`);
  return t;
}

/** BRO-7645: --fixes=BRO-1,abc1234 / --no-action=reason, validated. -> {links, noAction, error} */
function parseLinks(opt) {
  const links = opt.fixes && opt.fixes !== true ? String(opt.fixes).split(',').map((x) => x.trim()).filter(Boolean) : [];
  const bad = links.filter((x) => !/^(BRO-\d+|[0-9a-f]{7,40})$/.test(x));
  if (bad.length) return { links: [], noAction: null, error: `--fixes takes BRO-N ids or commit shas, got: ${bad.join(', ')}` };
  let noAction = null;
  if (opt['no-action'] !== undefined) {
    noAction = opt['no-action'] === true ? '' : String(opt['no-action']).trim();
    if (noAction.length < 15 || /^(<.*>|n\/?a|none|todo|tbd|nothing|ok)\W*$/i.test(noAction)) return { links, noAction: null, error: '--no-action needs a real reason (15+ chars, say why no finding needs a fix)' };
  }
  return { links, noAction, error: null };
}

/**
 * Latest ledger row for a session and whether the loop closed on it. A row without stored numbers
 * (legacy) is judged by its stored triggers.
 * -> {recorded, flagged, closed, row}
 */
function retroStatus(rows, sessionId) {
  const row = [...rows].reverse().find((r) => !r.rollup && r.sessionId === sessionId) || null;
  if (!row) return { recorded: false, flagged: false, closed: false, row: null };
  const flagged = Array.isArray(row.triggers) && row.triggers.length > 0;
  const legacy = row.v !== 2; // v1 rows were flagged by the retired 2h/3-block thresholds; they are history, not open work
  const closed = !flagged || legacy || (Array.isArray(row.links) && row.links.length > 0) || !!row.noAction;
  return { recorded: true, flagged, closed, row };
}

function report(r) {
  const L = [`Session ${r.sessionId || '?'}: ${r.hours}h from first edit to end (${r.activeHours}h active)`];
  L.push(`Land refusals: ${r.landRefusals.length}${r.landRefusals.map((x) => `\n  - ${x.why}`).join('')}`);
  L.push(`Hook blocks: ${JSON.stringify(r.hookBlocks)}  Bypasses: ${JSON.stringify(r.bypasses)}`);
  L.push(`Restarts: ${r.restarts}  Compactions: ${r.compactions}`);
  if (r.repeats.length) L.push('Reruns: ' + r.repeats.map((x) => `${x.times}x ${x.command}`).join(' | '));
  if (r.longWaits.length) L.push(`Waits over ${T.gapMin} min: ${r.longWaits.length} (longest ${Math.max(...r.longWaits.map((w) => w.minutes))} min)`);
  L.push(r.triggers.length ? `RETRO REQUIRED (${r.triggers.join('; ')}): turn each finding into a fix now or a card, then re-run with --record --fixes=BRO-N,<sha> (or --no-action="<why nothing needs fixing>"). A memory note is not a fix.` : 'No retro threshold crossed.');
  return L.join('\n');
}

function signals(r) {
  const s = [];
  for (const c of Object.keys(r.hookBlocks)) if (!GENERIC_HOOK.test(c)) s.push(`hook:${c}`);
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
  const bySession = new Map();
  for (const r of all) if (!r.rollup && Date.parse(r.endAt || r.recordedAt) >= cutoff) bySession.set(r.sessionId || `${r.recordedAt}`, r);
  const rows = [...bySession.values()];
  const count = new Map();
  for (const r of rows) for (const s of new Set(r.signals || [])) if (!(s.startsWith('hook:') && GENERIC_HOOK.test(s.slice(5)))) count.set(s, (count.get(s) || 0) + 1);
  const top = [...count.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5);
  log(`${rows.length} session(s) in the last ${days} days`);
  for (const [s, n] of top) log(`${n}x ${s}`);
  const mark = () => { if (ifDue) fs.appendFileSync(ledger, JSON.stringify({ rollup: true, recordedAt: new Date().toISOString(), sessions: rows.length, top }) + '\n'); };
  if (fileCard && top.length) {
    const [s, n] = top[0];
    const r = spawn('node', [path.join(__dirname, '..', 'linear-brain.js'), 'create', `Recurring session friction: ${s}`, '--dispatch', '--notes', `Weekly session-retro rollup. Signal ${s} hit ${n} of ${rows.length} sessions. Top five: ${top.map(([a, b]) => `${a} x${b}`).join('; ')}. Fix the cause (guard, test, hook), not a memory note.\n\n## Acceptance criteria\nVERIFY: node scripts/lib/session-retro.js --rollup --days=7`], { encoding: 'utf8' });
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
  const opt = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const eq = a.indexOf('='); return eq < 0 ? [a.slice(2), true] : [a.slice(2, eq), a.slice(eq + 1)]; }));
  if (opt.rollup) { rollup(Number(opt.days) || 7, !!opt['file-card'], { ifDue: !!opt['if-due'] }); return 0; }
  const file = opt.transcript || findTranscript();
  if (!file || !fs.existsSync(file)) { console.error('session-retro: no transcript found (use --transcript=PATH)'); return 1; }
  const r = analyze(fs.readFileSync(file, 'utf8').split('\n'));
  if (opt.record) {
    const pl = parseLinks(opt);
    if (pl.error) { console.error(`session-retro: ${pl.error}`); return 1; }
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify({ v: 2, sessionId: r.sessionId, endAt: r.endAt, recordedAt: new Date().toISOString(), hours: r.hours, activeHours: r.activeHours, hookBlockCount: r.hookBlockCount, restarts: r.restarts, bypassCount: r.bypassCount, landRefusalCount: r.landRefusals.length, landPushes: r.landPushes, signals: signals(r), triggers: r.triggers, links: pl.links, noAction: pl.noAction }) + '\n');
    r.links = pl.links; r.noAction = pl.noAction;
  }
  console.log(opt.json ? JSON.stringify(r, null, 2) : report(r));
  let closed = (r.links && r.links.length) || r.noAction;
  if (!closed && !opt.record) {
    // A bare --check must honour a row already recorded with links (the Stop gate re-runs it).
    const st = retroStatus(readLedger(), r.sessionId);
    if (st.recorded && st.closed) { closed = true; if (!opt.json) console.log('Retro already recorded with links or a no-action reason for this session.'); }
  }
  return opt.check && r.triggers.length && !closed ? 10 : 0;
}

if (require.main === module) require('./exit-flushed').exitFlushed(main(process.argv.slice(2)));
module.exports = { rollup, analyze, report, signals, T, hookLabel, triggersFor, parseLinks, retroStatus, readLedger, LEDGER };
