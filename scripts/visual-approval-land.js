#!/usr/bin/env node
/**
 * visual-approval-land.js (BRO-6241) — CI side of the owner's "does this look
 * right?" answer. Runs every 20 minutes in visual-approval-land.yml (it holds
 * APPROVAL_HMAC_SECRET and a push token; no Claude session or worker queue is
 * involved).
 *
 *   node scripts/visual-approval-land.js [--dry-run]
 *
 * For each open card whose description carries VISUAL-APPROVAL: patch= verdict=
 * hold=, with no landing recorded yet:
 *   - Approved (a "Visual approval ref VQA<mac>" comment that MACs the card's own
 *     patch+verdict, written within 14 days): when visual-hold/bro-n still has
 *     that exact patch-id against origin/main, push it to land/bro-n-visual,
 *     which land.yml gates, rebases and ships. Comments once; moves on.
 *   - Unanswered for 14 days: comment, move the card to Todo, delete the hold and
 *     evidence refs (the card returns to the queue to be redone).
 * Exit: 0 ran, 3 could not read Linear / git.
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const va = require('./lib/visual-approval.js');
const { TERMINAL_STATE_TYPES } = require('./lib/linear-state-types.js');
const link = require('../src/lib/owner-decision-link.js');

const USAGE = 'Usage: node scripts/visual-approval-land.js [--dry-run]';
const LANDED_PREFIX = 'Visual approval landed VQL';
const EXPIRED_MARK = 'Visual approval expired VQX';
const EXPIRE_AFTER_MS = link.VISUAL_TTL_MS;

const landedMarker = (mac) => `${LANDED_PREFIX}${mac.slice(0, 16)}`;
const expiredMarker = (mac) => `${EXPIRED_MARK}${mac.slice(0, 16)}`;
// A held branch that stopped matching is not final: re-pushing the approved change must be able to land, so this marker is per observed patch.
const cleanedMarker = (mac) => `Visual approval cleaned VQC${mac.slice(0, 16)}`;
const voidMarker = (mac, patch) => `Visual approval void VQV${mac.slice(0, 12)}${String(patch).slice(0, 12)}`;

/** What to do with one card. Pure: the CLI below does the git and Linear writes. */
function planCard(issue, secret, now = Date.now(), currentPatch = null) {
  const v = link.parseVisualApproval(issue.description);
  if (!v) return { action: 'skip', why: 'no visual approval line' };
  const mac = link.visualMac(secret, issue.identifier, v.patch, v.verdict);
  const comments = issue.comments || { nodes: [] };
  const has = (m) => (comments.nodes || []).some((c) => link.bodyHasMarker(c.body, m));
  if (has(landedMarker(mac)) || has(expiredMarker(mac))) return { action: 'skip', why: 'already handled', v, mac };
  if (link.hasVisualApproval({ comments, secret, id: issue.identifier, patch: v.patch, verdict: v.verdict, now })) {
    if (currentPatch === null) return { action: 'land', v, mac };
    return currentPatch === v.patch ? { action: 'land', v, mac } : { action: 'void', why: 'the held branch no longer matches the approved change', v, mac };
  }
  // Answered without an approval (a Reject or the owner's own words): the held refs are dead weight.
  if (/ANSWERED by the owner/.test(issue.description || '')) return has(cleanedMarker(mac)) ? { action: 'skip', why: 'rejected, already cleaned', v, mac } : { action: 'cleanup', v, mac };
  // Age counts from the worker's own "Asked the owner" comment; a card without one never expires.
  const askedAt = (comments.nodes || []).filter((c) => /^Asked the owner to look at/.test(link.unescapeMarkdown(c.body).trim()))
    .map((c) => new Date(c.createdAt).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (askedAt && now - askedAt > EXPIRE_AFTER_MS && !/ANSWERED by the owner/.test(issue.description || '')) return { action: 'expire', v, mac };
  return { action: 'wait', v, mac };
}

const QUERY = `query($teamKey: String!, $after: String) {
  issues(first: 50, after: $after, filter: { team: { key: { eq: $teamKey } }, state: { type: { nin: ${JSON.stringify(TERMINAL_STATE_TYPES)} } }, description: { contains: "VISUAL-APPROVAL" } }) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier description createdAt comments(first: 100) { nodes { id body createdAt } } }
  }
}`;

async function fetchOpenIssues(linear) {
  const out = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const data = await linear.graphql(QUERY, { teamKey: linear.TEAM_KEY, after });
    out.push(...data.issues.nodes);
    if (!data.issues.pageInfo.hasNextPage) return out;
    after = data.issues.pageInfo.endCursor;
  }
  throw new Error('too many cards; refusing to act on a partial list');
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const dryRun = argv.includes('--dry-run');
  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) { console.error('[visual-land] APPROVAL_HMAC_SECRET is not set'); return dryRun ? 0 : 3; }
  const linear = require('./lib/linear-client.js');
  let issues;
  try { issues = (await fetchOpenIssues(linear)).filter((i) => link.parseVisualApproval(i.description)); } catch (e) { console.error(`[visual-land] could not read Linear: ${e.message}`); return 3; }
  console.log(`[visual-land] ${issues.length} card(s) with a visual approval line`);
  const comment = async (issue, body) => {
    const row = await linear.getIssue(issue.identifier);
    await linear.createComment(row.id, body);
  };
  let failures = 0;
  for (const issue of issues) {
    const first = planCard(issue, secret);
    if (first.action === 'skip' || first.action === 'wait') { console.log(`[visual-land] ${issue.identifier}: ${first.action}${first.why ? ` (${first.why})` : ''}`); continue; }
    const { v, mac } = first;
    const hold = va.holdBranch(issue.identifier);
    try {
      if (first.action === 'land') {
        if (v.hold !== hold) throw new Error(`hold branch ${v.hold} does not belong to ${issue.identifier}`);
        va.git(['fetch', '--quiet', 'origin', 'main', `+refs/heads/${hold}:refs/remotes/origin/${hold}`]);
        const current = va.patchId('origin/main', `origin/${hold}`);
        const plan = planCard(issue, secret, Date.now(), current);
        if (plan.action === 'void') {
          console.log(`[visual-land] ${issue.identifier}: void (${plan.why})`);
          const told = (issue.comments.nodes || []).some((c) => link.bodyHasMarker(c.body, voidMarker(mac, current)));
          if (!dryRun && !told) await comment(issue, `The owner approved a change, but ${hold} no longer matches it, so nothing was shipped. Restore the approved change on ${hold}, or ask again with node scripts/visual-approval.js request.\n\n${voidMarker(mac, current)}`);
          continue;
        }
        const landRef = `land/${issue.identifier.toLowerCase()}-visual`;
        console.log(`[visual-land] ${issue.identifier}: approved, ${dryRun ? 'would push' : 'pushing'} origin/${hold} -> ${landRef}`);
        if (dryRun) continue;
        va.git(['push', 'origin', `refs/remotes/origin/${hold}:refs/heads/${landRef}`]);
        await comment(issue, `Owner approved. Pushed the held change to ${landRef}; land.yml gates and ships it. Check the Land run and prod before closing this card.\n\n${landedMarker(mac)}`);
      } else if (first.action === 'cleanup') {
        console.log(`[visual-land] ${issue.identifier}: rejected, removing ${hold}`);
        if (dryRun) continue;
        for (const ref of [hold, va.evidenceBranch(issue.identifier)]) { try { va.git(['push', 'origin', `:refs/heads/${ref}`]); } catch { /* already gone */ } }
        await comment(issue, `The owner did not approve this change, so the held branch and screenshots were removed.\n\n${cleanedMarker(mac)}`);
      } else if (first.action === 'expire') {
        console.log(`[visual-land] ${issue.identifier}: expired`);
        if (dryRun) continue;
        for (const ref of [hold, va.evidenceBranch(issue.identifier)]) { try { va.git(['push', 'origin', `:refs/heads/${ref}`]); } catch { /* already gone */ } }
        const row = (await linear.graphql('query($id: String!) { issue(id: $id) { id team { states { nodes { id name } } } } }', { id: issue.identifier })).issue;
        const todo = ((row.team && row.team.states && row.team.states.nodes) || []).find((s) => /^todo$/i.test(s.name));
        await linear.createComment(row.id, `Nobody answered this visual approval within 14 days, so the held change was removed. The card is back in the queue; redo the work and ask again.\n\n${expiredMarker(mac)}`);
        if (todo) await linear.updateIssue(row.id, { stateId: todo.id });
      }
    } catch (e) { failures++; console.error(`[visual-land] ${issue.identifier}: ${e.message}`); }
  }
  return failures ? 1 : 0;
}

if (require.main === module) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(`[visual-land] ${e.stack || e.message}`); process.exitCode = 3; });
}
module.exports = { planCard, main, landedMarker, expiredMarker, voidMarker };
