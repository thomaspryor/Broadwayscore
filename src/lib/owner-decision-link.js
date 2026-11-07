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

// "Evidence: <label> | <https://raw.githubusercontent.com/thomaspryor/Broadwayscore/...png>"
// (BRO-6241). Only that host and repo can be shown as an image on the owner pages.
const EVIDENCE_RE = /^\s*(?:[-*>]\s+)?\**Evidence\**\s*:\s*\**\s*(?:([^|]{1,120})\|\s*)?(\S+)\s*$/i;
const MAX_EVIDENCE = 8;
// BRO-6654: "Owner step 1: ..." lines make the card an owner TASK (a Mac-only
// step a cloud session cannot do): the email lists the steps and offers Done
// instead of a choice. "Owner step", not "Step", so a plan written as "Step 1:"
// on an ordinary decision card stays a decision. Steps keep the order written.
const STEP_RE = /^\s*(?:[-*>]\s+)?\**Owner step\s+(\d{1,2})\**\s*[:.)]\s*\**\s*(\S.*)$/i;
const MAX_STEPS = 12;
const TASK_CHOICES = [
  { key: 'done', label: 'Done, I did it', short: 'Done' },
  { key: 'blocked', label: 'I could not do it', short: 'Could not do it' },
];
const EVIDENCE_URL_RE = /^https:\/\/raw\.githubusercontent\.com\/thomaspryor\/Broadwayscore\/[A-Za-z0-9._\/-]{1,200}\.(?:png|jpe?g)$/;
function safeEvidenceUrl(raw) {
  const u = collapseSelfLinks(unescapeMarkdown(raw)).replace(/^<|>$/g, '');
  return EVIDENCE_URL_RE.test(u) && !u.includes('..') ? u : null;
}

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
  const out = { why: null, options: [], recommendation: null, defaultText: null, evidence: [], steps: [] };
  const seen = new Set();
  // Screenshots are only for visual approvals (BRO-6244): any other card with an Evidence line must not put images on the owner pages.
  const visual = parseVisualApproval(description);
  for (const line of stripCode(description)) {
    const ev = EVIDENCE_RE.exec(line);
    if (ev) {
      if (!visual) continue;
      const url = safeEvidenceUrl(ev[2]);
      if (url && out.evidence.length < MAX_EVIDENCE) out.evidence.push({ label: plain(ev[1]).slice(0, 80) || 'Screenshot', url });
      continue;
    }
    const step = STEP_RE.exec(line);
    if (step) {
      if (out.steps.length < MAX_STEPS) out.steps.push(plain(step[2]).slice(0, 400));
      continue;
    }
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
  // A task only when nothing else claims the card: real A/B options or a visual approval win.
  out.task = out.steps.length > 0 && out.options.length < 2 && !visual;
  return out;
}

// Options a card offers. Cards without parseable options get the generic pair,
// or Done / could-not-do-it when the card is a task (has Owner step lines).
function answerChoices(description) {
  const { options, task } = parseDecisionBlock(description);
  if (options.length >= 2) return options.map((o) => ({ key: o.key, label: `${o.label}: ${o.name}`, short: o.label }));
  if (task) return TASK_CHOICES.map((c) => ({ ...c }));
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
// Any answer ref line, for readers without the signing secret (cloud-worker-pick).
const ANSWER_REF_RE = /^Decision ref ODA[0-9a-f]{16,}\s*$/m;
const emailMarker = (ref) => `Decision email ref ODE${ref}`;
function bodyHasMarker(body, marker) { return unescapeMarkdown(body).includes(marker); }


// ── visual approvals (BRO-6241) ──────────────────────────────────────────────
// A worker that changed the website asks the owner "does this look right?" as
// an ordinary decision card. The card carries a machine line
//   VISUAL-APPROVAL: patch=<git patch-id> verdict=<hex> hold=<branch>
// and its question ends with "(ref <12 hex>)" = binding(patch, verdict), so the
// owner's tap covers exactly that diff and check (the question hash is what the
// link signs). Approve additionally writes "Visual approval ref VQA<mac>"; the
// MAC has its own domain because the ODA/ODE refs are readable by any worker.
// Only the CI lander (which holds the secret) acts on it.
const VISUAL_DOMAIN = 'owner-visual-approval:v1:';
const VISUAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const VISUAL_LINE_RE = /^\s*(?:[-*>]\s+)?\**VISUAL-APPROVAL\**\s*:\s*(.+)$/i;
const HEX_RE = /^[0-9a-f]{40,64}$/;
const HOLD_RE = /^visual-hold\/[a-z0-9][a-z0-9-]{0,60}$/;

function visualBinding(patch, verdict) {
  return crypto.createHash('sha256').update(`${patch}:${verdict}`).digest('hex').slice(0, 32);
}

/** {patch, verdict, hold} from the card's machine line, or null when absent or malformed. */
function parseVisualApproval(description) {
  for (const line of stripCode(description)) {
    const m = VISUAL_LINE_RE.exec(line);
    if (!m) continue;
    const kv = {};
    for (const part of m[1].trim().split(/\s+/)) {
      const i = part.indexOf('=');
      if (i > 0) kv[part.slice(0, i).toLowerCase()] = part.slice(i + 1);
    }
    if (HEX_RE.test(kv.patch || '') && /^[0-9a-f]{12,64}$/.test(kv.verdict || '') && HOLD_RE.test(kv.hold || '')) {
      return { patch: kv.patch, verdict: kv.verdict, hold: kv.hold };
    }
  }
  return null;
}

/** The visual binding for a decision, only when the question's own "(ref ...)" tag matches the machine line. */
function visualBindingFor(description, question) {
  const v = parseVisualApproval(description);
  if (!v) return null;
  const tag = /\(ref ([0-9a-f]{32})\)\s*$/.exec(String(question || ''));
  return tag && tag[1] === visualBinding(v.patch, v.verdict) ? v : null;
}

function visualMac(secret, id, patch, verdict) {
  return crypto.createHmac('sha256', secret).update(`${VISUAL_DOMAIN}${id}:${patch}:${verdict}`).digest('hex').slice(0, 32);
}
const visualMarker = (mac) => `Visual approval ref VQA${mac}`;

/** True when a comment on the card carries the valid, unexpired approval for exactly this diff and check. */
function hasVisualApproval({ comments, secret, id, patch, verdict, now = Date.now() }) {
  const marker = visualMarker(visualMac(secret, id, patch, verdict));
  return commentNodes(comments).some((c) => bodyHasMarker(c.body, marker) && now - new Date(c.createdAt).getTime() <= VISUAL_TTL_MS);
}

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
  [/Visual approval (?:ref|landed)\s*VQ[AL]/gi, 'visual-ref'],
  [/VISUAL-APPROVAL/gi, 'visual-approval'],
  [/\bOD[AE][0-9a-f]{8,}/gi, 'ref'],
  [/\bVQ[AL][0-9a-f]{8,}/gi, 'ref'],
  [/@/g, '(at)'],
];

const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]', 'g');

function sanitizeAnswer(text) {
  let t = String(text == null ? '' : text).replace(CONTROL_CHARS_RE, '');
  t = t.replace(/\r\n?/g, '\n').trim().slice(0, MAX_ANSWER_CHARS);
  for (const [re, to] of NEUTRALISE) t = t.replace(re, to);
  return t;
}

function buildAnswerComment({ choiceLabel, text, ref, now = new Date(), via = 'the email link', voided = false }) {
  const day = now.toISOString().slice(0, 10);
  const how = voided ? `closed without an owner tap through ${via}` : `answered by the owner through ${via}`;
  const lines = [`**Owner decision** (${how}, ${day} UTC)`, '', `Chose: ${sanitizeAnswer(choiceLabel).replace(/\n/g, ' ')}`];
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
  if (answered) return { ...base, status: 'answered', recorded: summarizeAnswerComment(answered.body), answeredBody: answered.body };
  if (!live) return { ...base, status: 'stale' };
  const q = markerLines(issue.description).find((m) => questionHash(m.question) === hash);
  return { ...base, status: 'open', question: q ? q.question : issue.title };
}

/**
 * Record the owner's answer: comment first (the durable record), then the
 * fixed ANSWERED line, label, and state. Idempotent per decision ref.
 */
async function recordAnswer({ graphql, id, hash, secret, choiceKey, text, via, allowVoid = false, now = new Date(), sleep = defaultSleep }) {
  const loaded = await loadDecision({ graphql, id, hash, secret });
  // BRO-6401: the comment is the durable record but the card write can fail after it
  // (BRO-5977: answered 15:59Z, DECISION NEEDED line never rewritten). A replay finishes it.
  if (loaded.status === 'answered') return repairAnswered({ graphql, loaded, hash, secret, id, sleep });
  if (loaded.status !== 'open') return loaded;
  // BRO-6411: 'void' closes a visual ask whose change shipped another way (VISUAL-OK commit); never an approval, and only for trusted callers (allowVoid: the CLI run and the lander, never the web link).
  const voidable = choiceKey === 'void' && allowVoid && Boolean(visualBindingFor(loaded.issue.description, loaded.question));
  const choice = loaded.choices.find((c) => c.key === choiceKey) || (choiceKey === 'own' ? { key: 'own', label: 'Own words' } : null)
    || (voidable ? { key: 'void', label: VOID_LABEL } : null);
  if (!choice) return { ...loaded, status: 'bad-choice' };
  const cleanText = sanitizeAnswer(text);
  if (choice.key === 'own' && !cleanText) return { ...loaded, status: 'empty' };

  const { issue, ref } = loaded;
  const body = buildAnswerComment({ choiceLabel: choice.label, text: cleanText, ref, now, via, voided: choice.key === 'void' });
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

  // Visual approval (BRO-6241): Approve writes the signed approval the CI lander acts on.
  const visual = visualBindingFor(issue.description, loaded.question);
  const approved = Boolean(visual) && choice.key === 'a' && /^Option A: approve\b/i.test(String(choice.label || ''))
    && /^Does the change to .+ look right\? \(ref [0-9a-f]{32}\)$/.test(String(loaded.question || ''));
  if (approved) {
    const vbody = `Visual change approved by the owner. The lander will ship the held change (${visual.hold}).\n\n${visualMarker(visualMac(secret, id, visual.patch, visual.verdict))}`;
    const vc = await graphql(COMMENT_CREATE, { input: { issueId: issue.id, body: vbody } });
    if (!vc || !vc.commentCreate || !vc.commentCreate.success) throw new Error('visual approval comment was not created');
  }

  const input = settlePatch({ issue, hash, approved, visual, replay: false });
  const todoId = choice.key === 'void' ? null : todoStateId(issue, approved, visual);
  if (todoId) input.stateId = todoId;
  if (Object.keys(input).length) await updateIssue(graphql, issue.id, input, sleep);
  return { ...loaded, status: 'recorded', answer: { label: choice.label, text: cleanText }, moved: Boolean(input.stateId) };
}

// A rejected visual change goes back to the queue from any state (the worker reads the note).
// An approved change stays where it is: the lander ships it, so no worker should pick the card up.
function todoStateId(issue, approved, visual) {
  const stateName = String((issue.state && issue.state.name) || '');
  if (approved || !(/^(backlog|triage)$/i.test(stateName) || (visual && !/^(todo|done|canceled|cancelled)$/i.test(stateName)))) return null;
  const todo = commentNodes({ nodes: issue.team && issue.team.states && issue.team.states.nodes }).find((s) => /^todo$/i.test(s.name));
  return todo ? todo.id : null;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRateLimited = (e) => Boolean(e) && (e.status === 429 || e.rateLimited === true || /\b429\b|rate.?limit/i.test(String(e.message || '')));

/** issueUpdate that retries a rate limit and treats success:false as a failure. */
async function updateIssue(graphql, id, input, sleep = defaultSleep, attempts = 4) {
  for (let n = 1; ; n++) {
    try {
      const res = await graphql(ISSUE_UPDATE, { id, input });
      if (res && res.issueUpdate && res.issueUpdate.success === false) throw new Error('issueUpdate was not applied');
      return res;
    } catch (e) {
      if (n >= attempts || !isRateLimited(e)) throw e;
      await sleep(1000 * 2 ** (n - 1));
    }
  }
}

const VOID_LABEL = 'Void: the change shipped another way, nothing to approve';
const ANSWERED_LINE = 'ANSWERED by the owner (see the "Owner decision" comment on this card).';

/**
 * The description / label part of settling an answered decision (the state move stays
 * with the caller). replay=true is the repair path: the label goes only when no
 * decision line is left, since another open question may still be waiting.
 */
function settlePatch({ issue, hash, approved, visual, replay }) {
  const input = {};
  const lines = String(issue.description || '').split('\n');
  const rewritten = lines.map((l) => {
    const m = MARKER_RE.exec(l.replace(/`[^`]*`/g, ''));
    return m && questionHash(capQuestion(collapseSelfLinks(m[1]).replace(/\*+$/, '').trim())) === hash ? ANSWERED_LINE : l;
  });
  const remaining = rewritten.some((l) => MARKER_RE.test(l.replace(/`[^`]*`/g, '')));
  const settled = rewritten.join('\n') !== lines.join('\n') && !remaining;
  const unparked = settled && !approved ? unparkOwnerHolds(rewritten) : rewritten;
  // BRO-6654: an answered task's steps are retired, so a later question on the card is not shown them.
  const fixed = settled ? unparked.map((l) => l.replace(/\bOwner step(\s+\d{1,2})/i, 'Done owner step$1')) : unparked;
  if (fixed.join('\n') !== lines.join('\n')) input.description = fixed.join('\n');
  const labels = (issue.labels && issue.labels.nodes) || [];
  if ((!replay || !remaining) && labels.some((l) => l.name === AWAITING_OWNER_LABEL)) {
    input.labelIds = labels.filter((l) => l.name !== AWAITING_OWNER_LABEL).map((l) => l.id);
  }
  return input;
}

/**
 * Replay of an already-recorded answer: finish whatever the first attempt did not
 * write (ANSWERED line, unpark, label, Backlog to Todo). A card with nothing left
 * to settle is only read, never written.
 */
async function repairAnswered({ graphql, loaded, hash, secret, id, sleep }) {
  const { issue } = loaded;
  const q = markerLines(issue.description).find((m) => questionHash(m.question) === hash);
  const labelled = ((issue.labels && issue.labels.nodes) || []).some((l) => l.name === AWAITING_OWNER_LABEL);
  if (!q && !(labelled && questionHash(issue.title) === hash)) return loaded;
  const choiceLabel = ((/^\s*Chose:\s*(.+)$/m.exec(unescapeMarkdown(loaded.answeredBody || '')) || [])[1] || '').trim();
  const visual = visualBindingFor(issue.description, q ? q.question : '');
  const approved = Boolean(visual) && /^Option A: approve\b/i.test(choiceLabel)
    && /^Does the change to .+ look right\? \(ref [0-9a-f]{32}\)$/.test(q ? q.question : '');
  // The first attempt can fail between the answer comment and the visual approval comment;
  // an approval with no signed comment would leave the held change stuck behind a settled card.
  if (approved && !hasVisualApproval({ comments: issue.comments, secret, id: id || issue.identifier, patch: visual.patch, verdict: visual.verdict })) {
    const vbody = `Visual change approved by the owner. The lander will ship the held change (${visual.hold}).\n\n${visualMarker(visualMac(secret, id || issue.identifier, visual.patch, visual.verdict))}`;
    const vc = await graphql(COMMENT_CREATE, { input: { issueId: issue.id, body: vbody } });
    if (!vc || !vc.commentCreate || !vc.commentCreate.success) throw new Error('visual approval comment was not created');
  }
  const input = settlePatch({ issue, hash, approved, visual, replay: true });
  // Another question still waiting on the owner: the card stays where it is.
  const otherOpen = markerLines(issue.description).some((m) => questionHash(m.question) !== hash && !isPlaceholderQuestion(m.question));
  const voided = /^Void\b/i.test(choiceLabel);
  const todoId = otherOpen || voided ? null : todoStateId(issue, approved, visual);
  if (todoId) input.stateId = todoId;
  if (!Object.keys(input).length) return loaded;
  await updateIssue(graphql, issue.id, input, sleep);
  return { ...loaded, repaired: true, moved: Boolean(input.stateId) };
}

/**
 * Open cards whose decision already has its "Owner decision" comment: finish the
 * card write. `issues` need comments{nodes{id body createdAt}}. dryRun lists only.
 * @returns {Promise<Array<{identifier, hash, status, repaired?, error?}>>}
 */
async function reconcileAnswered({ graphql, issues, secret, dryRun = false, sleep }) {
  const out = [];
  for (const issue of issues || []) {
    if (!issue || !ID_RE.test(String(issue.identifier))) continue;
    const hashes = new Set(markerLines(issue.description).map((m) => questionHash(m.question)));
    if (((issue.labels && issue.labels.nodes) || []).some((l) => l && l.name === AWAITING_OWNER_LABEL)) hashes.add(questionHash(issue.title));
    for (const hash of hashes) {
      if (!markerComments(issue.comments, answerMarker(decisionRef(secret, issue.identifier, hash))).length) continue;
      if (dryRun) { out.push({ identifier: issue.identifier, hash, status: 'would-repair' }); continue; }
      try {
        const r = await recordAnswer({ graphql, id: issue.identifier, hash, secret, choiceKey: 'own', sleep });
        out.push({ identifier: issue.identifier, hash, status: r.status, repaired: Boolean(r.repaired) });
      } catch (e) { out.push({ identifier: issue.identifier, hash, status: 'error', error: e.message }); }
    }
  }
  return out;
}

// BRO-6330: a card parked for the owner's call kept its 'PARKED: needs the
// owner's call' line after the answer, so the picker skipped it forever
// (BRO-5605, BRO-5406). Once the card's last open decision is answered, a park
// line that only waited on that call is marked UNPARKED, reason kept, in the
// same form linear-drain-parked.js unparkDescription writes. Parks naming a
// real block (keys, spend, the Mac, a machine-filed line) stay parked.
const OWNER_CALL_PARK_RE = /^(\s*)PARKED\s*:(.*\b(?:owner'?s? (?:call|decision|approval|answer|go-ahead)|owner decision|product call|for owner approval|needs? (?:the )?owner)\b.*)$/i;
const REAL_BLOCK_IN_PARK_RE = /\b(?:api key|keys?\b|token|credential|secret|password|mac\b|launchd|spend|credits\b|budget|auto-filed|owner-review|not an owner|§18|review gate)/i;
function unparkOwnerHolds(lines) {
  return lines.map((l) => {
    const m = OWNER_CALL_PARK_RE.exec(l);
    return m && !REAL_BLOCK_IN_PARK_RE.test(m[2]) ? `${m[1]}UNPARKED (owner-answered):${m[2]}` : l;
  });
}

// ── the list page (BRO-6235) ────────────────────────────────────────────────
// One private page listing every open decision. Its token is a separate
// signed kind (own HMAC domain, no card id) so it can never verify as a
// per-decision token. The page mints per-decision tokens server-side, capped
// at the list token's own expiry, and answering still goes through the
// existing confirm page and POST.
const LIST_DOMAIN = 'owner-decision-list:v1:';
const LIST_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_LISTED = 60;
const SETTLED_RE = /^\s*(?:answered|resolved|decided|done|closed)\b/i;

function listMac(secret, s) {
  return crypto.createHmac('sha256', secret).update(LIST_DOMAIN + s).digest('hex');
}

function signListToken({ secret, now = Date.now(), ttlMs = LIST_TTL_MS }) {
  if (!secret) throw new Error('owner-decision: signing secret missing');
  const encoded = Buffer.from(JSON.stringify({ k: 'list', e: Math.floor((now + ttlMs) / 1000) })).toString('base64url');
  return `${encoded}.${listMac(secret, encoded)}`;
}

function verifyListToken(token, secret, now = Date.now()) {
  if (!secret) return { ok: false, reason: 'config' };
  const s = String(token || '');
  if (s.length > 200) return { ok: false, reason: 'malformed' };
  const dot = s.lastIndexOf('.');
  if (dot < 1) return { ok: false, reason: 'malformed' };
  const encoded = s.slice(0, dot);
  const sig = s.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(sig) || !/^[A-Za-z0-9_-]+$/.test(encoded)) return { ok: false, reason: 'malformed' };
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(listMac(secret, encoded), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature' };
  let p;
  try { p = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (!p || p.k !== 'list' || !Number.isInteger(p.e)) return { ok: false, reason: 'malformed' };
  if (now > p.e * 1000) return { ok: false, reason: 'expired' };
  return { ok: true, expires: p.e };
}

// A per-decision token valid no longer than the list token that minted it.
function mintDecisionToken({ id, hash, secret, listExpires, now = Date.now(), ttlMs = LIST_TTL_MS }) {
  const cap = Number.isInteger(listExpires) ? listExpires * 1000 - now : ttlMs;
  return signToken({ id, hash, secret, now, ttlMs: Math.max(1000, Math.min(ttlMs, cap)) });
}

// Same stub shapes as scripts/lib/needs-you-snapshot.js isEmptyDecisionContent (the sender's filter);
// src/ cannot require scripts/, and listOpenDecisions tests pin the two together.
const EMPTY_CONTENT_RE = /^\s*(?:none|n\/a|nothing)\s*(?:[.,;:\-—–]|$)|^\s*no\s+(?:pending\s+)?decision(?:\s+(?:needed|pending))?\s*(?:[.,;:\-—–]|$)|^\s*nothing\s+pending\s*(?:[.,;:\-—–]|$)/i;
function isPlaceholderQuestion(q) {
  return EMPTY_CONTENT_RE.test(q) ||  /^</.test(q) || /<(?:what|why|name|upside|downside|x|y)\b/i.test(q) || /^\.{3}$/.test(q) || SETTLED_RE.test(q);
}

// One server-side filtered query, no comments: bounded cost for a public GET.
const LIST_QUERY = `query($teamKey: String!) {
  issues(first: ${MAX_LISTED + 40}, filter: {
    team: { key: { eq: $teamKey } },
    state: { type: { nin: ["completed", "canceled", "duplicate"] } },
    or: [
      { labels: { name: { eq: "${AWAITING_OWNER_LABEL}" } } },
      { description: { containsIgnoreCase: "DECISION NEEDED" } }
    ]
  }) { nodes { identifier title description priority url createdAt labels { nodes { name } } } }
}`;

/**
 * Open issues -> the decisions waiting on the owner, most urgent first.
 * Same hash rules as loadDecision, so a listed decision always opens as 'open'.
 * @returns {Array<{identifier,title,url,question,hash,priority,block,choices}>}
 */
function listOpenDecisions(issues) {
  const out = [];
  for (const issue of issues || []) {
    if (!issue || !ID_RE.test(String(issue.identifier))) continue;
    const real = markerLines(issue.description).find((m) => !isPlaceholderQuestion(m.question));
    const labelled = ((issue.labels && issue.labels.nodes) || []).some((l) => l && l.name === AWAITING_OWNER_LABEL);
    if (!real && !labelled) continue;
    const question = real ? real.question : capQuestion(String(issue.title || issue.identifier));
    // loadDecision hashes the raw title for label-only cards, so the list must too (long titles are capped for display only).
    const hash = real ? questionHash(question) : questionHash(issue.title);
    out.push({
      identifier: issue.identifier,
      title: issue.title || issue.identifier,
      url: typeof issue.url === 'string' && issue.url.startsWith('https://linear.app/') ? issue.url : null,
      question,
      hash,
      priority: Number.isInteger(issue.priority) && issue.priority > 0 ? issue.priority : 5,
      createdAt: String(issue.createdAt || ''),
      block: parseDecisionBlock(issue.description),
      choices: answerChoices(issue.description),
    });
  }
  out.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.identifier.localeCompare(b.identifier));
  const shown = out.slice(0, MAX_LISTED);
  shown.omitted = out.length - shown.length;
  return shown;
}

module.exports = {
  LIST_TTL_MS, LIST_QUERY, MAX_LISTED,
  signListToken, verifyListToken, mintDecisionToken, listOpenDecisions, isPlaceholderQuestion,
  TOKEN_TTL_MS, MAX_ANSWER_CHARS, MARKER_RE, ID_RE, AWAITING_OWNER_LABEL,
  stripCode, collapseSelfLinks, capQuestion, markerLines, questionHash, unescapeMarkdown,
  parseDecisionBlock, answerChoices, STEP_RE, TASK_CHOICES,
  VISUAL_TTL_MS, visualBinding, parseVisualApproval, visualBindingFor, visualMac, visualMarker, hasVisualApproval,
  signToken, verifyToken, decisionRef, answerMarker, ANSWER_REF_RE, emailMarker, bodyHasMarker,
  sanitizeAnswer, buildAnswerComment, summarizeAnswerComment, parseOwnerReply,
  VOID_LABEL, ANSWERED_LINE, loadDecision, recordAnswer, reconcileAnswered, updateIssue, markerComments, unparkOwnerHolds,
};
