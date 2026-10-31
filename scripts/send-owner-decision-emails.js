#!/usr/bin/env node
/**
 * send-owner-decision-emails.js (BRO-6147): one email per new owner decision,
 * with tap-to-answer buttons (src/app/api/owner-decision/route.ts), plus the
 * pickup of answers typed straight into the card.
 *
 *   node scripts/send-owner-decision-emails.js [--dry-run] [--only=BRO-N]
 *        [--roundup] [--no-sweep] [--max=8]
 *
 * Transactional sends to OWNER_EMAIL only (CLAUDE.md §17: never a broadcast).
 * Told-set = a "Decision email ref ODE<hmac>" comment on the card, so the job
 * is stateless (runs every 20 minutes in CI). Cards the old daily batched
 * email announced (ledger condition owner-decisions:new) count as told when
 * the ledger still lists them; the open backlog is small, so a miss costs a
 * few emails, capped at --max per run. Exit codes: 0 ran, 3 could not read Linear.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const linear = require('./lib/linear-client');
const { TERMINAL_STATE_TYPES } = require('./lib/linear-state-types.js');
const { findOwnerDecisions, planNotification } = require('./lib/owner-decision-notify.js');
const link = require('../src/lib/owner-decision-link.js');
const { buildDecisionEmail, buildRoundupEmail, buildBacklogEmail } = require('./lib/owner-decision-email.js');
const { holdReason, sendMode } = require('./lib/owner-decision-quiet-period.js');

const USAGE = 'Usage: node scripts/send-owner-decision-emails.js [--dry-run] [--only=BRO-N] [--roundup] [--no-sweep] [--max=8]';
const LEGACY_KEY = 'owner-decisions:new';
// BRO-6235: this many never-announced decisions at once go out as ONE email
// linking to the list page, not one email each.
const BACKLOG_MIN = 3;
const ROUNDUP_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_PAGES = 40;

const QUERY = `query($teamKey: String!, $after: String) {
  issues(first: 25, after: $after, filter: {
    team: { key: { eq: $teamKey } },
    state: { type: { nin: ${JSON.stringify(TERMINAL_STATE_TYPES)} } }
  }) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier title description priority url createdAt labels { nodes { id name } }
            comments(first: 100) { nodes { id body createdAt } } }
  }
}`;

async function fetchOpenIssues() {
  const out = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await linear.graphql(QUERY, { teamKey: linear.TEAM_KEY, after });
    out.push(...data.issues.nodes);
    if (!data.issues.pageInfo.hasNextPage) return out;
    after = data.issues.pageInfo.endCursor;
  }
  throw new Error('too many open issues; refusing to treat a partial list as complete');
}

// Cards the old batched email already told the owner about (read-only).
function legacyNotified() {
  try {
    const p = path.resolve(__dirname, '../data/audit/alert-ledger.json');
    const c = JSON.parse(fs.readFileSync(p, 'utf8')).conditions[LEGACY_KEY];
    return c && Array.isArray(c.notifiedIds) ? c.notifiedIds : [];
  } catch { return []; }
}

function parseArgs(argv) {
  const only = (argv.find((a) => a.startsWith('--only=')) || '').slice(7) || null;
  const max = parseInt((argv.find((a) => a.startsWith('--max=')) || '').slice(6), 10);
  return { dryRun: argv.includes('--dry-run'), only, roundup: argv.includes('--roundup'), sweep: !argv.includes('--no-sweep'), max: Number.isInteger(max) && max > 0 ? max : 8 };
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const opts = parseArgs(argv);
  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) { console.error('[owner-decision-emails] APPROVAL_HMAC_SECRET is not set; cannot sign links'); return opts.dryRun ? 0 : 3; }
  if (!opts.dryRun && !process.env.CI && !process.env.OWNER_DECISION_LOCAL_OK) {
    console.error('[owner-decision-emails] refusing to send outside CI (set OWNER_DECISION_LOCAL_OK=1 if you mean it)');
    return 2;
  }

  let failures = 0;
  let issues;
  try { issues = await fetchOpenIssues(); } catch (err) { console.error(`[owner-decision-emails] could not read Linear: ${err.message}`); return 3; }
  // BRO-6401: an answer whose card write was lost (comment exists, DECISION NEEDED line still
  // there) is finished here, so it is neither listed as open nor asked about again.
  // Kill switch: OWNER_DECISION_RECONCILE_DISABLED=true skips the repair pass (emails still go out).
  let reconciled = [];
  if (process.env.OWNER_DECISION_RECONCILE_DISABLED === 'true') console.log('[reconcile] disabled by OWNER_DECISION_RECONCILE_DISABLED');
  else {
    try { reconciled = await link.reconcileAnswered({ graphql: linear.graphql, issues, secret, dryRun: opts.dryRun }); }
    catch (err) { console.error(`[reconcile] pass failed: ${err.message}`); failures++; }
  }
  for (const r of reconciled) console.log(`[reconcile] ${r.identifier}: ${r.status}${r.repaired ? ' (card repaired)' : ''}${r.error ? ` ${r.error}` : ''}`);
  console.log(`[reconcile] ${reconciled.filter((r) => r.repaired || r.status === 'would-repair').length} answered card(s) ${opts.dryRun ? 'to repair' : 'repaired'}, ${reconciled.filter((r) => r.status === 'error').length} failed`);
  const fixedIds = new Set(reconciled.filter((r) => r.repaired).map((r) => r.identifier));
  if (fixedIds.size) issues = issues.filter((i) => !fixedIds.has(i.identifier));
  failures += reconciled.filter((r) => r.status === 'error').length;
  const byId = new Map(issues.map((i) => [i.identifier, i]));
  let decisions = findOwnerDecisions(issues);
  if (opts.only) decisions = decisions.filter((d) => d.identifier === opts.only);
  console.log(`[owner-decision-emails] ${decisions.length} open decision(s) on ${issues.length} open card(s)`);

  const refOf = (d) => link.decisionRef(secret, d.identifier, link.questionHash(d.question || d.title));
  const swept = new Set();

  // 1. Answers typed into the card ("ANSWER: ..."). Same record path as the page.
  if (opts.sweep) {
    for (const d of decisions) {
      const issue = byId.get(d.identifier);
      const hash = link.questionHash(d.question || d.title);
      // Only replies written AFTER the decision email went out count: an older
      // "ANSWER:" belongs to an earlier question, and sessions comment under the
      // owner's identity, so nothing else says who wrote a comment.
      const nodes = (issue.comments && issue.comments.nodes) || [];
      const sentAt = nodes.filter((c) => link.bodyHasMarker(c.body, link.emailMarker(refOf(d))))
        .map((c) => String(c.createdAt)).sort()[0];
      if (!sentAt) continue;
      const reply = nodes.filter((c) => String(c.createdAt) > sentAt)
        .map((c) => ({ c, text: link.parseOwnerReply(c.body) })).filter((x) => x.text)
        .sort((a, b) => String(a.c.createdAt).localeCompare(String(b.c.createdAt)))[0];
      if (!reply) continue;
      if (opts.dryRun) { console.log(`[sweep] would record the card reply on ${d.identifier}`); continue; }
      try {
        const r = await link.recordAnswer({ graphql: linear.graphql, id: d.identifier, hash, secret, choiceKey: 'own', text: reply.text, via: 'a comment on the card' });
        console.log(`[sweep] ${d.identifier}: ${r.status}`);
        swept.add(d.identifier);
      } catch (err) { failures++; console.error(`[sweep] ${d.identifier}: ${err.message}`); }
    }
  }

  const hasComment = (d, marker) => ((byId.get(d.identifier).comments || {}).nodes || []).some((c) => link.bodyHasMarker(c.body, marker));

  // 2. Roundup reminder: decisions emailed more than 3 days ago and still open.
  if (opts.roundup) {
    const stale = decisions.filter((d) => {
      // BRO-6266: the same already-answered test as the per-card email and the digest.
      const hold = holdReason(byId.get(d.identifier), d, { secret });
      if (hold && hold.reason !== 'recent-activity') { console.log(`[roundup] skip ${d.identifier}: ${hold.detail}`); return false; }
      const c = ((byId.get(d.identifier).comments || {}).nodes || []).find((x) => link.bodyHasMarker(x.body, link.emailMarker(refOf(d))));
      return c && Date.now() - new Date(c.createdAt).getTime() > ROUNDUP_AFTER_MS;
    }).slice(0, 20);
    if (!stale.length) { console.log('[roundup] nothing has waited more than 3 days'); return 0; }
    const email = buildRoundupEmail({ decisions: stale, secret });
    if (opts.dryRun) { console.log(`[roundup] would email: ${email.subject}`); return 0; }
    const { sendEmailAlert } = require('./lib/discord-notify.js');
    const day = new Date().toISOString().slice(0, 10);
    const ok = await sendEmailAlert({ title: email.subject, description: '', severity: 'error', subjectLabel: '', html: email.html, idempotencyKey: `owner-decision-roundup:${day}` });
    console.log(`[roundup] ${ok ? 'sent' : 'NOT delivered'}: ${email.subject}`);
    return 0;
  }

  // 3. One email per decision that has never been announced.
  const legacy = planNotification(decisions, legacyNotified());
  const legacyFresh = new Set(legacy.fresh.map((d) => d.identifier));
  const untold = decisions.filter((d) => opts.only || legacyFresh.has(d.identifier))
    .filter((d) => !swept.has(d.identifier) && !hasComment(d, link.emailMarker(refOf(d))));
  // BRO-6266: hold a decision already answered, one a session is working on
  // right now (a comment in the last 90 min), or one with a plain comment that
  // may already answer it. Held cards stay on the digest and the list page.
  const fresh = untold.filter((d) => {
    const hold = holdReason(byId.get(d.identifier), d, { secret });
    if (hold) console.log(`[hold] ${d.identifier} (${hold.reason}): ${hold.detail}`);
    return !hold;
  });
  console.log(`[owner-decision-emails] ${fresh.length} not yet emailed, ${untold.length - fresh.length} held (cap ${opts.max} per run)`);
  const { sendEmailAlert } = require('./lib/discord-notify.js');
  const markTold = async (d, text) => {
    try {
      const issue = await linear.graphql('query($id: String!) { issue(id: $id) { id } }', { id: d.identifier });
      await linear.graphql('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }',
        { input: { issueId: issue.issue.id, body: `${text}\n\n${link.emailMarker(refOf(d))}` } });
      return true;
    } catch (err) { console.error(`[owner-decision-emails] sent ${d.identifier} but could not record it: ${err.message}`); return false; }
  };
  let sent = 0;
  // 3a. A pile of untold decisions: one email with the list link, then the
  // same told marker the per-decision path writes (the ANSWER: sweep and the
  // roundup both key on it).
  if (sendMode(fresh, { backlogMin: BACKLOG_MIN }) === 'backlog') {
    const email = buildBacklogEmail({ decisions: fresh, secret });
    if (opts.dryRun) { console.log(`[dry-run] would send ONE backlog email "${email.subject}" covering ${fresh.map((d) => d.identifier).join(', ')}`); return 0; }
    // Keyed on the exact set of cards, so a partly failed marker write cannot re-send the same list inside Resend's 24h dedupe window.
    const day = new Date().toISOString().slice(0, 10);
    const ok = await sendEmailAlert({ title: email.subject, description: '', severity: 'error', subjectLabel: '', html: email.html, idempotencyKey: `owner-decision-backlog:${day}:${fresh.map((d) => d.identifier).sort().join(',')}` });
    if (!ok) { console.error('[owner-decision-emails] backlog email was not delivered; will retry next run'); return 1; }
    for (const d of fresh) await markTold(d, "Listed in the owner's decisions email (one email with a link to the list page).");
    console.log(`[owner-decision-emails] sent ONE backlog email covering ${fresh.length} decision(s)`);
    return failures ? 1 : 0;
  }
  for (const d of fresh.slice(0, opts.max)) {
    const email = buildDecisionEmail({ decision: d, description: byId.get(d.identifier).description, secret });
    if (opts.dryRun) { console.log(`[dry-run] would email "${email.subject}" (${d.identifier})`); continue; }
    // Resend dedupes this key for 24h, so a failed marker write below cannot double-send within a day.
    const ok = await sendEmailAlert({ title: email.subject, description: '', severity: 'error', subjectLabel: '', html: email.html, idempotencyKey: `owner-decision:${d.identifier}:${email.tokenHash}` });
    if (!ok) { failures++; console.error(`[owner-decision-emails] email for ${d.identifier} was not delivered; will retry next run`); continue; }
    await markTold(d, 'Emailed the owner this decision with answer buttons.');
    sent++;
  }
  console.log(`[owner-decision-emails] emailed ${sent} decision(s)`);
  // A non-zero exit fires the workflow's notify-failure step (a Resend outage must not stay silent).
  return failures ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => { console.error(`[owner-decision-emails] ${err.stack || err.message}`); process.exitCode = 3; });
}

module.exports = { main, fetchOpenIssues, QUERY, parseArgs };
