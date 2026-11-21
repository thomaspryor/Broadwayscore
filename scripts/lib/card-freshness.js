#!/usr/bin/env node
'use strict';
/**
 * Resume freshness (BRO-7918, FIX 2). A resumed session answered "the fix isn't live yet" from memory while its
 * card (BRO-7741) was Done and the commits were on main. On a resume, find the BRO-N cards the session worked on
 * (title, transcript, branch) and print each card's live Linear status, so the first answer starts from facts.
 *
 *   extractCardIds(texts)            pure: BRO-N ids, most-mentioned first, capped
 *   buildFreshnessNotice(cards)      pure: the injected text ('' when nothing to say)
 *   freshnessNotice({...})           reads transcript, fetches Linear (injectable), fails open to ''
 *
 * CLI (session-start.sh, resume only): `node card-freshness.js` reads the SessionStart JSON on stdin.
 * Kill switch: CARD_FRESHNESS_DISABLED=true.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_CARDS = 3;
const TAIL_BYTES = 400000;

function extractCardIds(texts, max = MAX_CARDS) {
  const counts = new Map();
  for (const t of texts) {
    for (const m of String(t || '').matchAll(/\bBRO-(\d{2,6})\b/g)) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || Number(b[0].slice(4)) - Number(a[0].slice(4))).slice(0, max).map(([id]) => id);
}

function latestComment(issue) {
  const nodes = (issue && issue.comments && issue.comments.nodes) || [];
  if (!nodes.length) return null;
  return nodes.reduce((a, b) => (String(b.createdAt) > String(a.createdAt) ? b : a));
}

function buildFreshnessNotice(cards) {
  const rows = (cards || []).filter((c) => c && c.identifier && c.state && c.state.name);
  if (!rows.length) return '';
  const lines = ['🔄 CARD STATUS NOW (read before you answer from memory; this session was resumed and may be stale):'];
  for (const c of rows) {
    const upd = c.updatedAt ? String(c.updatedAt).slice(0, 10) : 'unknown';
    const lc = latestComment(c);
    lines.push(`   ${c.identifier} is now ${c.state.name} (updated ${upd}): read its latest comment` +
      `${lc ? ` (${String(lc.createdAt).slice(0, 10)})` : ''} and git log origin/main before answering; do not claim work is unreleased without checking.`);
  }
  return lines.join('\n');
}

function transcriptTail(file) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function findTranscript(input, env) {
  if (input && input.transcript_path && fs.existsSync(input.transcript_path)) return input.transcript_path;
  const id = (input && input.session_id) || env.CLAUDE_CODE_SESSION_ID;
  if (!id) return '';
  const base = path.join(env.HOME || os.homedir(), '.claude', 'projects');
  try {
    for (const d of fs.readdirSync(base)) { const f = path.join(base, d, `${id}.jsonl`); if (fs.existsSync(f)) return f; }
  } catch { /* none */ }
  return '';
}

async function freshnessNotice({ input = {}, env = process.env, title = '', branch = '', fetchIssue, transcriptText } = {}) {
  if (/^(1|true)$/i.test(env.CARD_FRESHNESS_DISABLED || '')) return '';
  const text = transcriptText != null ? transcriptText : transcriptTail(findTranscript(input, env));
  // Title and branch first-class (counted 3x): they name the session's own card, the transcript only mentions others.
  const ids = extractCardIds([title, title, title, branch, branch, branch, text]);
  if (!ids.length) return '';
  const fetch = fetchIssue || require('./linear-client.js').getIssue;
  const settled = await Promise.all(ids.map((id) => Promise.resolve().then(() => fetch(id)).catch(() => null)));
  return buildFreshnessNotice(settled);
}

if (require.main === module) {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { /* ignore */ }
  const timer = setTimeout(() => process.exit(0), 8000);
  freshnessNotice({ input, title: input.session_title || input.title || '', branch: process.env.CLAUDE_BRANCH || '' })
    .then((t) => { if (t) process.stdout.write(`${t}\n`); })
    .catch(() => {})
    .finally(() => { clearTimeout(timer); process.exit(0); });
}

module.exports = { extractCardIds, buildFreshnessNotice, freshnessNotice, latestComment };
