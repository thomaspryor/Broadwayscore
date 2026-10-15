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

const crypto = require('crypto');
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

// Linear stores a bare URL as [url](<url>) (an address as [a](<mailto:a>)).
// Collapsed back so the 220-char cap never clips a signed owner link's second
// copy mid-signature (BRO-5235), and the dedupe hash reads the same before and
// after Linear's rewrite.
function collapseSelfLinks(text) {
  return String(text || '').replace(/\[([^\]\s]{1,2048})\]\(<?(?:mailto:)?\1>?\)/g, '$1');
}

// First real "DECISION NEEDED: <question>" line in a description, or null.
function extractDecisionQuestion(description) {
  for (const line of stripCode(description)) {
    const m = MARKER_RE.exec(line);
    if (!m) continue;
    const q = collapseSelfLinks(m[1]).replace(/\*+$/, '').trim();
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
// Entries are "ID@<question hash>", so a card whose question changes (a fresh
// renewal link after a failed attempt, BRO-3712) is announced again too. A
// bare "ID" entry (stored before the hash) counts as told and is upgraded to
// the current question without an email.
function decisionHash(d) {
  return crypto.createHash('sha256').update(String(d.question || d.title || '')).digest('hex').slice(0, 12);
}

function planNotification(decisions, notifiedIds, { maxListed = MAX_LISTED } = {}) {
  const told = new Map();
  for (const entry of Array.isArray(notifiedIds) ? notifiedIds : []) {
    const at = String(entry).lastIndexOf('@');
    if (at > 0) told.set(String(entry).slice(0, at), String(entry).slice(at + 1));
    else told.set(String(entry), null);
  }
  const isFresh = (d) => !told.has(d.identifier)
    || (told.get(d.identifier) !== null && told.get(d.identifier) !== decisionHash(d));
  const fresh = decisions.filter(isFresh);
  const listed = fresh.slice(0, maxListed);
  const listedIds = new Set(listed.map((d) => d.identifier));
  const nextNotified = [];
  for (const d of decisions) {
    if (listedIds.has(d.identifier) || told.get(d.identifier) === null) {
      nextNotified.push(`${d.identifier}@${decisionHash(d)}`);
    } else if (told.has(d.identifier)) {
      nextNotified.push(`${d.identifier}@${told.get(d.identifier)}`);
    }
  }
  return { fresh, listed, more: fresh.length - listed.length, nextNotified: [...new Set(nextNotified)].sort(), totalOpen: decisions.length };
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
    for (const a of d.priorAnswers || []) lines.push(`  You answered something like this on ${a.date || 'an earlier date'} (${a.identifier}): ${a.text}`);
    if (d.url) lines.push(`  ${d.url}`);
  }
  if (plan.more > 0) lines.push('', `+${plan.more} more. They will be in the next email.`);
  const others = plan.totalOpen - n;
  if (others > 0) lines.push('', `${others} older ${plural(others, 'decision is', 'decisions are')} still waiting too.`);
  lines.push('', 'To answer, open the card to read the options, then tell Claude in any chat the card name and the option you picked.');
  return { title, description: lines.join('\n') };
}

/**
 * BRO-3444: the morning digest's "Needs your decision" section from the same
 * findOwnerDecisions() list the decision email uses, so the digest and the
 * email agree on what a decision is. Cards carrying the awaiting-owner label
 * are left out: the digest already lists them in its "Waiting on your
 * approval" section, and counting them twice would inflate "N decisions for
 * you". Same {generatedAt, bannerText, items, moreCount} shape as every other
 * digest section. Returns null when there is nothing to show.
 */
function questionLink(question) {
  const m = /https?:\/\/[^\s)>\]]+/.exec(String(question || ''));
  return m ? m[0].replace(/[.,;:!?]+$/, '') : null;
}

function buildDecisionsSection(issues, { max = 8, now = new Date() } = {}) {
  const labelled = new Set((issues || [])
    .filter((i) => i && labelNames(i).includes(AWAITING_OWNER_LABEL))
    .map((i) => i.identifier));
  const decisions = findOwnerDecisions(issues).filter((d) => d.question && !labelled.has(d.identifier));
  if (!decisions.length) return null;
  const shown = decisions.slice(0, max);
  return {
    generatedAt: now.toISOString(),
    bannerText: `${decisions.length} card${decisions.length === 1 ? '' : 's'} waiting on your decision`,
    // A question that carries its own link (signed renewal links: "Tap
    // https://... and press Allow") links to THAT, not the card: the digest
    // wraps the whole title in one anchor, so an inner URL is not tappable.
    items: shown.map((d) => ({ title: d.question, detail: `${d.identifier}: ${d.title}`, url: questionLink(d.question) || d.url })),
    moreCount: decisions.length - shown.length,
    // Every decision card's url, shown or not, so other sections (In Review)
    // can drop the same card instead of counting it twice.
    cardUrls: decisions.map((d) => d.url).filter(Boolean),
  };
}

module.exports = {
  MAX_LISTED,
  buildDecisionsSection,
  collapseSelfLinks,
  extractDecisionQuestion,
  findOwnerDecisions,
  planNotification,
  formatEmail,
};
