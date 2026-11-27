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
//   - owner="..." quotes (verbatim, case and whitespace aside, >= MIN_QUOTE chars) the owner's LAST message in THIS
//     transcript (non-synthetic user text, walkTranscript from transcript-scan.mjs: tool output, hook feedback,
//     notifications and peer messages never count; an owner message sent mid-turn does count, so "wait, stop" wins);
//   - one owner request opens the lane for ONE change: a later push citing the same request must carry the same UI
//     patch (a retry or rebase), so a big change cannot be sliced into small pushes;
//   - the command is ONE plain `git push [flags] origin <src>[:<dst>]` on one line (no chaining, no substitution):
//     <src> is resolved and sized from the command itself;
//   - this session's own settings run the screenshot Stop check (an older worktree whose settings lack it is refused);
//   - the session is interactive: not `claude -p` / SDK (CLAUDE_CODE_ENTRYPOINT=sdk-*) and not a dispatched job
//     worktree (.claude/worktrees/job-*): a dispatch prompt is a user record, but nobody is there to see the shot;
//   - the UI diff is small: <= MAX_FILES UI files and <= MAX_LINES added+deleted lines (git --numstat --no-renames;
//     a binary UI file refuses);
//   - page= is an https URL on broadwayscorecard.com (exact host), the page the owner will be shown.
// It never records a ledger approval and never mints a durable approval (those stay owner-yes only).
// Kill switches: VISUAL_SMALL_FIX_DISABLED=1 closes the lane (debts already owed are still enforced);
// VISUAL_SMALL_FIX_STOP_DISABLED=1 silences the Stop check. Every lane use, block and waiver is logged.
//
// Wired in .claude/hooks/pre-push-visual-gate.sh (lane), .claude/hooks/visual-small-fix-stop.sh (Mac Stop) and
// .claude/hooks/verify-edits.sh (cloud Stop). Pinned by tests/unit/visual-gate-small-fix.test.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { walkTranscript } from './transcript-scan.mjs';
import { isMainModule } from './is-main-module.mjs';
import { createRequire } from 'node:module';

const { exitFlushed } = createRequire(import.meta.url)('./exit-flushed.js');

export const MAX_FILES = 3;
export const MAX_LINES = 40;
export const MIN_QUOTE = 12;
export const RECENT_OWNER_MSGS = 1;
export const STOP_BLOCK_BUDGET = 2;
const MIN_WAIVE_REASON = 15;
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
const ALLOWED_HOSTS = new Set(['broadwayscorecard.com', 'www.broadwayscorecard.com']);

const disabled = (env = process.env) => String(env.VISUAL_SMALL_FIX_DISABLED || '') === '1';
const stopDisabled = (env = process.env) => String(env.VISUAL_SMALL_FIX_STOP_DISABLED || '') === '1';

/** PURE. The `# SMALL-FIX: page=<url> owner="<words>"` shell comment, or null. Anchored like the hook's NO-VERIFY. */
const MARKER_RE = /(?:^|\s)#[ \t]*SMALL-FIX:[ \t]*page=(\S+)[ \t]+owner="(.*)"[ \t]*$/;
export function parseMarker(command) {
  const c = String(command || '');
  if (/[\r\n]/.test(c.trim())) return null; // one line only: a marker in a heredoc or commit body never counts
  const m = MARKER_RE.exec(c);
  return m ? { page: m[1], quote: m[2] } : null;
}

const REF_TOKEN = '[A-Za-z0-9._/-]+';
const PUSH_RE = new RegExp(`^\\s*git push(?:\\s+(?:-u|--set-upstream|--force-with-lease|--no-verify|-q|--quiet))*\\s+origin\\s+(${REF_TOKEN})(?::(?:refs/heads/)?${REF_TOKEN})?\\s*$`);
/** PURE. The pushed source ref of a single plain `git push ... origin <src>[:<dst>]  # SMALL-FIX: ...`, or null. */
export function pushSource(command) {
  const c = String(command || '');
  if (/[\r\n]/.test(c.trim())) return null;
  const head = c.replace(MARKER_RE, '');
  const m = PUSH_RE.exec(head);
  return m ? m[1] : null;
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

/** PURE. The owner's last `n` real messages (newest last), as events. */
export function recentOwnerMessages(events, n = RECENT_OWNER_MSGS) {
  return events.filter((e) => e.kind === 'user_text' && !e.synthetic && String(e.text || '').trim()).slice(-n);
}
/** PURE. A stable key for one owner message (its time plus its text), so one request opens the lane once. */
export const ownerMessageKey = (e) => `${e.ts || ''}|${norm(e.text).slice(0, 120)}`;

/** PURE. -> { problem: string|null, key: string|null } : is owner="..." the owner's own latest words? */
export function ownerQuote(events, quote) {
  const q = norm(quote);
  if (q.length < MIN_QUOTE) return { problem: `owner="..." is too short (${q.length} chars, need ${MIN_QUOTE}+): quote the owner's own request`, key: null };
  const recent = recentOwnerMessages(events);
  if (!recent.length) return { problem: 'no message from the owner in this chat', key: null };
  const hit = recent.find((e) => norm(e.text).includes(q));
  if (!hit) return { problem: `owner="..." is not in the owner's latest message in this chat (quote their words exactly; if they wrote since, their newest message decides)`, key: null };
  return { problem: null, key: ownerMessageKey(hit) };
}
export const ownerQuoteProblem = (events, quote) => ownerQuote(events, quote).problem;

/** PURE. Why this session would not enforce the screenshot debt (its settings lack the Stop check), or null. */
export function enforcementProblem({ projectDir, env = process.env, read = (f) => fs.readFileSync(f, 'utf8') }) {
  try {
    if (String(env.CLAUDE_CODE_REMOTE || '') === 'true') {
      if (read(path.join(projectDir, '.claude', 'hooks', 'verify-edits.sh')).includes('visual-small-fix.mjs')) return null;
    } else if (read(path.join(projectDir, '.claude', 'settings.json')).includes('visual-small-fix-stop.sh')
      && read(path.join(projectDir, '.claude', 'hooks', 'visual-small-fix-stop.sh')).includes('visual-small-fix.mjs')) {
      return null;
    }
  } catch { /* unreadable: refuse below */ }
  return "this session's checkout does not run the screenshot Stop check yet (merge main into it first)";
}

/** PURE. Has this owner request already shipped a DIFFERENT change? (retries and rebases keep the same patch id) */
export function reuseProblem(obligation, key, patchId) {
  const prior = ((obligation && obligation.pushes) || []).filter((p) => p.ownerKey && p.ownerKey === key);
  if (prior.some((p) => p.patchId !== patchId)) return 'this owner request already shipped a different change through the lane; a further change needs their yes or a new request';
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

const gitOut = (repo, args, input) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', input, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
/**
 * Size and patch id of every UI file (`pattern`) in `range`. Plain `git diff` of the range, not the push gate's
 * own-merge-scoped list: on a shared local main that can only over-count (never under-count), which closes the lane.
 */
function uiSize(repo, range, pattern) {
  const rows = gitOut(repo, ['diff', '--numstat', '--no-renames', range]).split('\n').filter((l) => l.trim() && pattern.test(l.split('\t').slice(2).join('\t')));
  const size = diffSize(rows.join('\n'));
  let patchId = null;
  if (rows.length && !size.problem) {
    const files = rows.map((l) => l.split('\t').slice(2).join('\t'));
    const diff = gitOut(repo, ['diff', '--no-renames', range, '--', ...files]);
    patchId = (gitOut(repo, ['patch-id', '--stable'], diff).trim().split(/\s+/)[0]) || null;
  }
  return { size, patchId };
}

/**
 * PURE apart from its inputs. The lane decision. -> { allowed, reason, files, lines, page, quote, ownerKey }
 * `source` is the pushed ref (pushSource), `size` its UI diff (diffSize), `enforcement` enforcementProblem's answer,
 * `obligation` this session's state (reuseProblem), `patchId` the UI diff's patch id.
 */
export function decide({ marker, source, events, size, enforcement = null, obligation = null, patchId = null, env = process.env, cwd = process.cwd() }) {
  const base = { allowed: false, files: size?.files ?? null, lines: size?.lines ?? null, page: marker?.page || null, quote: marker?.quote || null, ownerKey: null };
  if (disabled(env)) return { ...base, reason: 'small-fix lane disabled (VISUAL_SMALL_FIX_DISABLED=1)' };
  if (!marker) return { ...base, reason: 'no # SMALL-FIX: marker on the push command (one line, at its end)' };
  if (!source) return { ...base, reason: 'the push command must be ONE plain `git push [flags] origin <branch>[:<dst>]` followed by the marker (no &&, ;, pipes or substitution)' };
  const q = ownerQuote(events, marker.quote);
  const why = headlessProblem({ env, cwd }) || enforcement || pageProblem(marker.page) || size?.problem || q.problem || reuseProblem(obligation, q.key, patchId);
  if (why) return { ...base, reason: why };
  return { ...base, allowed: true, ownerKey: q.key, reason: `small owner-requested fix (${size.files} file(s), ${size.lines} line(s))` };
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
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ob, null, 2));
  fs.renameSync(tmp, f);
}
/** Record that this session pushed a small fix and owes a screenshot of `page`. A new push resets the debt. */
export function recordPush(session, { page, quote, ref, sha, patchId, ownerKey, files, lines }, { env = process.env, now = new Date() } = {}) {
  const prev = readObligation(session, env) || { pushes: [] };
  const pushes = [...(prev.pushes || []), { page, quote: String(quote).slice(0, 200), ref, sha, patchId, ownerKey, files, lines, pushedAt: now.toISOString() }];
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
  // Any line, not only the last: a link or status line under the verdict must not hide it.
  return lines.some((l) => /^(?:SAFE TO (?:ARCHIVE|EXIT)\b|You can close this tab\b|Nothing is running here\b)/i.test(l));
}

const defaultMtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };
/**
 * An image the owner was actually sent after `sinceIso`, or null: a SendUserFile call made after the push whose
 * result came back without an error, naming an image file that exists and was written after the push (so an old
 * screenshot cannot pay the debt). `mtime(file)` is injectable for tests.
 */
export function screenshotSentSince(events, sinceIso, { cwd = process.cwd(), mtime = defaultMtime } = {}) {
  const since = Date.parse(sinceIso || '');
  const results = new Map(events.filter((e) => e.kind === 'tool_result').map((e) => [e.tool_use_id, e]));
  for (const e of events) {
    if (e.kind !== 'assistant_tool_use' || e.name !== 'SendUserFile') continue;
    if (!(Date.parse(e.ts || '') >= since)) continue;
    const r = results.get(e.id);
    if (!r || r.isError) continue;
    const files = Array.isArray(e.input?.files) ? e.input.files : [];
    const abs = (f) => (/^~(?=\/|$)/.test(f) ? path.join(os.homedir(), f.slice(1)) : path.resolve(cwd, f));
    const img = files.find((f) => IMAGE_RE.test(String(f)) && mtime(abs(String(f))) >= since);
    if (img) return img;
  }
  return null;
}

export function screenshotHint(page) {
  return `Wait until it is live (node scripts/check-prod-deploy.js HEAD --wait), screenshot ${page} at phone width (390) and desktop (1440) into ~/Documents/claude-outputs/ (Playwright), then show them: SendUserFile files=[...the .png paths...] display="render". Cannot (the push failed, the page is gone)? node scripts/lib/visual-small-fix.mjs waive --session=$CLAUDE_CODE_SESSION_ID --reason="<why>" (logged).`;
}

/** PURE. -> { block: boolean, message?: string } */
export function stopDecision({ events, lastMessage, obligation, stopHookActive = false, env = process.env, cwd = process.cwd(), mtime = defaultMtime }) {
  if (stopDisabled(env) || !obligation || obligation.waived) return { block: false };
  const pushes = obligation.pushes || [];
  const last = pushes[pushes.length - 1];
  if (!last) return { block: false };
  if (!claimsClosing(lastMessage)) return { block: false };
  if (screenshotSentSince(events, last.pushedAt, { cwd, mtime })) return { block: false };
  if ((obligation.blocks || 0) >= STOP_BLOCK_BUDGET) return { block: false, exhausted: true };
  if (stopHookActive && (obligation.blocks || 0) > 0 && obligation.lastBlockedMsg === norm(lastMessage).slice(0, 300)) return { block: false, exhausted: true };
  const pages = [...new Set(pushes.map((p) => p.page).filter(Boolean))].join(' , ');
  return {
    block: true,
    message: `[visual-small-fix] You pushed a small UI fix without the owner's pre-push yes (BRO-7298 lane), so you owe them a screenshot of the live page before you close: ${pages}\n${screenshotHint(last.page)}`,
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
    // check:   --command --transcript --repo --pattern --session --project-dir   (records + logs when allowed)
    // explain: --repo --range --pattern                                          (one line for block messages)
    const repo = arg(argv, 'repo') || process.cwd();
    let pattern;
    try { pattern = new RegExp(arg(argv, 'pattern') || '^src/.*\\.(tsx|jsx|css|scss)$'); } catch { pattern = /^src\//; }
    if (cmd === 'explain') {
      if (disabled() || headlessProblem()) return 0;
      let size;
      try { size = uiSize(repo, arg(argv, 'range') || 'origin/main...HEAD', pattern).size; } catch { return 0; }
      if (size.problem) { process.stdout.write(`Small-fix lane (BRO-7298): not available, ${size.problem}.\n`); return 0; }
      process.stdout.write(`Small-fix lane (BRO-7298): this diff is small (${size.files} file(s), ${size.lines} line(s)). If the OWNER asked for this exact fix in their latest message, push without their yes as ONE plain command:  git push origin <branch>[:refs/heads/land/<name>]  # SMALL-FIX: page=<https://broadwayscorecard.com/... page that shows it> owner="<their words, copied exactly>"  then send them a screenshot of that live page before you close.\n`);
      return 0;
    }
    const command = arg(argv, 'command');
    const marker = parseMarker(command);
    const source = pushSource(command);
    const tp = arg(argv, 'transcript');
    const events = tp ? walkTranscript(tp) : [];
    const session = arg(argv, 'session');
    let size = { files: null, lines: null, problem: 'nothing to size' };
    let sha = null; let pid = null;
    if (marker && source) {
      try {
        sha = execFileSync('git', ['rev-parse', '--verify', `${source}^{commit}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        ({ size, patchId: pid } = uiSize(repo, `origin/main...${sha}`, pattern));
      } catch (e) { size = { files: null, lines: null, problem: `could not size ${source} (${String(e.message).split('\n')[0].slice(0, 80)})` }; }
    }
    const obligation = readObligation(session);
    const enforcement = enforcementProblem({ projectDir: arg(argv, 'project-dir') || repo });
    const d = decide({ marker, source, events, size, enforcement, obligation, patchId: pid });
    if (d.allowed) {
      if (!session) { d.allowed = false; d.reason = 'no session id: the screenshot debt could not be recorded'; }
      else {
        recordPush(session, { page: d.page, quote: d.quote, ref: source, sha, patchId: pid, ownerKey: d.ownerKey, files: d.files, lines: d.lines });
        appendLog(`small-fix-lane\t${source}@${String(sha).slice(0, 12)} files=${d.files} lines=${d.lines} page=${d.page}`);
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
    const d = stopDecision({ events, lastMessage, obligation, stopHookActive: input.stop_hook_active === true, cwd: input.cwd || process.cwd() });
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
  main(process.argv.slice(2)).then((c) => exitFlushed(c), (e) => {
    // Fail toward the normal gate: a crash in `check` exits 1 (lane closed); the Stop hook passes.
    console.error(`visual-small-fix: ${e?.message || e}`);
    exitFlushed(process.argv[2] === 'check' ? 1 : 0);
  });
}
