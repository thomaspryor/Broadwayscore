#!/usr/bin/env node
// BRO-7552: a session may not call a change "verified" while its own evidence says the effect is not measured.
//
// 2026-11-15: a cloud session changed the SERP/fetch chain to cut scraping spend and ended
// "SAFE TO ARCHIVE: both changes are live and verified". The child card behind one of the changes said
// "EFFECT: ... ledger numbers pending", and the spend ledger would have shown within the hour that it saved
// nothing; the other change had doubled the cost of a Broadway press-night pass and nobody measured that flow.
// Every Stop gate passed: /did-it-work only needs any non-look command, EFFECT only needed a digit.
//
// This Stop check (cloud only, claims SAFE TO ARCHIVE) refuses three things:
//   1. PENDING: the closing message says verified / proven / working while the latest EFFECT line of any source
//      in this chunk of work (the session's own chat and Linear writes, and each card it READ through the
//      Linear connector) defers the measurement (isPendingEffect in root-cause-close.js).
//   2. UNMEASURED SPEND: the session edited fetch / SERP code (FETCH_PATH_RE, or an edit mentioning a paid
//      vendor) and landed it, but never ran `node scripts/spend-effect-check.js --since=...` after the landing
//      and wrote no `NO-EFFECT-CHECK: <reason>`. Also refuses "Phase 3: skipped: no data effect" for such a
//      change. RECHECK-AFTER does not replace the run: it is accepted only once the run's own verdict says
//      there is nothing to observe yet (idle / pending), which is exactly when "not yet proven until <date>" is true.
//   3. CONTRADICTED: the last spend-effect-check run printed OVERALL VERDICT WORSE or NO CHANGE and the closing
//      message still claims it verified.
// A message that says plainly "live, not yet proven until <date>" passes: the check polices the word "verified",
// not honesty about being early.
//
// Not judged: whether the measurement is good. The tool itself (scripts/spend-effect-check.js) is not run here,
// the hook only checks that it was run (a 70k-line ledger does not belong in a 15s Stop hook).
//
// Rollout (CLAUDE.md section 19): one nudge per chunk of work until EFFECT_PENDING_BLOCKING_FROM, then two. Every
// block decision is logged to .cache/effect-pending-stop.log so the hit rate is readable; scripts/effect-pending-dryrun.mjs
// replays past transcripts. Fails open on any error; kill switch EFFECT_PENDING_STOP_DISABLE=1.
// Wired in .claude/hooks/verify-edits.sh; pinned by effect-pending-stop.test.mjs.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { walkTranscript } from './transcript-scan.mjs';
import { landedPushIndices, claimsSafeToArchive, runShellCode, lastAcceptedClaimIndex } from './review-coverage.mjs';
import { answerTexts } from './root-cause-stop.mjs';

const require = createRequire(import.meta.url);
const { isPendingEffect } = require('./root-cause-close.js');

export const EFFECT_PENDING_BLOCKING_FROM = '2026-11-22';
// Files whose behaviour changes what the fetch / SERP chain spends. Test files do not count.
export const FETCH_PATH_RE = /(?:^|\/)scripts\/(?:lib\/(?:url-discovery|scraper|site-search-discovery|free-first-fetch|serp-[\w-]+|[\w-]*-serp|[\w-]*url-discovery|provider-telemetry|brightdata-caps|scrapingdog-caps)|gather-reviews|opening-night-poller)\.(?:js|mjs)$/;
// An edit to any other file that wires in a paid vendor or the ledger is the same kind of change.
// The gate's own scripts name vendors in their text; editing them is not a spend change.
const SELF_RE = /(?:^|\/)scripts\/(?:spend-effect-check|effect-pending-dryrun)\.(?:js|mjs)$|(?:^|\/)scripts\/lib\/effect-pending-stop\.mjs$/;
const VENDOR_HINT_RE = /\b(?:_serpWithChain|fetchPage\(|recordScraperSpend|scraper-spend-ledger|scrapingbee|scrapingdog|brightdata|browserbase)\b/i;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const LINEAR_READ_TOOL_RE = /(?:linear.*__|^mcp__[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}__)(?:list_comments|get_issue)$/i;
const NO_EFFECT_CHECK_RE = /^[ \t>*_-]*NO-EFFECT-CHECK(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*(\S.{14,})$/im;
const PHASE3_SKIP_RE = /Phase 3:?\s*skipped:?\s*no data (?:effect|files? changed)/i;

// "verified" in a plain claim. Negations ("not yet verified", "unverified", "live, not yet proven until") are removed first.
const NEGATED_RE = /\b(?:not(?: yet| fully)?|never|un|isn'?t|aren'?t|cannot be|can'?t be)\s*(?:be\s+)?(?:verified|proven|confirmed)\b|\bunverified\b|\bnot yet proven\b/gi;
const CLAIM_RE = /\bverified\b|\bproven\b|\b(?:is|are|now|all) working\b|\bconfirmed (?:working|live|saving|savings)\b|\blive and confirmed\b|\bsavings confirmed\b|\bit works\b|\bworks in production\b/i;

/** PURE. Does the closing message claim the work is verified / proven / working? */
export function claimsVerified(message) {
  const text = String(message || '').replace(/```[\s\S]*?```/g, '').replace(NEGATED_RE, ' ');
  return CLAIM_RE.test(text);
}

// An EFFECT field starts a line OR sits inline in a one-paragraph report (the real BRO-7532 comment: "... CLASS-GUARD: x.
// EFFECT: live check 5/5 ...; ledger numbers pending EXECUTED: ..."). It runs to the next sibling field or the line end.
// `NO-EFFECT-CHECK:` is not an EFFECT (the char before must not be a word char or hyphen).
const EFFECT_FIELD_RE = /(?:^|[^\w-])EFFECT(?:\*\*|__)?:(?:\*\*|__)?[ \t]*([^\n]*?)(?=[ \t]+(?:EXECUTED|ROOT-CAUSE|CLASS-GUARD|PREVENTION|COUSINS|RED-THEN-GREEN|COVERAGE|NO-EFFECT-CHECK|RECHECK-AFTER|Key files|Verification)\b[^\n]{0,3}:|\n|$)/g;

/** PURE. The last EFFECT value in a text (line-start or inline), or null. */
export function lastEffectLine(text) {
  let last = null;
  for (const m of String(text || '').matchAll(EFFECT_FIELD_RE)) {
    const v = m[1].replace(/[ \t]*(?:\*\*|__)[ \t]*$/, '').trim();
    if (v) last = v;
  }
  return last;
}

// list_comments returns JSON newest-first; a card's current EFFECT is the newest comment that has one.
function linearReadText(content) {
  try {
    const j = JSON.parse(content);
    if (Array.isArray(j.comments)) {
      const bodies = [...j.comments].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map((c) => String(c.body || ''));
      return bodies.join('\n');
    }
    if (typeof j.description === 'string') return j.description;
  } catch { /* not JSON: use the raw text */ }
  return String(content || '');
}

/**
 * PURE. The newest EFFECT line per source, for the chunk after `from`. Sources: 'self' (the session's own chat
 * and Linear writes, newest wins) and `card:<issue>` for each card read through the Linear connector. Output of
 * grep, cat, node and test fixtures is never read (BRO-7349: quoted text is not the session's answer).
 * -> [{ source, value, pending }]
 */
// <cross-session-message from-session="X">body</...> or <agent-message from="X">body</...> (the harness's peer envelopes).
const PEER_ENVELOPE_RE = /<(cross-session-message|agent-message)\b[^>]*?\bfrom(?:-session)?="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/g;
export function effectSources(events, from, lastMessage) {
  const chunk = events.slice(from + 1);
  const out = new Map();
  let self = null;
  for (const t of answerTexts(chunk, lastMessage)) { const v = lastEffectLine(t); if (v) self = v; }
  if (self) out.set('self', self);
  const uses = new Map();
  for (const e of chunk) if (e.kind === 'assistant_tool_use' && LINEAR_READ_TOOL_RE.test(e.name || '')) uses.set(e.id, e);
  for (const e of chunk) {
    if (e.kind !== 'tool_result' || e.isError || !uses.has(e.tool_use_id)) continue;
    const v = lastEffectLine(linearReadText(e.content));
    if (!v) continue;
    const u = uses.get(e.tool_use_id);
    out.set(`card:${u.input?.issueId || u.input?.id || e.tool_use_id}`, v);
  }
  // A child's REPORT-BACK reaches a parent as an inbound peer turn (not its own text, not a card read): the 2026-11-15
  // pending EFFECT arrived that way. Only text inside a peer envelope counts, never the owner's own typed message.
  const PEER_USE_RE = /claude-code-remote__(?:get_event|list_events|get_session)$/;
  for (const e of chunk) {
    if (e.kind === 'assistant_tool_use' && PEER_USE_RE.test(e.name || '')) uses.set(e.id, e);
    const raw = e.kind === 'user_text' ? e.text : e.kind === 'tool_result' && !e.isError ? e.content : null;
    if (!raw) continue;
    const t = typeof raw === 'string' ? raw : JSON.stringify(raw);
    for (const m of t.matchAll(PEER_ENVELOPE_RE)) {
      const v = lastEffectLine(m[3]);
      if (v) out.set(`peer:${m[2] || m[1] || 'session'}`, v);
    }
    if (e.kind === 'tool_result' && uses.has(e.tool_use_id) && PEER_USE_RE.test(uses.get(e.tool_use_id).name || '')) {
      const v = lastEffectLine(t.replace(/\\n/g, '\n'));
      if (v) out.set(`peer:${uses.get(e.tool_use_id).input?.session_id || 'session'}`, v);
    }
  }
  return [...out].map(([source, value]) => ({ source, value, pending: isPendingEffect(value) }));
}

/** PURE. Files this chunk edited that change what the fetch / SERP chain spends. */
export function fetchEdits(events, from) {
  const files = new Set();
  for (const e of events.slice(from + 1)) {
    if (e.kind !== 'assistant_tool_use' || !EDIT_TOOLS.has(e.name)) continue;
    const f = String(e.input?.file_path || e.input?.notebook_path || '');
    if (!f || /\.test\.(?:m?js|ts)$/.test(f) || SELF_RE.test(f)) continue;
    const body = String(e.input?.new_string ?? e.input?.content ?? '') + (Array.isArray(e.input?.edits) ? e.input.edits.map((x) => x.new_string).join('\n') : '');
    if (FETCH_PATH_RE.test(f) || (/\/scripts\//.test(f) && VENDOR_HINT_RE.test(body))) files.add(f);
  }
  return [...files];
}

/**
 * PURE. Runs of the spend-effect-check tool after index `after`: [{ i, verdict }] (verdict from its own
 * "OVERALL VERDICT:" line, or 'unknown'). Only a Bash command the shell really runs counts.
 */
export function spendCheckRuns(events, after) {
  const results = new Map(events.filter((e) => e.kind === 'tool_result').map((e) => [e.tool_use_id, e]));
  const runs = [];
  events.forEach((e, i) => {
    if (i <= after || e.kind !== 'assistant_tool_use' || e.name !== 'Bash') return;
    if (!/spend-effect-check\.js/.test(runShellCode(e.input?.command)) || !/--since/.test(String(e.input?.command))) return;
    const r = results.get(e.id);
    if (!r || r.isError) return;
    const m = /OVERALL VERDICT:\s*(WORSE|NO CHANGE|saved|new|idle|pending)/.exec(String(r.content || '')) || /"verdict":\s*"(WORSE|NO CHANGE|saved|new|idle|pending)"/.exec(String(r.content || ''));
    runs.push({ i, verdict: m ? m[1] : 'unknown' });
  });
  return runs;
}

export function blockBudget(now = new Date()) {
  return now.toISOString().slice(0, 10) >= EFFECT_PENDING_BLOCKING_FROM ? 2 : 1;
}

export function blockMessage(problems) {
  return [
    `BLOCKED (BRO-7552): this session claims SAFE TO ARCHIVE and calls the work verified, but its own evidence says the effect is not measured.`,
    ...problems.map((p) => `- ${p}`),
    'Fix it one of two ways:',
    '  1. Measure it now. For a spend change: node scripts/spend-effect-check.js --since=<ISO time it went live> --hosts=<hosts> (add --hosts=serp for search), read every flow it prints, Broadway and West End press night included, then write the numbers in EFFECT: and fix what it shows (WORSE or NO CHANGE is a defect, not a footnote).',
    '  2. Say plainly that it is early: "live, not yet proven until <date>", do not use the word verified, and keep the card Paused with RECHECK-AFTER. RECHECK-AFTER is only for an effect whose first observation is more than 24 hours away; if the tool printed idle or pending, that is the case.',
    'A test that asserts the fallback to the paid route is not evidence of savings. Bypass for a change with no spend effect: NO-EFFECT-CHECK: <15+ chars on why>.',
  ].join('\n');
}

/**
 * PURE Stop-hook decision. -> { decision: 'allow'|'block', reason, message?, chunkKey? }
 */
export function stopHookDecision({ lastMessage = '', events = null, env = process.env }) {
  if (env.CLAUDE_CODE_REMOTE !== 'true') return { decision: 'allow', reason: 'not a cloud session' };
  if (env.EFFECT_PENDING_STOP_DISABLE === '1') return { decision: 'allow', reason: 'EFFECT_PENDING_STOP_DISABLE=1' };
  if (!claimsSafeToArchive(lastMessage)) return { decision: 'allow', reason: 'not claiming SAFE TO ARCHIVE' };
  if (!events || events.length === 0) return { decision: 'allow', reason: 'no transcript (fails open)' };
  // Chunk: after the previous accepted-looking SAFE TO ARCHIVE claim (the closing message itself is not in `events` yet, or is the same text).
  // BRO-7738: a claim another Stop hook refused is not a boundary (lastAcceptedClaimIndex).
  const from = lastAcceptedClaimIndex(events, lastMessage);
  const chunk = events.slice(from + 1);
  const claim = claimsVerified(lastMessage);
  const problems = [];
  const chunkTexts = answerTexts(chunk, lastMessage);
  const bypass = chunkTexts.some((t) => NO_EFFECT_CHECK_RE.test(t));

  const landed = landedPushIndices(events).filter((i) => i > from);
  const edits = fetchEdits(events, from);
  const runs = landed.length ? spendCheckRuns(events, landed[landed.length - 1]) : [];
  const sources = effectSources(events, from, lastMessage);
  const lastRun = runs[runs.length - 1] || null;
  if (lastRun && lastRun.verdict === 'pending') sources.push({ source: 'spend-effect-check', value: 'tool verdict: pending', pending: true });

  if (claim) {
    for (const s of sources.filter((x) => x.pending)) problems.push(`the closing message says verified, but the latest EFFECT line of ${s.source === 'self' ? 'this session' : s.source === 'spend-effect-check' ? 'the spend-effect-check run' : (s.source.startsWith('peer:') ? `a report from another session (${s.source.slice(5)})` : `a card it read (${s.source.slice(5)})`)} defers the measurement: "${s.value.slice(0, 140)}"`);
    if (lastRun && (lastRun.verdict === 'WORSE' || lastRun.verdict === 'NO CHANGE')) problems.push(`the last spend-effect-check run printed OVERALL VERDICT: ${lastRun.verdict}, so the change did not save money on every flow it serves`);
  }
  if (landed.length && edits.length && !runs.length && !bypass) {
    const files = edits.map((f) => f.replace(/^.*\/scripts\//, 'scripts/')).slice(0, 4).join(', ');
    problems.push(`this session landed a change to fetch / SERP code (${files}) and never ran scripts/spend-effect-check.js after landing it${chunkTexts.some((t) => PHASE3_SKIP_RE.test(t)) ? '; "Phase 3: skipped: no data effect" does not hold for a spend change' : ''}`);
  }
  if (!problems.length) return { decision: 'allow', reason: claim ? 'verified claim backed by measurement' : 'no verified claim and spend checked' };
  return { decision: 'block', chunkKey: from < 0 ? '' : String(events[from].messageId || events[from].ts || from), reason: problems.join(' | ').slice(0, 300), message: blockMessage(problems) };
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function logHit(entry) {
  try {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'effect-pending-stop.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* best effort */ }
}

export function main(argv, { env = process.env, now = new Date() } = {}) {
  if (!argv.includes('--stop-hook')) { process.stderr.write('usage: effect-pending-stop.mjs --stop-hook  (reads the Stop hook JSON on stdin)\n'); return 0; }
  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { return 0; }
  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) return 0;
  const d = stopHookDecision({ lastMessage: input.last_assistant_message || '', events: walkTranscript(tp), env });
  if (d.decision !== 'block') return 0;
  const counter = path.join(os.tmpdir(), `effect-pending-stop-${createHash('sha1').update(tp + '\u0000' + (d.chunkKey || '')).digest('hex').slice(0, 12)}`);
  let n = 0;
  try { n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0; } catch { /* first block */ }
  const budget = blockBudget(now);
  logHit({ session: input.session_id || null, chunk: d.chunkKey || null, blocked: n < budget, n, budget, reason: d.reason });
  if (n >= budget) return 0;
  try { fs.writeFileSync(counter, String(n + 1)); } catch { /* best effort */ }
  process.stderr.write(d.message + '\n');
  return 2;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 0;
  try { code = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`effect-pending-stop: internal error (failing open): ${e && e.message}\n`); code = 0; }
  process.exitCode = code;
}
