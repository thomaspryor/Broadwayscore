'use strict';
/**
 * owner-decision-notify.js — pure helpers for the off-Mac "new decisions are
 * waiting on you" email (BRO-4719).
 *
 * Why: the owner asked (2026-10-05) "How will I ever know that they're waiting
 * on me for a decision? I didn't even know they existed!" and "don't rely on
 * the Mac Studio". The only channel was the Mac-hosted morning digest, which
 * lists `awaiting-owner`-labelled cards only, while most real owner holds were
 * written as description wording. A queue triage that day found 31 real
 * decisions the owner had never seen.
 *
 * The marker is deliberately strict: a line that STARTS with
 * "DECISION NEEDED:" outside code fences and inline code, carrying real text
 * (template placeholders such as "<what, one sentence>" are skipped). Loose
 * owner-hold wording ("needs owner approval") is a dispatch gate in
 * headless-dispatchability.js, which is default-deny and far too broad to
 * email on. Cards carrying the awaiting-owner label count too.
 *
 * Side-effect free: scripts/notify-owner-decisions.js does the I/O.
 */

const { AWAITING_OWNER_LABEL } = require('./owner-approval-channel.js');
const { isEmptyDecisionContent } = require('./needs-you-snapshot.js');

const MAX_LISTED = 35; // the first run carries the 31-card backlog; one email, not three days of them
const MAX_QUESTION_CHARS = 220;
// Plain, bold, bulleted, quoted, numbered or heading lines; "DECISION NEEDED
// (owner):" too.
const MARKER_RE = /^\s*(?:#{1,6}\s+|[-*>]\s+|\d+[.)]\s+)?\**DECISION NEEDED\**(?:\s*\([^)]*\))?\s*:\s*\**\s*(\S.*)$/i;
// Stub or leftover lines a session wrote instead of deleting the block.
const SETTLED_RE = /^\s*(?:answered|resolved|decided|done|closed)\b/i;

function stripCode(text) {
  const out = [];
  let inFence = false;
  for (const line of String(text || '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    out.push(line.replace(/`[^`]*`/g, ''));
  }
  return out;
}

function isPlaceholder(q) {
  return /^</.test(q) || /<(?:what|why|name|upside|downside|x|y)\b/i.test(q) || /^\.{3}$/.test(q);
}

// First real "DECISION NEEDED: <question>" line in a description, or null.
function extractDecisionQuestion(description) {
  for (const line of stripCode(description)) {
    const m = MARKER_RE.exec(line);
    if (!m) continue;
    const q = m[1].replace(/\*+$/, '').trim();
    if (!q || isPlaceholder(q) || isEmptyDecisionContent(q) || SETTLED_RE.test(q)) continue;
    return q.length > MAX_QUESTION_CHARS ? `${q.slice(0, MAX_QUESTION_CHARS - 1)}…` : q;
  }
  return null;
}

function labelNames(issue) {
  const nodes = issue && issue.labels && Array.isArray(issue.labels.nodes) ? issue.labels.nodes : [];
  return nodes.map((l) => l && l.name).filter(Boolean);
}

// Linear priority: 1 urgent, 2 high, 3 medium, 4 low, 0 none. Rank 0 last.
function priorityRank(p) { return Number.isInteger(p) && p > 0 ? p : 5; }

// Open issues → [{ identifier, title, url, question, priority }] for every
// card that is waiting on the owner. Most urgent first, then oldest, so the
// top of a long email is what matters most (the owner reads it on a phone).
function findOwnerDecisions(issues) {
  const out = [];
  for (const issue of issues || []) {
    if (!issue || !issue.identifier) continue;
    const question = extractDecisionQuestion(issue.description);
    const labelled = labelNames(issue).includes(AWAITING_OWNER_LABEL);
    if (!question && !labelled) continue;
    out.push({
      identifier: issue.identifier,
      title: issue.title || issue.identifier,
      url: issue.url || null,
      question: question || null,
      priority: issue.priority ?? null,
      createdAt: issue.createdAt || null,
    });
  }
  return out.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority)
    || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

// Which decisions to email about, and the notified set to store once the
// email is actually delivered. Only the cards listed in the email count as
// told; the set is pruned to decisions still open so it cannot grow forever,
// and a card whose marker is removed and later re-added is announced again.
function planNotification(decisions, notifiedIds, { maxListed = MAX_LISTED } = {}) {
  const told = new Set(Array.isArray(notifiedIds) ? notifiedIds : []);
  const fresh = decisions.filter((d) => !told.has(d.identifier));
  const listed = fresh.slice(0, maxListed);
  const openIds = new Set(decisions.map((d) => d.identifier));
  const nextNotified = [...new Set([...told, ...listed.map((d) => d.identifier)])]
    .filter((id) => openIds.has(id))
    .sort();
  return { fresh, listed, more: fresh.length - listed.length, nextNotified, totalOpen: decisions.length };
}

function plural(n, one, many) { return n === 1 ? one : many; }

// Plain-English email for a non-technical owner. No jargon, one link per card.
function formatEmail(plan) {
  const n = plan.fresh.length;
  const title = `${n} new ${plural(n, 'decision is', 'decisions are')} waiting on you`;
  const lines = [
    `${n === 1 ? 'This card is' : 'These cards are'} paused until you choose${n > 1 ? ', most urgent first' : ''}. Nothing else needs you.`,
    '',
  ];
  for (const d of plan.listed) {
    lines.push(`- ${d.question || d.title}`);
    if (d.question && d.question !== d.title) lines.push(`  (card: ${d.title})`);
    if (d.url) lines.push(`  ${d.url}`);
  }
  if (plan.more > 0) lines.push('', `+${plan.more} more. They will be in the next email.`);
  const others = plan.totalOpen - n;
  if (others > 0) lines.push('', `${others} older ${plural(others, 'decision is', 'decisions are')} still waiting too.`);
  lines.push('', 'To answer, open the card to read the options, then tell Claude in any chat the card name and the option you picked.');
  return { title, description: lines.join('\n') };
}

module.exports = {
  MAX_LISTED,
  extractDecisionQuestion,
  findOwnerDecisions,
  planNotification,
  formatEmail,
};
