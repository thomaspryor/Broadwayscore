/**
 * Owner-decision links (BRO-6147): one email per decision, tap-to-answer.
 *
 * Shared by src/app/api/owner-decision/route.ts (the confirm page) and by
 * scripts/send-owner-decision-emails.js (mints the links, sweeps owner
 * replies). It lives in src/lib because Next bundles the route and cannot
 * require files under scripts/ (same split as linear-dispatch-issue.js);
 * scripts/lib/owner-decision-notify.js re-uses the parsing from here.
 *
 * Security model:
 *  - A link carries a SHORT signed token {i: card, h: question hash, e: expiry}.
 *    The question and options are read from the live card on every GET/POST,
 *    so a stale or edited question can never be answered by an old link.
 *  - HMAC-SHA256 over `owner-decision:v1:<payload>` (domain separated so a
 *    token minted for another route never verifies here), strict 64-hex
 *    signature, timingSafeEqual.
 *  - The answer lives only in a Linear COMMENT, quoted and with every
 *    structural marker neutralised. The card description only ever gets a
 *    fixed "ANSWERED" line, so a forwarded link cannot inject VERIFY /
 *    PR-EVIDENCE / DECISION NEEDED lines into the card.
 *  - Idempotency: the answer comment carries "Decision ref ODA<hmac>"; the
 *    ref is an HMAC of card+hash, so nobody can forge one by pasting a hash.
 *    Linear escapes markdown in stored bodies, so every marker test unescapes.
 */
'use strict';

const crypto = require('crypto');

const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ANSWER_CHARS = 2000;
const MAX_QUESTION_CHARS = 220; // same cap as the notifier's MAX_QUESTION_CHARS
const DOMAIN = 'owner-decision:v1:';
const AWAITING_OWNER_LABEL = 'awaiting-owner';
const ID_RE = /^[A-Z]{2,6}-\d{1,7}$/;

// ── question extraction (moved from scripts/lib/owner-decision-notify.js) ──
const MARKER_RE = /^\s*(?:#{1,6}\s+|[-*>]\s+|\d+[.)]\s+)?\**DECISION NEEDED\**(?:\s*\([^)]*\))?\s*:\s*\**\s*(\S.*)$/i;

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

// Linear stores a bare URL as [url](<url>); collapsed back so the length cap
// never clips a link and the hash reads the same before and after the rewrite.
function collapseSelfLinks(text) {
  return String(text || '').replace(/\[([^\]\s]{1,2048})\]\(<?(?:mailto:)?\1>?\)/g, '$1');
}

function capQuestion(q) {
  return q.length > MAX_QUESTION_CHARS ? `${q.slice(0, MAX_QUESTION_CHARS - 1)}…` : q;
}

// Every "DECISION NEEDED: <q>" line outside code, as {line, question}.
function markerLines(description) {
  const out = [];
  for (const line of stripCode(description)) {
    const m = MARKER_RE.exec(line);
    if (!m) continue;
    const question = capQuestion(collapseSelfLinks(m[1]).replace(/\*+$/, '').trim());
    if (question) out.push({ line, question });
  }
  return out;
}

function questionHash(question) {
  return crypto.createHash('sha256').update(String(question || '')).digest('hex').slice(0, 12);
}

function unescapeMarkdown(s) {
  return String(s || '').replace(/\\([\\`*_{}[\]()#+\-.!<>~|:])/g, '$1');
}

// ── the DECISION NEEDED block (CLAUDE.md template) ─────────────────────────
// Why this is your call: ... / Option A — <name>: <upside> / <downside> /
// My recommendation: <X> because <Y>. / Default: ...
const OPTION_RE = /^\s*(?:[-*>]\s+)?\**Option\s+([A-E])\**\s*(?:[—–:-]+)\s*(.+)$/i;
const LABEL_RES = {
  why: /^\s*(?:[-*>]\s+)?\**Why this is your call\**\s*:\s*\**\s*(.+)$/i,
  recommendation: /^\s*(?:[-*>]\s+)?\**My recommendation\**\s*:\s*\**\s*(.+)$/i,
  defaultText: /^\s*(?:[-*>]\s+)?\**Default\**\s*:\s*\**\s*(.+)$/i,
};

function plain(s) {
  return collapseSelfLinks(unescapeMarkdown(s)).replace(/\*\*/g, '').replace(/\s*—\s*/g, ', ').replace(/\s+/g, ' ').trim();
}

function splitUpDown(rest) {
  const m = /^(.*?):\s+(.*)$/.exec(rest);
  const name = m ? m[1] : rest;
  const body = m ? m[2] : '';
  const parts = body.split(/\s+\/\s+/);
  return { name: plain(name), upside: plain(parts[0] || ''), downside: plain(parts.slice(1).join(' / ')) };
}

/** Parse the plain-English parts of a decision card. Never throws. */
function parseDecisionBlock(description) {
  const out = { why: null, options: [], recommendation: null, defaultText: null };
  const seen = new Set();
  for (const line of stripCode(description)) {
    const opt = OPTION_RE.exec(line);
    if (opt) {
      const key = opt[1].toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        const { name, upside, downside } = splitUpDown(opt[2]);
        if (name) out.options.push({ key, label: `Option ${key.toUpperCase()}`, name: name.slice(0, 120), upside: upside.slice(0, 240), downside: downside.slice(0, 240) });
      }
      continue;
    }
    for (const [field, re] of Object.entries(LABEL_RES)) {
      const m = re.exec(line);
      if (m && !out[field]) out[field] = plain(m[1]).slice(0, 400);
    }
  }
  return out;
}

// Options a card offers. Cards without parseable options get the generic pair.
function answerChoices(description) {
  const { options } = parseDecisionBlock(description);
  if (options.length >= 2) return options.map((o) => ({ key: o.key, label: `${o.label}: ${o.name}`, short: o.label }));
  return [
    { key: 'approve', label: 'Approved', short: 'Approve' },
    { key: 'reject', label: 'Rejected', short: 'Reject' },
  ];
}

// ── tokens ──────────────────────────────────────────────────────────────────
function mac(secret, s) {
  return crypto.createHmac('sha256', secret).update(DOMAIN + s).digest('hex');
}

function signToken({ id, hash, secret, now = Date.now(), ttlMs = TOKEN_TTL_MS }) {
  if (!secret) throw new Error('owner-decision: signing secret missing');
  if (!ID_RE.test(String(id))) throw new Error('owner-decision: bad card id');
  const encoded = Buffer.from(JSON.stringify({ i: id, h: hash, e: Math.floor((now + ttlMs) / 1000) })).toString('base64url');
  return `${encoded}.${mac(secret, encoded)}`;
}

function verifyToken(token, secret, now = Date.now()) {
  if (!secret) return { ok: false, reason: 'config' };
  const s = String(token || '');
  if (s.length > 400) return { ok: false, reason: 'malformed' };
  const dot = s.lastIndexOf('.');
  if (dot < 1) return { ok: false, reason: 'malformed' };
  const encoded = s.slice(0, dot);
  const sig = s.slice(dot + 1);
  // Exactly 64 lowercase hex: Buffer.from(_, 'hex') truncates at the first
  // non-hex char, so "<validsig>JUNK" would otherwise decode to a valid one.
  if (!/^[0-9a-f]{64}$/.test(sig) || !/^[A-Za-z0-9_-]+$/.test(encoded)) return { ok: false, reason: 'malformed' };
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(mac(secret, encoded), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature' };
  let p;
  try { p = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (!p || !ID_RE.test(String(p.i)) || !/^[0-9a-f]{12}$/.test(String(p.h)) || !Number.isInteger(p.e)) return { ok: false, reason: 'malformed' };
  if (now > p.e * 1000) return { ok: false, reason: 'expired', id: p.i };
  return { ok: true, id: p.i, hash: p.h, expires: p.e };
}

// Unforgeable per-decision reference written into comments.
function decisionRef(secret, id, hash) {
  return crypto.createHmac('sha256', secret).update(`${DOMAIN}ref:${id}:${hash}`).digest('hex').slice(0, 16);
}
const answerMarker = (ref) => `Decision ref ODA${ref}`;
const emailMarker = (ref) => `Decision email ref ODE${ref}`;
function bodyHasMarker(body, marker) { return unescapeMarkdown(body).includes(marker); }

// ── the answer comment ─────────────────────────────────────────────────────
// Free text is owner input but the link is bearer-authority, so treat it as
// untrusted: cap, drop control chars, break every marker the board reads,
// defuse @mentions, and quote it so no line starts a heading or marker.
const NEUTRALISE = [
  [/DECISION\s+NEEDED/gi, 'decision-needed'],
  [/PR-EVIDENCE/gi, 'pr-evidence'],
  [/RECHECK-AFTER/gi, 'recheck-after'],
  [/\bVERIFY\s*:/gi, 'verify -'],
  [/Acceptance criteria/gi, 'acceptance-criteria'],
  [/Decision (?:email )?ref\s*OD[AE]/gi, 'decision-ref'],
  [/\bOD[AE][0-9a-f]{8,}/gi, 'ref'],
  [/@/g, '(at)'],
];

const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]', 'g');

function sanitizeAnswer(text) {
  let t = String(text == null ? '' : text).replace(CONTROL_CHARS_RE, '');
  t = t.replace(/\r\n?/g, '\n').trim().slice(0, MAX_ANSWER_CHARS);
  for (const [re, to] of NEUTRALISE) t = t.replace(re, to);
  return t;
}

function buildAnswerComment({ choiceLabel, text, ref, now = new Date(), via = 'the email link' }) {
  const day = now.toISOString().slice(0, 10);
  const lines = [`**Owner decision** (answered by the owner through ${via}, ${day} UTC)`, '', `Chose: ${sanitizeAnswer(choiceLabel).replace(/\n/g, ' ')}`];
  const body = sanitizeAnswer(text);
  if (body) lines.push('', ...body.split('\n').map((l) => `> ${l}`));
  lines.push('', answerMarker(ref));
  return lines.join('\n');
}

// Display form of an earlier answer comment (idempotent replay).
function summarizeAnswerComment(body) {
  return unescapeMarkdown(body).split('\n')
    .filter((l) => !/Decision ref ODA/.test(l) && !/^\*\*Owner decision\*\*/.test(l))
    .join('\n').replace(/^\s*Chose:\s*/m, '').trim().slice(0, MAX_ANSWER_CHARS + 200);
}

// An owner reply typed straight into the card: only a comment that STARTS with
// "ANSWER:" counts. Every Claude session comments under the owner's Linear
// identity, so author cannot tell them apart; sessions restating a decision
// use the template words below, which disqualify a comment.
const TEMPLATE_WORDS_RE = /DECISION NEEDED|Option [A-E]\s*[—–:-]|My recommendation|Why this is your call|Decision (?:email )?ref/i;
function parseOwnerReply(body) {
  const clean = unescapeMarkdown(body).trim();
  const m = /^\**ANSWER\**\s*:\s*\**\s*([\s\S]+)$/i.exec(clean);
  if (!m) return null;
  if (TEMPLATE_WORDS_RE.test(clean)) return null;
  const text = m[1].trim();
  return text.length >= 1 && text.length <= MAX_ANSWER_CHARS ? text : null;
}

// ── the Linear write ─────────────────────────────────────────────────────────
const ISSUE_QUERY = `query($id: String!) { issue(id: $id) {
  id identifier title description url
  state { id name type }
  labels { nodes { id name } }
  team { states { nodes { id name type } } }
  comments(first: 250) { nodes { id body createdAt } }
} }`;
const COMMENTS_QUERY = `query($id: String!) { issue(id: $id) { comments(first: 250) { nodes { id body createdAt } } } }`;
const COMMENT_CREATE = `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id createdAt } } }`;
const COMMENT_DELETE = `mutation($id: String!) { commentDelete(id: $id) { success } }`;
const ISSUE_UPDATE = `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;

function commentNodes(c) { return (c && c.nodes) || []; }
function markerComments(comments, marker) {
  return commentNodes(comments)
    .filter((c) => bodyHasMarker(c.body, marker))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
}

/** Read a card and say whether this decision is open, answered, or stale. */
async function loadDecision({ graphql, id, hash, secret }) {
  const data = await graphql(ISSUE_QUERY, { id });
  const issue = data && data.issue;
  if (!issue) return { status: 'missing' };
  const ref = decisionRef(secret, id, hash);
  const answered = markerComments(issue.comments, answerMarker(ref))[0] || null;
  const labels = ((issue.labels && issue.labels.nodes) || []).map((l) => l.name);
  const live = markerLines(issue.description).some((m) => questionHash(m.question) === hash)
    || (labels.includes(AWAITING_OWNER_LABEL) && questionHash(issue.title) === hash);
  const base = { issue, ref, choices: answerChoices(issue.description), block: parseDecisionBlock(issue.description) };
  if (answered) return { ...base, status: 'answered', recorded: summarizeAnswerComment(answered.body) };
  if (!live) return { ...base, status: 'stale' };
  const q = markerLines(issue.description).find((m) => questionHash(m.question) === hash);
  return { ...base, status: 'open', question: q ? q.question : issue.title };
}

/**
 * Record the owner's answer: comment first (the durable record), then the
 * fixed ANSWERED line, label, and state. Idempotent per decision ref.
 */
async function recordAnswer({ graphql, id, hash, secret, choiceKey, text, via, now = new Date() }) {
  const loaded = await loadDecision({ graphql, id, hash, secret });
  if (loaded.status !== 'open') return loaded;
  const choice = loaded.choices.find((c) => c.key === choiceKey) || (choiceKey === 'own' ? { key: 'own', label: 'Own words' } : null);
  if (!choice) return { ...loaded, status: 'bad-choice' };
  const cleanText = sanitizeAnswer(text);
  if (choice.key === 'own' && !cleanText) return { ...loaded, status: 'empty' };

  const { issue, ref } = loaded;
  const body = buildAnswerComment({ choiceLabel: choice.label, text: cleanText, ref, now, via });
  const created = await graphql(COMMENT_CREATE, { input: { issueId: issue.id, body } });
  if (!created || !created.commentCreate || !created.commentCreate.success) throw new Error('comment was not created');
  const ourId = created.commentCreate.comment.id;

  // Race: two taps can both pass the check above. The earliest marker comment
  // wins; a later one deletes itself and reports the winner.
  const after = await graphql(COMMENTS_QUERY, { id });
  const winner = markerComments(after.issue.comments, answerMarker(ref))[0];
  if (winner && winner.id !== ourId) {
    await graphql(COMMENT_DELETE, { id: ourId });
    return { ...loaded, status: 'answered', recorded: summarizeAnswerComment(winner.body) };
  }

  const input = {};
  const answeredLine = 'ANSWERED by the owner (see the "Owner decision" comment on this card).';
  const lines = String(issue.description || '').split('\n');
  const fixed = lines.map((l) => {
    const m = MARKER_RE.exec(l.replace(/`[^`]*`/g, ''));
    return m && questionHash(capQuestion(collapseSelfLinks(m[1]).replace(/\*+$/, '').trim())) === hash ? answeredLine : l;
  });
  if (fixed.join('\n') !== lines.join('\n')) input.description = fixed.join('\n');
  const labels = (issue.labels && issue.labels.nodes) || [];
  if (labels.some((l) => l.name === AWAITING_OWNER_LABEL)) input.labelIds = labels.filter((l) => l.name !== AWAITING_OWNER_LABEL).map((l) => l.id);
  const stateName = String((issue.state && issue.state.name) || '');
  if (/^(backlog|triage)$/i.test(stateName)) {
    const todo = commentNodes({ nodes: issue.team && issue.team.states && issue.team.states.nodes }).find((s) => /^todo$/i.test(s.name));
    if (todo) input.stateId = todo.id;
  }
  if (Object.keys(input).length) await graphql(ISSUE_UPDATE, { id: issue.id, input });
  return { ...loaded, status: 'recorded', answer: { label: choice.label, text: cleanText }, moved: Boolean(input.stateId) };
}

module.exports = {
  TOKEN_TTL_MS, MAX_ANSWER_CHARS, MARKER_RE, ID_RE, AWAITING_OWNER_LABEL,
  stripCode, collapseSelfLinks, capQuestion, markerLines, questionHash, unescapeMarkdown,
  parseDecisionBlock, answerChoices,
  signToken, verifyToken, decisionRef, answerMarker, emailMarker, bodyHasMarker,
  sanitizeAnswer, buildAnswerComment, summarizeAnswerComment, parseOwnerReply,
  loadDecision, recordAnswer, markerComments,
};
