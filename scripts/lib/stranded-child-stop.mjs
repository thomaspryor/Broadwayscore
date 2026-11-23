#!/usr/bin/env node
// BRO-8083 (port of BRO-8079 requirement 2 to cloud): a SAFE TO ARCHIVE closing must not leave a started session
// (mcp__claude-code-remote__create_session) stranded. A child that fails, blocks or goes idle without finishing sends
// no event to the parent, so waiting for an event never wakes anyone. This gate reads the transcript instead: for
// each child it takes the latest status_bucket the parent saw (get_session / list_events results) and refuses the
// closing when the child was never checked since it was created, or its last bucket is FAILED, BLOCKED or IDLE.
// WORKING and COMPLETED pass (owner 2026-10-22: a child that is working owns its work), and so does archive_session
// on the child. Cloud only, fails open, two blocks per session, kill STRANDED_CHILD_STOP_DISABLE=1.
// Wired in .claude/hooks/verify-edits.sh as [VE:STRANDEDKID]; pinned by scripts/tests/cloud-hook-replay.test.mjs.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMainModule } from './is-main-module.mjs';

export const BLOCK_BUDGET = 2;
const SAFE_RE = /^\W*SAFE TO (?:ARCHIVE|EXIT)\b/i;
const BAD_BUCKET_RE = /(FAILED|BLOCKED|IDLE)/i;
const SID_RE = /\b(?:session|cse)_[0-9A-Za-z]{10,}/;

const toolName = (n) => String(n || '').toLowerCase().split('__').pop(); // both server spellings (claude-code-remote / Claude_Code_Remote)

/** Walk the transcript; -> Map childId -> { title, lastBucket|null, archived } */
export function childStates(transcriptPath) {
  const uses = new Map(); // tool_use id -> { name, input }
  const kids = new Map();
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let o; try { o = JSON.parse(raw); } catch { continue; }
    if (o.isSidechain) continue;
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (o.type === 'assistant' && b && b.type === 'tool_use') uses.set(b.id, { name: toolName(b.name), input: b.input || {} });
      if (o.type === 'user' && b && b.type === 'tool_result') {
        const u = uses.get(b.tool_use_id); if (!u) continue;
        const text = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : '');
        if (b.is_error) continue;
        if (u.name === 'create_session') {
          const id = (text.match(SID_RE) || [])[0];
          if (id) kids.set(id, { title: u.input.title || id, lastBucket: null, archived: false });
        } else if (u.name === 'get_session') {
          // Only get_session is authoritative (list_events carries historical text). Read the field, not any mention.
          const k = kids.get(u.input.session_id); if (!k) continue;
          let bucket = null;
          try { const o2 = JSON.parse(text); const c2 = o2.ccr || o2; bucket = c2.status_bucket || c2.session_status || null; if (c2.external_metadata && c2.external_metadata.last_init_error) bucket = 'FAILED'; } catch { /* not JSON */ }
          if (bucket === null) { const m = text.match(/"status_bucket"\s*:\s*"([A-Z_]+)"/); if (m) bucket = m[1]; }
          if (bucket) k.lastBucket = String(bucket).replace(/^SESSION_STATUS_(?:BUCKET_)?/, '');
        } else if (u.name === 'archive_session') {
          const k = kids.get(u.input.session_id); if (k) k.archived = true;
        }
      }
    }
  }
  return kids;
}

export function decide({ kids, closing = '', env = process.env }) {
  if (env.CLAUDE_CODE_REMOTE !== 'true') return { decision: 'allow', reason: 'not a cloud session' };
  if (env.STRANDED_CHILD_STOP_DISABLE === '1') return { decision: 'allow', reason: 'STRANDED_CHILD_STOP_DISABLE=1' };
  const lastLine = String(closing).replace(/```[\s\S]*?```/g, '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  if (!SAFE_RE.test(lastLine)) return { decision: 'allow', reason: 'not a SAFE TO ARCHIVE closing' };
  const stranded = [];
  for (const [id, k] of kids) {
    if (k.archived) continue;
    if (k.lastBucket === null) stranded.push(`${k.title} (${id}): never checked since it was started`);
    else if (BAD_BUCKET_RE.test(k.lastBucket)) stranded.push(`${k.title} (${id}): last status ${k.lastBucket}`);
  }
  if (!stranded.length) return { decision: 'allow', reason: 'no stranded child' };
  return {
    decision: 'block', stranded,
    message: [
      'BLOCKED (BRO-8083): SAFE TO ARCHIVE while a session this one started may be stranded. A finished or failed child sends no event, so nobody will wake you.',
      ...stranded.map((s) => `- ${s}`),
      'Call get_session on each child now. If it failed, is blocked or is idle without landing, fix or restart it, or say KEEP OPEN with what wakes you. When it is COMPLETED or has landed, or you archive it, stop again.',
    ].join('\n'),
  };
}

export function main(argv, { env = process.env, stdin = null } = {}) {
  if (!argv.includes('--stop-hook')) { process.stderr.write('usage: stranded-child-stop.mjs --stop-hook\n'); return 0; }
  let input = {};
  try { input = JSON.parse(stdin ?? (fs.readFileSync(0, 'utf8') || '{}')); } catch { return 0; }
  if (!input.transcript_path) return 0;
  let kids;
  try { kids = childStates(input.transcript_path); } catch { return 0; }
  const d = decide({ kids, closing: input.last_assistant_message || '', env });
  if (d.decision !== 'block') return 0;
  const id = createHash('sha1').update(String(input.transcript_path) + '\u0000' + String(input.session_id || '')).digest('hex').slice(0, 12);
  const counter = path.join(os.tmpdir(), `stranded-child-stop-${id}`);
  let n = 0;
  try { n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0; } catch { /* first */ }
  if (n >= BLOCK_BUDGET) return 0;
  try { fs.writeFileSync(counter, String(n + 1)); } catch { return 0; } // cannot persist the cap: fail open, never wedge Stop
  process.stderr.write(d.message + '\n');
  return 2;
}

if (isMainModule(import.meta.url)) {
  let code = 0;
  try { code = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`stranded-child-stop: internal error (failing open): ${e && e.message}\n`); code = 0; }
  process.exitCode = code;
}
