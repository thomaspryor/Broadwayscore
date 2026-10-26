'use strict';
// BRO-6285: pure matcher for the owner-email-ask-guard PreToolUse hook.
// A session must not email the owner a question that wants a reply: nothing
// reads the reply, and a chat reply reaches one session only. Decisions go
// through a DECISION NEEDED card (.claude/CLOUD.md), which emails tap buttons.

const DEFAULT_OWNER = 'thomas.pryor@gmail.com';

// Phrases that ask the owner for a reply or a decision. Kept narrow: digests
// and previews say "your call" rarely, but "reply yes" / "tell claude" never.
const ASK_PATTERNS = [
  /\breply\s+(?:with\s+)?['"“‘]?(?:yes|no|ok|go|approve|approved|a|b)\b/i,
  /\breply\s+to\s+(?:claude|codex|me|this\s+(?:email|session))\b/i,
  /\breply\s+['"“‘]?\w+['"”’]?\s+to\s+(?:claude|codex)\b/i,
  /\b(?:decision|question)\s+for\s+you\b/i,
  /\bone\s+decision\b/i,
  /\btell\s+(?:claude|codex)\b/i,
  /\bwaiting\s+(?:on|for)\s+(?:you|your\s+(?:reply|answer|call|decision))\b/i,
  /\byour\s+call\b/i,
];

const BYPASS = /(?:^|\n)[ \t]*NO-OWNER-EMAIL-CHECK:[ \t]*\S/;

function ownerAddress(env = process.env) {
  return String((env && env.OWNER_EMAIL) || DEFAULT_OWNER).trim().toLowerCase();
}

function addresses(v) {
  const list = Array.isArray(v) ? v : v == null ? [] : [v];
  const out = [];
  for (const item of list) {
    const s = typeof item === 'string' ? item : item && (item.email || item.address) ? String(item.email || item.address) : '';
    for (const part of s.split(/[,;]/)) {
      const m = part.match(/<([^>]+)>/);
      const a = (m ? m[1] : part).trim().toLowerCase();
      if (a) out.push(a);
    }
  }
  return out;
}

function toOwner(input, owner) {
  const all = [].concat(addresses(input.to), addresses(input.cc), addresses(input.bcc));
  return all.includes(owner);
}

// Returns { blocked: bool, matched: string[] , reason?: string }.
function checkOwnerEmail(toolInput, env = process.env) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const owner = ownerAddress(env);
  if (!toOwner(input, owner)) return { blocked: false, matched: [] };
  const subject = typeof input.subject === 'string' ? input.subject : '';
  const body = typeof input.body === 'string' ? input.body : typeof input.htmlBody === 'string' ? input.htmlBody : '';
  if (BYPASS.test(body) || BYPASS.test(subject)) return { blocked: false, matched: [], bypassed: true };
  const text = `${subject}\n${body}`;
  const matched = ASK_PATTERNS.filter((re) => re.test(text)).map((re) => text.match(re)[0]);
  if (!matched.length) return { blocked: false, matched: [] };
  return { blocked: true, matched, reason: denyMessage(matched) };
}

function denyMessage(matched) {
  return [
    `Blocked: this email to the owner asks for a reply or decision (matched: ${matched.map((m) => `"${m}"`).join(', ')}) (BRO-6285).`,
    'Nothing reads an emailed reply, and a reply typed in a chat goes to one named session only, so "reply yes to Claude or Codex" is never acceptable wording: the owner cannot tell which session that means.',
    'If you need a decision: file it as a DECISION NEEDED card (node scripts/linear-brain.js create "DECISION NEEDED: <question>" ... with the decision block from .claude/CLOUD.md), so the system emails tap-to-answer buttons.',
    'If this is only a status report or preview: remove the request for a reply and resend.',
    'Bypass for a legitimate case: add a line `NO-OWNER-EMAIL-CHECK: <reason>` to the body.',
  ].join(' ');
}

module.exports = { checkOwnerEmail, ownerAddress, ASK_PATTERNS, DEFAULT_OWNER };
