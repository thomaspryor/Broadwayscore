'use strict';
/**
 * linear-webhook.js (BRO-6715): pure helpers for src/app/api/linear-webhook/route.ts.
 * Linear posts every comment on the board to the route; only a plausible owner reply on a card that
 * is waiting on the owner starts linear-decision-reply-drain.yml for that one card. Before this the
 * reply sat until the drain's twice-daily schedule.
 */
const crypto = require('crypto');
const link = require('./owner-decision-link.js');

const MAX_SKEW_MS = 60 * 1000;
const MAX_BODY_CHARS = 1500;
// Comments the automation writes itself. None of these is an answer, and several land on decision cards.
const MACHINE_BODY_RE = /^\s*(?:\*\*Session report|\*\*Owner decision\*\*|Claimed by |Dispatched |Emailed the owner|Owner answered:|ANSWERED|Asked the owner|Waiting on your approval|Visual change approved by the owner|Auto-|RECLAIMED|<!-- |## Codex runner|\[[a-z][a-z0-9 ]*-[a-z0-9 -]*(?::[a-z0-9-]+)?\](?!\())/i;

/** Linear-Signature is the hex HMAC-SHA256 of the raw body, keyed with the webhook's signing secret. */
function verifySignature(rawBody, header, secret) {
  if (!secret || !header || !/^[0-9a-f]{64}$/i.test(String(header))) return false;
  const want = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const got = Buffer.from(String(header), 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function fresh(payload, now = Date.now()) {
  const ts = Number(payload && payload.webhookTimestamp);
  return Number.isFinite(ts) && Math.abs(now - ts) <= MAX_SKEW_MS;
}

/** The card id (UUID) of a newly created comment worth a look, or null. */
function replyCandidate(payload) {
  if (!payload || payload.type !== 'Comment' || payload.action !== 'create') return null;
  const d = payload.data || {};
  const body = String(d.body || '');
  if (!body.trim() || body.length > MAX_BODY_CHARS || MACHINE_BODY_RE.test(body)) return null;
  const id = d.issueId || (d.issue && d.issue.id);
  return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/** True when the card still waits on the owner: a live DECISION NEEDED line or the awaiting-owner label. */
function waitsOnOwner(issue) {
  if (!issue) return false;
  const labelled = ((issue.labels && issue.labels.nodes) || []).some((l) => l && l.name === 'awaiting-owner');
  const done = issue.state && ['completed', 'canceled'].includes(issue.state.type);
  const desc = String(issue.description || '');
  // A live one-line marker (an ANSWERED line elsewhere does not hide a second open question), or the heading form the drain also reads.
  const live = link.markerLines(desc).some((m) => !link.isPlaceholderQuestion(m.question)) || /^\s*#{1,6}\s+\**DECISION NEEDED/im.test(link.stripCode(desc).join('\n'));
  return !done && (labelled || live);
}

module.exports = { verifySignature, fresh, replyCandidate, waitsOnOwner, MAX_SKEW_MS, MAX_BODY_CHARS };
