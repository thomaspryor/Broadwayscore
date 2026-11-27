#!/usr/bin/env node
// BRO-7298: the visual gate's small-fix lane (owner decision 2026-11-10, option A: "Yes to A, for small fixes
// only. I still need to see a screenshot.").
//
// A small UI fix the owner asked for in their own words may be pushed WITHOUT the pre-push yes. In exchange the
// session owes the owner a screenshot of the live page once it is up: a Stop check refuses a closing message
// (SAFE TO ARCHIVE / "You can close this tab" / THIS SESSION: CLOSE ME|IDLE) until an image was sent with
// SendUserFile after the push. Big visual changes keep the pre-push yes.
//
// Opt-in, per push, as a shell comment on the push command (the one channel visible at PreToolUse time, same
// reason as the hook's `# NO-VERIFY:`):
//   git push origin HEAD:refs/heads/land/x  # SMALL-FIX: page=https://broadwayscorecard.com/shows/foo owner="<owner words>"
// The lane opens only when ALL hold:
//   - owner="..." quotes (verbatim, case and whitespace aside, >= MIN_QUOTE chars) one of the owner's last
//     RECENT_OWNER_MSGS messages in THIS transcript (non-synthetic user text, walkTranscript from transcript-scan.mjs:
//     tool output, hook feedback, notifications and peer messages never count);
//   - the session is interactive: not `claude -p` / SDK (CLAUDE_CODE_ENTRYPOINT=sdk-*) and not a dispatched job
//     worktree (.claude/worktrees/job-*): a dispatch prompt is a user record, but nobody is there to see the shot;
//   - the UI diff is small: <= MAX_FILES UI files and <= MAX_LINES added+deleted lines (git --numstat --no-renames;
//     a binary UI file refuses);
//   - page= is an https URL on broadwayscorecard.com (exact host), the page the owner will be shown.
// It never records a ledger approval and never mints a durable approval (those stay owner-yes only).
// Kill switch VISUAL_SMALL_FIX_DISABLED=1 (lane closed, Stop check silent). Every lane use is logged.
//
// Wired in .claude/hooks/pre-push-visual-gate.sh (lane), .claude/hooks/visual-small-fix-stop.sh (Mac Stop) and
// .claude/hooks/verify-edits.sh (cloud Stop). Pinned by tests/unit/visual-gate-small-fix.test.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { walkTranscript } from './transcript-scan.mjs';
import { isMainModule } from './is-main-module.mjs';

export const MAX_FILES = 3;
export const MAX_LINES = 40;
export const MIN_QUOTE = 12;
export const RECENT_OWNER_MSGS = 3;
export const STOP_BLOCK_BUDGET = 2;
const MIN_WAIVE_REASON = 15;
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
const ALLOWED_HOSTS = new Set(['broadwayscorecard.com', 'www.broadwayscorecard.com']);

const disabled = (env = process.env) => String(env.VISUAL_SMALL_FIX_DISABLED || '') === '1';

/** PURE. The `# SMALL-FIX: page=<url> owner="<words>"` shell comment, or null. Anchored like the hook's NO-VERIFY. */
export function parseMarker(command) {
  const m = /(?:^|\s)#[ \t]*SMALL-FIX:[ \t]*page=(\S+)[ \t]+owner="(.*)"[ \t]*$/m.exec(String(command || ''));
  return m ? { page: m[1], quote: m[2] } : null;
}

/** PURE. Why this page cannot be the one the owner is shown, or null. */
export function pageProblem(page) {
  let u;
  try { u = new URL(String(page || '')); } catch { return `page= is not a URL ("${String(page || '').slice(0, 80)}")`; }
  if (u.protocol !== 'https:') return 'page= must be an https:// URL';
  if (u.username || u.password) return 'page= must not carry a user name or password';
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return `page= must be on broadwayscorecard.com (got ${u.hostname})`;
  return null;
}

/** PURE. Why this session cannot use the lane (nobody would see the screenshot), or null. */
export function headlessProblem({ env = process.env, cwd = process.cwd() } = {}) {
  const ep = String(env.CLAUDE_CODE_ENTRYPOINT || '');
  if (/^sdk/i.test(ep)) return `headless session (CLAUDE_CODE_ENTRYPOINT=${ep}): no owner is in the chat to see the screenshot`;
  if (/[\\/]\.claude[\\/]worktrees[\\/]job-/.test(String(cwd))) return 'dispatched job worktree: no owner is in the chat to see the screenshot';
  return null;
}

const norm = (s) => String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

/** PURE. The owner's last `n` real messages (newest last). */
export function recentOwnerTexts(events, n = RECENT_OWNER_MSGS) {
  return events.filter((e) => e.kind === 'user_text' && !e.synthetic && String(e.text || '').trim()).slice(-n).map((e) => e.text);
}

/** PURE. Why owner="..." is not the owner's own recent words, or null. */
export function ownerQuoteProblem(events, quote) {
  const q = norm(quote);
  if (q.length < MIN_QUOTE) return `owner="..." is too short (${q.length} chars, need ${MIN_QUOTE}+): quote the owner's own request`;
  const recent = recentOwnerTexts(events);
  if (!recent.length) return 'no message from the owner in this chat';
  if (!recent.some((t) => norm(t).includes(q))) return `owner="..." is not in the owner's last ${RECENT_OWNER_MSGS} messages in this chat (quote their words exactly)`;
  return null;
}

/** PURE. Size of the UI diff from `git diff --numstat` text. `problem` is null when the lane's size limits hold. */
export function diffSize(numstat) {
  const rows = String(numstat || '').split('\n').filter((l) => l.trim());
  let lines = 0;
  for (const r of rows) {
    const [a, d, ...f] = r.split('\t');
    if (a === '-' || d === '-') return { files: rows.length, lines: null, problem: `${f.join('\t')} is a binary file: not a small fix` };
    lines += Number(a) + Number(d);
  }
  const files = rows.length;
  if (!files) return { files, lines, problem: 'no UI lines changed' };
  if (files > MAX_FILES) return { files, lines, problem: `${files} UI files changed (small-fix limit ${MAX_FILES})` };
  if (lines > MAX_LINES) return { files, lines, problem: `${lines} UI lines changed (small-fix limit ${MAX_LINES})` };
  return { files, lines, problem: null };
}

function numstat(repo, range, files) {
  if (!files.length) return '';
  return execFileSync('git', ['diff', '--numstat', '--no-renames', range, '--', ...files], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** PURE apart from its inputs. The lane decision. -> { allowed, reason, files, lines, page, quote } */
export function decide({ marker, events, size, env = process.env, cwd = process.cwd() }) {
  const base = { allowed: false, files: size?.files ?? null, lines: size?.lines ?? null, page: marker?.page || null, quote: marker?.quote || null };
  if (disabled(env)) return { ...base, reason: 'small-fix lane disabled (VISUAL_SMALL_FIX_DISABLED=1)' };
  if (!marker) return { ...base, reason: 'no # SMALL-FIX: marker on the push command' };
  const why = headlessProblem({ env, cwd }) || pageProblem(marker.page) || size?.problem || ownerQuoteProblem(events, marker.quote);
  if (why) return { ...base, reason: why };
  return { ...base, allowed: true, reason: `small owner-requested fix (${size.files} file(s), ${size.lines} line(s))` };
}

// ── obligation state ───────────────────────────────────────────────────────────
export function stateDir(env = process.env) {
  return env.VISUAL_SMALL_FIX_STATE_DIR || path.join(os.homedir(), '.claude', 'state', 'visual-small-fix');
}
const stateFile = (session, env) => path.join(stateDir(env), `${String(session).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
export function readObligation(session, env = process.env) {
  if (!session) return null;
  try { return JSON.parse(fs.readFileSync(stateFile(session, env), 'utf8')); } catch { return null; }
}
function writeObligation(session, ob, env = process.env) {
  fs.mkdirSync(stateDir(env), { recursive: true });
  const f = stateFile(session, env);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(ob, null, 2));
  fs.renameSync(`${f}.tmp`, f);
}
/** Record that this session pushed a small fix and owes a screenshot of `page`. A new push resets the debt. */
export function recordPush(session, { page, quote, ref, files, lines }, { env = process.env, now = new Date() } = {}) {
  const prev = readObligation(session, env) || { pushes: [] };
  const pushes = [...(prev.pushes || []), { page, quote: String(quote).slice(0, 200), ref, files, lines, pushedAt: now.toISOString() }];
  const ob = { session, pushes, blocks: 0, waived: null };
  writeObligation(session, ob, env);
  return ob;
}

// ── Stop check ─────────────────────────────────────────────────────────────────
/** PURE. Does this closing message say the session is finished? (cloud verdict line, Mac closing line, machine verdict) */
export function claimsClosing(message) {
  const text = String(message || '').replace(/```[\s\S]*?```/g, '');
  if (/THIS SESSION:\s*(?:CLOSE ME|IDLE)\b/.test(text)) return true;
  const lines = text.split('\n').map((l) => l.trim().replace(/^[*_>#\s•-]+/, '').replace(/[*_\s]+$/, '')).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  return /^(?:SAFE TO (?:ARCHIVE|EXIT)\b|You can close this tab\b|Nothing is running here\b)/i.test(last);
}

/** PURE. An image sent to the owner with SendUserFile at or after `sinceIso`, or null. */
export function screenshotSentSince(events, sinceIso) {
  const since = Date.parse(sinceIso || '');
  for (const e of events) {
    if (e.kind !== 'assistant_tool_use' || e.name !== 'SendUserFile') continue;
    if (!(Date.parse(e.ts || '') >= since)) continue;
    const files = Array.isArray(e.input?.files) ? e.input.files : [];
    const img = files.find((f) => IMAGE_RE.test(String(f)));
    if (img) return img;
  }
  return null;
}

export function screenshotHint(page) {
  return `Wait until it is live (node scripts/check-prod-deploy.js HEAD --wait), screenshot ${page} at phone width (390) and desktop (1440) into ~/Documents/claude-outputs/ (Playwright), then show them: SendUserFile files=[...the .png paths...] display="render". Cannot (the push failed, the page is gone)? node scripts/lib/visual-small-fix.mjs waive --session=$CLAUDE_CODE_SESSION_ID --reason="<why>" (logged).`;
}

/** PURE. -> { block: boolean, message?: string } */
export function stopDecision({ events, lastMessage, obligation, stopHookActive = false, env = process.env }) {
  if (disabled(env) || !obligation || obligation.waived) return { block: false };
  const pushes = obligation.pushes || [];
  const last = pushes[pushes.length - 1];
  if (!last) return { block: false };
  if (!claimsClosing(lastMessage)) return { block: false };
  if (screenshotSentSince(events, last.pushedAt)) return { block: false };
  if ((obligation.blocks || 0) >= STOP_BLOCK_BUDGET) return { block: false, exhausted: true };
  if (stopHookActive && (obligation.blocks || 0) > 0 && obligation.lastBlockedMsg === norm(lastMessage).slice(0, 300)) return { block: false, exhausted: true };
  return {
    block: true,
    message: `[visual-small-fix] You pushed a small UI fix without the owner's pre-push yes (BRO-7298 lane), so you owe them a screenshot of the live page before you close: ${last.page}\n${screenshotHint(last.page)}`,
  };
}

function appendLog(row, env = process.env) {
  try {
    const dir = env.CLAUDE_LOG_DIR || path.join(os.homedir(), '.claude', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'visual-gate-bypass.log'), `${Math.floor(Date.now() / 1000)}\t${row}\n`);
  } catch { /* logging never blocks */ }
}

function arg(argv, name) {
  const p = `--${name}=`;
  const a = argv.find((x) => x.startsWith(p));
  return a == null ? undefined : a.slice(p.length);
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === 'check' || cmd === 'explain') {
    // check:   --command --transcript --repo --range --files=a,b [--session --ref]   (records + logs when allowed)
    // explain: --repo --range --files                                                  (one line for block messages)
    const repo = arg(argv, 'repo') || process.cwd();
    const range = arg(argv, 'range') || 'origin/main...HEAD';
    const files = String(arg(argv, 'files') || '').split(',').map((s) => s.trim()).filter(Boolean);
    let size;
    try { size = diffSize(numstat(repo, range, files)); } catch (e) { size = { files: null, lines: null, problem: `could not size the diff (${String(e.message).split('\n')[0].slice(0, 80)})` }; }
    if (cmd === 'explain') {
      if (disabled() || headlessProblem()) return 0;
      if (size.problem) { process.stdout.write(`Small-fix lane (BRO-7298): not available, ${size.problem}.\n`); return 0; }
      process.stdout.write(`Small-fix lane (BRO-7298): this diff is small (${size.files} file(s), ${size.lines} line(s)). If the OWNER asked for this exact fix in this chat, push without their yes by ending the push command with  # SMALL-FIX: page=<https://broadwayscorecard.com/... page that shows it> owner="<their words, copied exactly>"  then send them a screenshot of that live page before you close.\n`);
      return 0;
    }
    const marker = parseMarker(arg(argv, 'command'));
    const tp = arg(argv, 'transcript');
    const events = tp ? walkTranscript(tp) : [];
    const d = decide({ marker, events, size });
    if (d.allowed) {
      const session = arg(argv, 'session');
      if (!session) { d.allowed = false; d.reason = 'no session id: the screenshot debt could not be recorded'; }
      else {
        recordPush(session, { page: d.page, quote: d.quote, ref: arg(argv, 'ref') || 'HEAD', files: d.files, lines: d.lines });
        appendLog(`small-fix-lane\t${arg(argv, 'ref') || 'HEAD'} ${files.join(' ')} page=${d.page}`);
      }
    }
    process.stdout.write(`${JSON.stringify(d)}\n`);
    return d.allowed ? 0 : 1;
  }
  if (cmd === 'waive') {
    const session = arg(argv, 'session');
    const reason = String(arg(argv, 'reason') || '').trim();
    const ob = readObligation(session);
    if (!ob) { console.error('No small-fix screenshot is owed in this session.'); return 1; }
    if (reason.length < MIN_WAIVE_REASON) { console.error(`--reason needs ${MIN_WAIVE_REASON}+ characters.`); return 1; }
    writeObligation(session, { ...ob, waived: { reason, at: new Date().toISOString() } });
    appendLog(`small-fix-waive\t${session} ${reason.slice(0, 160)}`);
    console.log('Waived (logged). Tell the owner in plain words why there is no screenshot.');
    return 0;
  }
  if (cmd === '--stop-hook' || cmd === 'stop-hook') {
    let input = {};
    try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return 0; }
    const session = input.session_id;
    const obligation = readObligation(session);
    if (!obligation) return 0;
    const events = input.transcript_path && fs.existsSync(input.transcript_path) ? walkTranscript(input.transcript_path) : [];
    const lastMessage = input.last_assistant_message || '';
    const d = stopDecision({ events, lastMessage, obligation, stopHookActive: input.stop_hook_active === true });
    if (!d.block) return 0;
    writeObligation(session, { ...obligation, blocks: (obligation.blocks || 0) + 1, lastBlockedMsg: norm(lastMessage).slice(0, 300) });
    appendLog(`small-fix-stop-block\t${session}`);
    process.stderr.write(`${d.message}\n`);
    return 2;
  }
  console.error('usage: visual-small-fix.mjs check|explain|waive|--stop-hook [--flags]');
  return 1;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    // Fail toward the normal gate: a crash in `check` exits 1 (lane closed); the Stop hook passes.
    console.error(`visual-small-fix: ${e?.message || e}`);
    process.exit(process.argv[2] === 'check' ? 1 : 0);
  });
}
