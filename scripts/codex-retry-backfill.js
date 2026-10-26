#!/usr/bin/env node
/**
 * One more Codex try for cards Codex bounced (BRO-6260). For each open card whose newest Codex runner
 * note in the last --days is a plain "not landed" (no structural class) or a "landed part" note, post a
 * retry note carrying that note's findings. The retry note lifts the bounce memory (codexBouncedRecently)
 * and puts the card first in the next Codex run (codexCardFit 'retry', no recent-activity wait).
 * A card that already has a retry note, is In Progress/Done, or is on the leave-alone list is skipped.
 *
 *   node scripts/codex-retry-backfill.js            # dry run: lists what it would post
 *   node scripts/codex-retry-backfill.js --apply    # posts the retry notes (--limit=N for a batch, --days=N window)
 */
const R = require('./lib/codex-runner.js');
const L = require('./lib/linear-client.js');
const { historySkipReason } = require('./lib/cloud-worker-pick.js');

// Genuine failures and an owner decision (BRO-6260 parent note), and two cards checked by hand.
const LEAVE_ALONE = new Set(['BRO-5163', 'BRO-4318', 'BRO-5263', 'BRO-4672', 'BRO-3408', 'BRO-2632']);
const OPEN_STATE_TYPES = new Set(['unstarted', 'backlog']);
const NOT_LANDED_RE = /^## Codex runner: not landed\b/;
const PARTIAL_RE = /^## Codex runner: landed part of this card\b/;

/** -> 'not-landed' | 'partial' | null for a bounce note that may be retried. Structural classes stay out. */
function retryKind(body) {
  const b = String(body || '');
  if (!R.isCodexBounce(b)) return null;
  const heading = b.split('\n')[1] || '';
  const cls = R.bounceClassOf(b);
  if (cls && cls !== 'genuine-failure') return null;
  if (PARTIAL_RE.test(heading)) return 'partial';
  if (NOT_LANDED_RE.test(heading)) return 'not-landed';
  return null;
}

/** The findings of a bounce note: its text without the marker lines and without Codex's own report. */
function bounceFindings(body) {
  return String(body || '')
    .split('\n').filter((l) => !/^<!--.*-->\s*$/.test(l) && !/^## Codex runner:/.test(l)).join('\n')
    .replace(/### Codex report\n```[\s\S]*?\n```\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Pure selection over one card's comments and state -> { kind, findings } | { skip }. */
function planRetry({ identifier, stateType, comments, nowMs = Date.now(), issue = null }) {
  if (LEAVE_ALONE.has(identifier)) return { skip: 'leave-alone' };
  if (!OPEN_STATE_TYPES.has(stateType)) return { skip: `state ${stateType}` };
  const list = (comments || []).filter((c) => c && Number.isFinite(Date.parse(c.createdAt)));
  if (list.some((c) => String(c.body || '').startsWith(R.RETRY_MARKER))) return { skip: 'already retried' };
  const bounces = list.filter((c) => R.isCodexBounce(c.body)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (!bounces.length) return { skip: 'no bounce note on the card' };
  const at = Date.parse(bounces[0].createdAt);
  // A written note answered the bounce (a handoff, a reservation, "already applied"): its call, not ours.
  if (list.some((c) => Date.parse(c.createdAt) > at && R.isPersonComment(c.body))) return { skip: 'a written note answered the bounce' };
  // An older structural bounce still standing (owner decision, missing credential) keeps the card out.
  if (R.structuralBounceHolds(list, nowMs)) return { skip: 'an earlier structural bounce still holds' };
  const kind = retryKind(bounces[0].body);
  if (!kind) return { skip: `newest bounce is ${R.bounceClassOf(bounces[0].body) || 'not retryable'}` };
  // The runner would still pass it over (Mac-only, too broad, paused for a blocker): a note would change nothing.
  if (issue) {
    // As leaveToCodex: any lane may take it (the GHA lane is outside the ladder's cloud data-route lock).
    const fit = R.codexCardFit({ title: issue.title, description: issue.description, comments: list, nowMs, canDispatch: true, dataRouteLocked: false });
    if (fit.skip) return { skip: `codex fit: ${fit.skip}` };
    const held = historySkipReason(issue, list, nowMs);
    if (held) return { skip: `pause history: ${held}` };
  }
  return { kind, findings: bounceFindings(bounces[0].body) };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const days = Number((process.argv.find((a) => a.startsWith('--days=')) || '--days=14').slice(7)) || 14;
  const sinceIso = new Date(Date.now() - days * 864e5).toISOString();
  const notes = await L.listRecentCommentsContaining({ sinceIso, text: 'codex-runner-bounced', max: 2000 });
  const ids = [...new Set(notes.filter((c) => c.issue && retryKind(c.body)).map((c) => c.issue.identifier))].sort();
  const limit = Number((process.argv.find((a) => a.startsWith('--limit=')) || '--limit=0').slice(8)) || Infinity;
  const tally = { posted: 0, wouldPost: 0, skipped: 0, byKind: {} };
  for (const id of ids) {
    const issue = await L.getIssue(id);
    if (!issue) { console.log(`${id}: not found`); tally.skipped++; continue; }
    const plan = planRetry({ identifier: id, stateType: issue.state && issue.state.type, comments: (issue.comments && issue.comments.nodes) || [], issue });
    if (plan.skip) { console.log(`${id}: skip (${plan.skip})`); tally.skipped++; continue; }
    tally.byKind[plan.kind] = (tally.byKind[plan.kind] || 0) + 1;
    const reason = plan.kind === 'partial'
      ? 'Codex landed part of this card and the rest is still open.'
      : 'Codex bounced this card and no Claude worker has taken it.';
    if (tally.posted + tally.wouldPost >= limit) { console.log(`${id}: held back (--limit)`); tally.skipped++; continue; }
    if (!apply) { console.log(`${id}: would retry (${plan.kind}, ${plan.findings.length} chars of findings)`); tally.wouldPost++; continue; }
    try { await L.createComment(issue.id, R.retryBody({ findings: plan.findings, reason })); }
    catch (e) { console.log(`${id}: post failed (${e.message}); a rerun retries it`); tally.skipped++; continue; }
    console.log(`${id}: retry posted (${plan.kind})`);
    tally.posted++;
  }
  console.log(JSON.stringify(tally));
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { retryKind, bounceFindings, planRetry, LEAVE_ALONE };
