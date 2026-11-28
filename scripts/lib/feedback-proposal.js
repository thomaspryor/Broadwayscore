/**
 * feedback-proposal.js: pure pieces of the reader-feedback "proposed fix"
 * email (BRO-7847). The planner (scripts/generate-remediation-plan.js) wires
 * them; tests require() these real functions.
 *
 * The email goes to the OWNER ONLY, with four sections:
 *   1. a fix for the specific issue (Approve button), or "already fixed"
 *   2. a root-cause fix when it differs (its own button)
 *   3. a deterministic scan for similar issues (report-only)
 *   4. a drafted reply the owner sends themselves
 *
 * Nothing here emails a reader. Nothing here lets an LLM claim a scan ran.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { escapeHtml } = require('./email-templates.js');
const { buildReplyText } = require('./feedback-reply-drafts.js');
const { buildDispatchUrl } = require('./dispatch-link.js');
const { detectCombinedRoles } = require('./systematic-fix-detection.js');
const { foldDiacritics } = require('./url-slug');

const BASE_URL = 'https://broadwayscorecard.com';
const LEDGER_PATH = path.join(__dirname, '../../data/audit/feedback-proposals.json');
const DAILY_CAP = 10;
const LIVE_STATUSES = new Set(['open', 'previews']);

// ── kill switch, ledger, cap ────────────────────────────────────────────────

function proposalsDisabled(env = process.env) {
  return String(env.FEEDBACK_PROPOSAL_DISABLED || '').toLowerCase() === 'true';
}

const ledgerPath = () => process.env.FEEDBACK_PROPOSALS_LEDGER || LEDGER_PATH;

function loadLedger(p = ledgerPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (raw && typeof raw.entries === 'object' && raw.entries) return raw;
  } catch { /* missing: start empty */ }
  return { version: 1, entries: {} };
}

function saveLedger(ledger, p = ledgerPath()) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(ledger, null, 2) + '\n');
}

// One email per issue, ever, and at most `cap` per UTC day.
function decideSend(ledger, issueNumber, now = new Date(), cap = DAILY_CAP) {
  const key = String(issueNumber);
  if (ledger.entries[key] && ledger.entries[key].proposalSentAt) return { send: false, reason: 'already-sent' };
  const day = now.toISOString().slice(0, 10);
  const today = Object.values(ledger.entries).filter((e) => e && String(e.proposalSentAt || '').slice(0, 10) === day).length;
  if (today >= cap) return { send: false, reason: `daily-cap-${cap}` };
  return { send: true, reason: 'ok' };
}

// minutes from reader submission to our email; null when either time is unknown.
function minutesBetween(submittedAt, sentAt) {
  const a = Date.parse(submittedAt);
  const b = Date.parse(sentAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round(((b - a) / 60000) * 10) / 10;
}

function recordSent(ledger, issueNumber, { sentAt, submittedAt, kind }) {
  ledger.entries[String(issueNumber)] = {
    proposalSentAt: sentAt,
    submittedAt: submittedAt || null,
    minutes: minutesBetween(submittedAt, sentAt),
    kind,
  };
  return ledger;
}

// ── "already fixed?" (step one of every proposal) ───────────────────────────

const norm = (s) => foldDiacritics(String(s || '')).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

function showUrl(show) {
  return `${BASE_URL}/show/${show.slug || show.id}`;
}

/**
 * Catalog entries whose title appears in the reader's words. This is what
 * catches "add show X" asks where X already exists (#1190, #1124).
 */
function findCatalogMatches(message, shows, limit = 6) {
  const text = ` ${norm(message)} `;
  if (text.trim().length < 4) return [];
  const out = [];
  for (const s of shows || []) {
    const t = norm(s && s.title);
    if (t.length < 4 || !text.includes(` ${t} `)) continue;
    out.push({ id: s.id, title: s.title, status: s.status, market: s.market || null, url: showUrl(s) });
    if (out.length >= limit) break;
  }
  return out;
}

// Auto-close is only safe when the ask clearly names ONE catalog entry and is
// not about reviews, a transfer or a revival of an old title. Anything else
// stays with the planner and the owner. (BRO-7847 review)
function selectAutoCloseMatch(message, submitterShow, shows) {
  const matches = findCatalogMatches(`${message || ''} ${submitterShow || ''}`, shows);
  if (matches.length === 0) return [];
  const showNorm = norm(submitterShow);
  const exact = showNorm ? matches.filter((m) => norm(m.title) === showNorm) : [];
  if (exact.length === 1) return exact[0].status === 'closed' ? [] : exact;
  // Same title in several productions: keep the one whose place word the reader typed.
  const text = ` ${norm(message)} `;
  const placed = matches.filter((m) => {
    const titleTok = new Set(norm(m.title).split(' '));
    return String(m.id).split('-').some((t) => t.length > 3 && !titleTok.has(t) && !/^(regional|broadway|off|west|end|\d+)$/.test(t) && text.includes(` ${t} `));
  });
  if (placed.length === 1 && !/\b(reviews?|transfer|revival|revived)\b/i.test(String(message || ''))) return placed[0].status === 'closed' ? [] : placed;
  if (matches.length === 1 && !/\b(reviews?|west end|london|transfer|revival|revived|national tour|tour)\b/i.test(String(message || ''))) return matches[0].status === 'closed' ? [] : matches;
  return [];
}

/**
 * BRO-7919: catalog matches when the intake router itself already reads this
 * ask as "show is already live, nothing to add" (the same decision that closes
 * the issue at intake), else []. When it does, the router is not the root cause,
 * so the proposal email must not offer a root-cause fix for it.
 */
function routerAlreadyInCatalog(message, submitterShow, shows) {
  // Lazy: the routing module is large and most proposals never reach here.
  const { planContentRequestActions } = require('./content-request-routing.js');
  const { isAlreadyInCatalog } = require('./feedback-issue-body.js');
  let actions;
  try {
    actions = planContentRequestActions({ message: message || '', show: submitterShow || '', shows: shows || [] });
  } catch { return []; }
  if (!isAlreadyInCatalog(actions)) return [];
  const ids = [...new Set(actions.map((a) => a.showId))];
  return ids.map((id) => (shows || []).find((s) => s && s.id === id)).filter(Boolean)
    .map((s) => ({ id: s.id, title: s.title, status: s.status, market: s.market || null, url: showUrl(s) }));
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A plan is already applied when every data-edit it proposes already holds in
 * current data. Returns { fixed, evidence[] }. A plan with no data-edit can
 * never be called fixed here.
 */
function checkPlanAlreadyApplied(plan, shows) {
  const edits = ((plan && plan.actions) || []).filter((a) => a.type === 'data-edit' && a.showId);
  if (edits.length === 0) return { fixed: false, evidence: [] };
  const evidence = [];
  let all = true;
  for (const a of edits) {
    const show = (shows || []).find((s) => s.id === a.showId);
    if (show && 'newValue' in a && same(show[a.field], a.newValue)) evidence.push(`${show.title}: ${a.field} already holds the proposed value`);
    else all = false;
  }
  return { fixed: all, evidence };
}

// ── similar-issue scan (deterministic; the registry IS the claim) ───────────

// field -> function(shows, plan) returning { label, count, shows[] } or null.
const SIMILAR_CHECKS = {
  creativeTeam(shows, plan) {
    const exclude = ((plan.actions || []).find((a) => a.field === 'creativeTeam') || {}).showId;
    const hit = detectCombinedRoles(shows, exclude);
    if (!hit) return { label: 'creative team entries with a combined role like "Director, Scenic Design"', count: 0, sample: [] };
    return {
      label: 'creative team entries with a combined role like "Director, Scenic Design"',
      count: hit.totalMatches,
      sample: hit.sampleEntries.map((e) => e.showTitle),
    };
  },
  cast(shows) {
    const empty = shows.filter((s) => LIVE_STATUSES.has(s.status) && s.market === 'broadway' && (!Array.isArray(s.cast) || s.cast.length === 0));
    return { label: 'Broadway shows that are open or in previews with no cast listed', count: empty.length, sample: empty.slice(0, 5).map((s) => s.title) };
  },
  runtime(shows) {
    const bad = shows.filter((s) => LIVE_STATUSES.has(s.status) && s.market === 'broadway' && (s.runtime == null || s.runtime === ''));
    return { label: 'Broadway shows that are open or in previews with no runtime', count: bad.length, sample: bad.slice(0, 5).map((s) => s.title) };
  },
};

/**
 * Run every registered check that maps to a field the plan edits.
 * ran=false means no check maps, and the email says exactly that.
 */
function scanSimilar(plan, shows) {
  const fields = new Set(((plan && plan.actions) || []).filter((a) => a.type === 'data-edit').map((a) => a.field));
  const findings = [];
  for (const f of fields) {
    if (SIMILAR_CHECKS[f]) findings.push({ field: f, ...SIMILAR_CHECKS[f](shows || [], plan) });
  }
  return { ran: findings.length > 0, findings };
}


// ── needs-review issues carry no DIAGNOSIS_JSON ─────────────────────────────

const SUBMISSION_RE = /\*\*Submission id:\*\*\s*`([^`]+)`/;

function isContentAdditionBody(issueBody) {
  return /^Content-addition request from user feedback/.test(String(issueBody || '').trim());
}

/**
 * New issues use the submission id to look up private reader details. Legacy
 * needs-review issues may instead contain the original message in the body;
 * their submission time is unknown. The id, when present, is a timestamp.
 */
function buildNeedsReviewDiagnosis(issueBody, store) {
  const id = (String(issueBody || '').match(SUBMISSION_RE) || [])[1];
  if (!id && !/^(?:Content-addition request from user feedback|Auto-diagnosis failed for this feedback submission)/.test(String(issueBody || '').trim())) return null;
  const e = (store && store.entries && store.entries[id]) || {};
  const summary = (String(issueBody).match(/\*\*Summary:\*\*\s*(.+)/) || [])[1] || 'Reader report, not yet diagnosed';
  const showLine = (String(issueBody).match(/\*\*Show:\*\*\s*([^|\n]+)/) || [])[1];
  const message = !id && (String(issueBody).match(/\*\*Original message:\*\*\s*([\s\S]*?)(?=\n\s*\n\s*\*\*|$)/) || [])[1];
  return {
    submissionId: id || null,
    submittedAt: id || null,
    summary,
    whatsHappening: summary,
    findings: [],
    proposedFix: 'None yet',
    fixType: 'data',
    confidence: 'low',
    submitterName: e.name || null,
    submitterEmail: e.email || null,
    submitterShow: e.show || (showLine ? showLine.trim() : null),
    originalMessage: e.message || (message && message.trim()) || null,
    needsReview: true,
  };
}

// ── root-cause button (signed dispatch tap, PII-free) ───────────────────────

function buildRootCauseUrl({ issueNumber, rootCause, secret, now = Date.now(), baseUrl = BASE_URL }) {
  if (!rootCause || !rootCause.summary || !secret) return null;
  const exp = Math.floor(now / 1000) + 7 * 86400;
  return buildDispatchUrl({
    conditionKey: `reader-feedback-rootcause-${issueNumber}`,
    title: `Reader report #${issueNumber} root cause: ${rootCause.title || String(rootCause.summary).slice(0, 70)}`,
    description: rootCause.approach || rootCause.summary,
    exp,
    secret,
    baseUrl,
  });
}

// ── reply draft (owner sends it themselves) ─────────────────────────────────

function buildReaderReplyDraft({ reader, show, url }) {
  const r = reader || {};
  // Issue titles look like "Show - note about it"; the reader only needs the show name.
  const showName = String(show || r.show || '').split(/\s+-\s+/)[0].replace(/\s+/g, ' ').trim();
  const reply = buildReplyText('fixed', r.name, showName, { url });
  const to = r.email || '';
  const mailto = to
    ? `mailto:${encodeURIComponent(to).replace(/%40/g, '@')}?subject=${encodeURIComponent(reply.subject)}&body=${encodeURIComponent(reply.text)}`
    : null;
  return { ...reply, to, mailto };
}

// ── the email ───────────────────────────────────────────────────────────────

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function button(href, label, color) {
  return `<table cellpadding="0" cellspacing="0" border="0" style="margin:8px 0;"><tr><td bgcolor="${color}" style="border-radius:6px;"><a href="${escapeHtml(href)}" style="display:block;padding:12px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;font-family:${FONT};">${escapeHtml(label)}</a></td></tr></table>`;
}

function section(n, title, inner) {
  return `<div style="margin:22px 0 0;padding:16px 0 0;border-top:1px solid #e5e5e5;"><p style="margin:0 0 8px;font-weight:700;font-size:15px;">${n}. ${escapeHtml(title)}</p>${inner}</div>`;
}

/**
 * @param {object} o
 * @param {number|string} o.issueNumber
 * @param {{name?:string,email?:string,show?:string,message?:string}} o.reader
 * @param {boolean} o.alreadyFixed
 * @param {string[]} [o.fixedEvidence]   lines proving it is already fixed
 * @param {{summary:string,steps?:string[],riskLevel?:string}} [o.plan]
 * @param {string} [o.approveUrl]
 * @param {string} [o.rejectUrl]
 * @param {{summary:string,approach?:string}|null} [o.rootCause]
 * @param {string|null} [o.rootCauseUrl]
 * @param {{ran:boolean,findings:Array}} o.scan
 * @param {Array} [o.catalogMatches]
 * @param {{subject:string,text:string,to:string,mailto:string|null}} o.reply
 * @returns {{html:string,text:string}}
 */
function buildProposalEmail(o) {
  const r = o.reader || {};
  const who = r.name && r.name !== 'Anonymous' ? r.name : 'A reader';
  const status = o.alreadyFixed ? 'Already fixed' : 'Needs a fix';
  const chipColor = o.alreadyFixed ? '#166534' : '#9a3412';
  const li = (items) => `<ul style="margin:6px 0 0;padding-left:20px;color:#444;">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

  // 1. specific fix
  let s1;
  if (o.alreadyFixed) {
    const ev = (o.fixedEvidence || []).map((e) => escapeHtml(e));
    const cat = (o.catalogMatches || []).map((m) => `<a href="${escapeHtml(m.url)}">${escapeHtml(m.title)}</a> (${escapeHtml(m.status || 'unknown')}${m.market ? `, ${escapeHtml(m.market)}` : ''})`);
    s1 = `<p style="margin:0;">This looks fixed already. Nothing to approve.</p>${ev.length ? li(ev) : ''}${cat.length ? `<p style="margin:8px 0 0;color:#444;">In the catalog now:</p>${li(cat)}` : ''}<p style="margin:8px 0 0;color:#666;">The GitHub issue is closed with a comment.</p>`;
  } else {
    const steps = (o.plan && o.plan.steps) || [];
    s1 = `<p style="margin:0;">${escapeHtml((o.plan && o.plan.summary) || '')}</p>${steps.length ? li(steps.map((x) => escapeHtml(x))) : ''}<p style="margin:8px 0 0;color:#666;">Risk: ${escapeHtml((o.plan && o.plan.riskLevel) || 'Unknown')}.</p>${o.approveUrl ? button(o.approveUrl, 'Approve fix', '#16a34a') : ''}${o.rejectUrl ? `<p style="margin:0;font-size:13px;"><a href="${escapeHtml(o.rejectUrl)}" style="color:#999;">Reject</a></p>` : ''}`;
  }

  // 2. root cause
  let s2;
  if (o.rootCause && o.rootCause.summary) {
    s2 = `<p style="margin:0;">${escapeHtml(o.rootCause.summary)}</p>${o.rootCause.approach ? `<p style="margin:6px 0 0;color:#444;">${escapeHtml(o.rootCause.approach)}</p>` : ''}${o.rootCauseUrl ? button(o.rootCauseUrl, 'Approve root-cause fix', '#2563eb') : ''}`;
  } else {
    s2 = `<p style="margin:0;color:#444;">Same as the fix above. No separate root cause.</p>`;
  }

  // 3. similar-issue scan
  let s3;
  if (!o.scan || !o.scan.ran) {
    s3 = `<p style="margin:0;color:#444;">No automated check covers this kind of issue, so nothing was scanned. Treat it as a one-off until a check exists.</p>`;
  } else {
    s3 = `<p style="margin:0;color:#444;">Scanned the catalog for similar problems:</p>${li(o.scan.findings.map((f) => {
      const sample = f.count > 0 && f.sample && f.sample.length ? ` (for example ${f.sample.map(escapeHtml).join(', ')})` : '';
      return `${f.count} ${escapeHtml(f.label)}${sample}`;
    }))}<p style="margin:8px 0 0;color:#666;">Report only. Approving the fix does not change these.</p>`;
  }

  // 4. reply draft
  const reply = o.reply || {};
  const s4 = `<p style="margin:0 0 6px;color:#666;">${o.alreadyFixed ? 'Ready to send.' : 'Send once the fix is live.'} You send this yourself. We never email the reader.</p><div style="padding:10px 14px;background:#f6f6f6;border-radius:6px;white-space:pre-wrap;font-size:14px;">${escapeHtml(reply.text || '')}</div>${reply.mailto ? button(reply.mailto, 'Open draft to reader', '#444444') : '<p style="margin:6px 0 0;color:#999;">No reader email was given.</p>'}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:24px;font-family:${FONT};font-size:15px;line-height:1.55;color:#222;max-width:640px;">
<p style="margin:0 0 4px;"><span style="display:inline-block;padding:2px 10px;border-radius:12px;background:${chipColor};color:#fff;font-size:12px;font-weight:600;">${status}</span></p>
<p style="margin:8px 0 0;"><strong>${escapeHtml(who)}</strong>${r.email ? ` (${escapeHtml(r.email)})` : ''}${r.show ? ` wrote in about ${escapeHtml(r.show)}` : ' wrote in'}:</p>
<p style="margin:6px 0 0;padding-left:14px;border-left:3px solid #ddd;color:#555;white-space:pre-wrap;">${r.message ? escapeHtml(r.message) : '(no message saved)'}</p>
${section(1, o.alreadyFixed ? 'Fix for this issue (already done)' : 'Fix for this issue', s1)}
${section(2, 'Root-cause fix', s2)}
${section(3, 'Similar issues', s3)}
${section(4, 'Reply to the reader', s4)}
<p style="margin:22px 0 0;font-size:12px;color:#999;">Links expire in 7 days. If you do nothing, nothing changes. Issue <a href="https://github.com/thomaspryor/Broadwayscore/issues/${escapeHtml(String(o.issueNumber))}" style="color:#999;">#${escapeHtml(String(o.issueNumber))}</a>.</p>
</body></html>`;

  const text = [
    `${status}: ${who}${r.show ? ` on ${r.show}` : ''}`,
    r.message ? `They wrote: ${r.message}` : '',
    '',
    `1. ${o.alreadyFixed ? 'Already fixed. ' + (o.fixedEvidence || []).join('; ') : (o.plan && o.plan.summary) || ''}`,
    o.approveUrl ? `Approve: ${o.approveUrl}` : '',
    `2. ${o.rootCause && o.rootCause.summary ? o.rootCause.summary : 'Same as the fix above.'}`,
    o.rootCauseUrl ? `Approve root cause: ${o.rootCauseUrl}` : '',
    `3. ${o.scan && o.scan.ran ? o.scan.findings.map((f) => `${f.count} ${f.label}`).join('; ') : 'No automated check covers this, nothing scanned.'}`,
    '4. Reply draft:',
    (o.reply && o.reply.text) || '',
  ].filter((l) => l !== '').join('\n');

  return { html, text };
}

module.exports = {
  DAILY_CAP, LEDGER_PATH, SIMILAR_CHECKS,
  proposalsDisabled, loadLedger, saveLedger, decideSend, minutesBetween, recordSent,
  findCatalogMatches, selectAutoCloseMatch, routerAlreadyInCatalog, checkPlanAlreadyApplied, scanSimilar,
  buildRootCauseUrl, buildReaderReplyDraft, buildProposalEmail,
  isContentAdditionBody, buildNeedsReviewDiagnosis,
};
