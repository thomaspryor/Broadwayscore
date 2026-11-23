#!/usr/bin/env node
// BRO-8083 (port of BRO-8079 requirement 3 to cloud): a session may use only a few self-certified NO-* bypass lines.
// Every NO-* line clears a gate by assertion alone; 12bb3cbc cleared its gates that way and the owner later found
// broken work. The Mac gates have no budget, and cloud never loads them, so the count lives here: the one Stop hook
// cloud runs (.claude/hooks/verify-edits.sh, [VE:BYPASSBUDGET]).
// Counts lines "NO-<TOKEN>: <reason of 10+ chars>" for the six cloud tokens, across ALL assistant text in the
// transcript plus the closing message, outside code fences. Each distinct (token, reason) line counts once.
// Over BYPASS_BUDGET blocks the stop (at most BLOCK_BUDGET times per session); the way out is to do the skipped
// steps for real, not another bypass. Kill switch BYPASS_BUDGET_STOP_DISABLE=1. Fails open on any error.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMainModule } from './is-main-module.mjs';

export const BYPASS_BUDGET = 3;
export const BLOCK_BUDGET = 2;
export const TOKENS = ['NO-VERIFY', 'NO-CARD', 'NO-SHIP-CHECK', 'NO-WRAP-UP', 'NO-WHAT-ELSE', 'NO-OWNER-STEPS'];
const LINE_RE = new RegExp(`^[ \\t>*_-]*(${TOKENS.join('|')})(?:\\*\\*)?[ \\t]*:[ \\t]*(\\S.{9,})$`, 'i');

/** Bypass lines in one message: fenced blocks dropped, one entry per distinct token+reason. */
export function bypassLines(text) {
  const out = new Map();
  for (const ln of String(text || '').replace(/```[\s\S]*?```/g, '').split('\n')) {
    const m = LINE_RE.exec(ln);
    if (m) out.set(`${m[1].toUpperCase()}|${m[2].trim().toLowerCase()}`, m[1].toUpperCase());
  }
  return out;
}

export function assistantTexts(transcriptPath) {
  const texts = [];
  for (const raw of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let o; try { o = JSON.parse(raw); } catch { continue; }
    if (o.type !== 'assistant') continue;
    const c = o.message && o.message.content;
    if (typeof c === 'string') texts.push(c);
    else if (Array.isArray(c)) for (const b of c) if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
  }
  return texts;
}

/** PURE decision over the assistant texts + closing message. */
export function decide({ texts = [], closing = '', env = process.env }) {
  if (env.CLAUDE_CODE_REMOTE !== 'true') return { decision: 'allow', reason: 'not a cloud session' };
  if (env.BYPASS_BUDGET_STOP_DISABLE === '1') return { decision: 'allow', reason: 'BYPASS_BUDGET_STOP_DISABLE=1' };
  const seen = new Map();
  for (const t of [...texts, closing]) for (const [k, tok] of bypassLines(t)) seen.set(k, tok);
  if (seen.size <= BYPASS_BUDGET) return { decision: 'allow', reason: `${seen.size} bypass lines, within budget` };
  const tokens = [...new Set(seen.values())];
  return {
    decision: 'block', count: seen.size,
    message: [
      `BLOCKED (BRO-8083): this session has used ${seen.size} NO-* bypass lines (${tokens.join(', ')}); the budget is ${BYPASS_BUDGET}.`,
      'A bypass line asserts a step was not needed; it does not prove it. Past the budget, do the skipped steps for real: run /ship-check, /what-else and /wrap-up, file or close the card, run the verification, then stop again.',
      'Writing another NO-* line will not clear this.',
    ].join('\n'),
  };
}

export function main(argv, { env = process.env, stdin = null } = {}) {
  if (!argv.includes('--stop-hook')) { process.stderr.write('usage: bypass-budget-stop.mjs --stop-hook\n'); return 0; }
  let input = {};
  try { input = JSON.parse(stdin ?? (fs.readFileSync(0, 'utf8') || '{}')); } catch { return 0; }
  let texts = [];
  try { if (input.transcript_path) texts = assistantTexts(input.transcript_path); } catch { return 0; }
  const d = decide({ texts, closing: input.last_assistant_message || '', env });
  if (d.decision !== 'block') return 0;
  const id = createHash('sha1').update(String(input.transcript_path || input.session_id || '')).digest('hex').slice(0, 12);
  const counter = path.join(os.tmpdir(), `bypass-budget-stop-${id}`);
  let n = 0;
  try { n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0; } catch { /* first */ }
  if (n >= BLOCK_BUDGET) return 0;
  try { fs.writeFileSync(counter, String(n + 1)); } catch { /* best effort */ }
  process.stderr.write(d.message + '\n');
  return 2;
}

if (isMainModule(import.meta.url)) {
  let code = 0;
  try { code = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`bypass-budget-stop: internal error (failing open): ${e && e.message}\n`); code = 0; }
  process.exitCode = code;
}
