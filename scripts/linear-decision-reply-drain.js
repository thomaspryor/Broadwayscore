#!/usr/bin/env node
/**
 * linear-decision-reply-drain.js: act on the owner's reply to a DECISION NEEDED card (BRO-6168).
 *
 * The owner answered "A" on BRO-6110 from the morning digest and nothing read it. Each run
 * lists open cards with a live DECISION NEEDED line or awaiting-owner label, reads their comments and, per
 * scripts/lib/decision-reply.js:
 *   - clear pick, safe to run, card is worker-ready: records "Owner answered: Option X", turns
 *     the DECISION NEEDED line into an ANSWERED line, moves a Backlog card to Todo (priority at
 *     least High) so the cloud workers take it;
 *   - clear pick, but it needs the owner (key, money, email to people, sign-in): records the
 *     answer and says plainly what only the owner can do; nothing is started;
 *   - clear pick, card not worker-ready (no safe check yet): records the answer and leaves it
 *     on the board for a session;
 *   - short reply that is not a pick: one plain follow-up question.
 *   - awaiting-owner without a decision line (BRO-6180): yes records approval and removes
 *     that label; no records the owner's words and leaves the card parked.
 * Order of writes: the card first (a failed write is retried next run), then the "Owner answered" comment.
 *
 * Usage:
 *   node scripts/linear-decision-reply-drain.js           dry run
 *   node scripts/linear-decision-reply-drain.js --apply   write (at most --cap cards, default 5)
 *   --json   one JSON summary line   --help
 * Kill switch: LINEAR_DECISION_REPLY_DRAIN_DISABLED=1. Scheduled twice a day by
 * .github/workflows/linear-decision-reply-drain.yml. Sends no email.
 */
'use strict';

const { parseArgs } = require('./lib/cli-args.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const DEFAULT_CAP = 5;
// A parser bug that matched every comment must not move dozens of cards.
const FLOOD_LIMIT = 12;

const USAGE = `linear-decision-reply-drain.js: act on owner decision and awaiting-owner replies (BRO-6168, BRO-6180).
  (no flags)  dry run     --apply  write     --cap N  per-run limit (default ${DEFAULT_CAP})
  --json      summary     Kill switch: LINEAR_DECISION_REPLY_DRAIN_DISABLED=1`;

async function main(argv = process.argv.slice(2), deps = {}) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return null; }
  const args = parseArgs(argv, { coerceBooleans: true, textFlags: ['cap'] });
  const apply = args.apply === true;
  const cap = Number.isFinite(Number(args.cap)) && Number(args.cap) >= 0 ? Number(args.cap) : DEFAULT_CAP;
  if (/^(1|true|yes|on)$/i.test(String(process.env.LINEAR_DECISION_REPLY_DRAIN_DISABLED || '').trim())) {
    console.log('linear-decision-reply-drain: LINEAR_DECISION_REPLY_DRAIN_DISABLED is set, nothing done.');
    return null;
  }
  require('./lib/load-env').loadEnv();
  const linear = deps.linear || require('./lib/linear-client.js');
  const reply = require('./lib/decision-reply.js');
  const { isAwaitingOwner } = require('./lib/owner-approval-channel.js');
  const { findDecisionQuestion } = require('./lib/decision-card-parse.js');
  const drain = require('./lib/linear-drain-parked.js');
  const { headlessUnfitReason } = require('./lib/cloud-worker-pick.js');
  const now = deps.now ? deps.now() : new Date();
  const date = now.toISOString().slice(0, 10);
  const planOptions = { date, verifyCommand: drain.verifyCommand, unfitReason: (i) => headlessUnfitReason(i), nowMs: now.getTime() };

  const open = await linear.listOpenIssuesWithDescriptions();
  const candidates = open.filter((i) => i && (findDecisionQuestion(i.description) || isAwaitingOwner(i)));
  const plans = [];
  const skipped = {};
  for (const stub of candidates) {
    const full = await linear.getIssue(stub.identifier);
    if (!full) { skipped['not-found'] = (skipped['not-found'] || 0) + 1; continue; }
    const plan = reply.planReply(full, planOptions);
    if (plan.action === 'skip') { skipped[plan.why] = (skipped[plan.why] || 0) + 1; continue; }
    plans.push({ issue: full, plan });
  }
  const picks = plans.filter((x) => x.plan.action !== 'clarify').length;
  if (picks > FLOOD_LIMIT) {
    console.error(`linear-decision-reply-drain: ${picks} cards look answered in one run (limit ${FLOOD_LIMIT}); doing nothing, a parser bug is likelier than that many owner replies.`);
    process.exitCode = 1;
    return { mode: 'flood-stop', candidates: candidates.length, found: picks };
  }

  const needsTodo = apply && plans.slice(0, cap).some(({ plan }) => plan.action === 'dispatch');
  const team = needsTodo ? await linear.getTeam() : null;
  const todo = team && (team.states.nodes.find((s) => s.type === 'unstarted' && /^todo$/i.test(s.name)) || team.states.nodes.find((s) => s.type === 'unstarted'));
  if (needsTodo && !todo) throw new Error('no unstarted (Todo) state on the team');
  const done = { dispatch: [], 'needs-session': [], 'owner-only': [], clarify: [], approve: [], decline: [] };
  const failed = [];
  for (const { issue, plan } of plans.slice(0, cap)) {
    const id = issue.identifier;
    const line = `${id} ${plan.action}${plan.key ? ` Option ${plan.key}` : ''}${plan.why ? ` (${plan.why})` : ''}`;
    if (!apply) { console.log(`would act: ${line}`); done[plan.action].push(id); continue; }
    try {
      const fresh = await linear.getIssue(id);
      const freshPlan = fresh && reply.planReply(fresh, planOptions);
      if (!fresh || fresh.description !== issue.description || freshPlan.action !== plan.action ||
          !freshPlan.comment || freshPlan.comment.id !== plan.comment.id || freshPlan.comment.body !== plan.comment.body) {
        console.log(`changed since read, left alone: ${id}`);
        skipped['changed-since-read'] = (skipped['changed-since-read'] || 0) + 1;
        continue;
      }
      if (plan.action === 'clarify') {
        await linear.createComment(issue.id, reply.clarifyComment({ options: plan.card.options }));
      } else if (plan.action === 'approve' || plan.action === 'decline') {
        if (plan.action === 'approve') {
          const labels = (fresh.labels && fresh.labels.nodes) || [];
          await linear.updateIssue(issue.id, {
            labelIds: labels.filter((label) => label.name.toLowerCase() !== reply.AWAITING_OWNER_LABEL).map((label) => label.id),
          });
        }
        // As with decision cards, a failed update leaves the reply retryable.
        // If only this comment fails, the owner's original words remain on the
        // card and the failure is reported; acknowledgement repair is manual.
        await linear.createComment(issue.id, reply.approvalComment(plan));
      } else {
        const answered = reply.answeredComment({ key: plan.key, name: plan.name, replyText: plan.comment.body, date });
        const note = plan.action === 'dispatch' ? reply.dispatchedNote(plan.verify)
          : plan.action === 'owner-only' ? `\n\n${reply.ownerOnlyComment({ key: plan.key, name: plan.name, reason: plan.ownerOnly })}`
            : reply.needsSessionNote(plan.why);
        const description = plan.description || reply.rewriteDescription(issue.description, {
          key: plan.key, name: plan.name, upside: plan.upside, date, tag: 'BRO-6168 owner reply', ownerOnly: plan.ownerOnly,
        });
        if (!description) { skipped['no-live-decision'] = (skipped['no-live-decision'] || 0) + 1; continue; }
        const input = { description, title: reply.dropMarkerFromTitle(issue.title) };
        if (plan.action === 'dispatch') {
          // Only a card handed to the workers stops waiting on the owner; the other two still do.
          const labels = (fresh.labels && fresh.labels.nodes) || [];
          if (labels.some((l) => l.name === reply.AWAITING_OWNER_LABEL)) input.labelIds = labels.filter((l) => l.name !== reply.AWAITING_OWNER_LABEL).map((l) => l.id);
          if (issue.state && issue.state.type === 'backlog') input.stateId = todo.id;
          if (!issue.priority || Number(issue.priority) > 2) input.priority = 2;
        }
        // Card first: if this write fails the reply is still unanswered and the next run retries.
        // The comment (what owner-decision-recall reads) follows; if only it fails, the ANSWERED line stays.
        await linear.updateIssue(issue.id, input);
        await linear.createComment(issue.id, `${answered}${note}`);
      }
      console.log(`acted: ${line}`);
      done[plan.action].push(id);
    } catch (e) {
      console.error(`failed: ${id}: ${e.message}`);
      failed.push(id);
    }
  }
  const summary = { mode: apply ? 'apply' : 'dry-run', candidates: candidates.length, ...done, failed, skipped, cap };
  console.log(args.json ? JSON.stringify(summary) : `linear-decision-reply-drain: ${summary.mode}, ${candidates.length} open decisions/approvals, dispatched ${done.dispatch.length}, needs-session ${done['needs-session'].length}, owner-only ${done['owner-only'].length}, asked ${done.clarify.length}, approved ${done.approve.length}, declined ${done.decline.length}, skipped ${JSON.stringify(skipped)}`);
  if (failed.length) process.exitCode = 1;
  return summary;
}

if (require.main === module) {
  main().catch((e) => { console.error(`linear-decision-reply-drain: ${e.message}`); process.exit(1); });
}

module.exports = { main, DEFAULT_CAP, FLOOD_LIMIT };
