'use strict';
// BRO-6285: pure matcher for the owner-email-ask-guard PreToolUse hook.
// A session must not email the owner a question that wants a reply: nothing
// reads the reply, and a chat reply reaches one session only. Decisions go
// through a DECISION NEEDED card (.claude/CLOUD.md), which emails tap buttons.

const DEFAULT_OWNER = 'thomas.pryor@gmail.com';

// Phrases that ask the owner to reply to a session. Kept narrow on purpose:
// the real digest ("Decisions waiting on you"), decision email ("Why this is
// your call") and welcome email ("reply to this email") use broader wording.
const ASK_PATTERNS = [
  /\breply\s+(?:with\s+)?['"“‘]?(?:yes|no|ok|approve|approved)\b/i,
  /\breply\s+to\s+(?:claude|codex)\b/i,
  /\breply\s+['"“‘]?\w+['"”’]?\s+to\s+(?:claude|codex)\b/i,
  /\b(?:decision|question)\s+for\s+you\b/i,
  /\btell\s+(?:claude|codex)\b/i,
];

// Previews and test sends of real templates (digest, decision email, welcome)
// legitimately contain "waiting on you", "your call", "reply to this email".
const PREVIEW_SUBJECT = /^\s*(?:\[|\()\s*(?:preview|test)\b/i;

const BYPASS = /(?:^|\n)[ \t]*NO-OWNER-EMAIL-CHECK:[ \t]*\S/;

// Gmail ignores dots and +tags and treats googlemail.com as gmail.com.
function normalizeAddress(s) {
  return String(s).trim().toLowerCase().replace(/\+[^@]*@/, '@').replace(/@googlemail\.com$/, '@gmail.com').replace(/^([^@]+)@gmail\.com$/, (_, u) => `${u.replace(/\./g, '')}@gmail.com`);
}

function ownerAddress(env = process.env) {
  return normalizeAddress((env && env.OWNER_EMAIL) || DEFAULT_OWNER);
}

function addresses(v) {
  const list = Array.isArray(v) ? v : v == null ? [] : [v];
  const out = [];
  for (const item of list) {
    const s = typeof item === 'string' ? item : item && (item.email || item.address) ? String(item.email || item.address) : '';
    for (const part of s.split(/[,;]/)) {
      const m = part.match(/<([^>]+)>/);
      const a = normalizeAddress(m ? m[1] : part);
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
  const stripHtml = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
  const body = [input.body, input.htmlBody].filter((s) => typeof s === 'string').map(stripHtml).join('\n');
  if (PREVIEW_SUBJECT.test(subject)) return { blocked: false, matched: [], preview: true };
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
