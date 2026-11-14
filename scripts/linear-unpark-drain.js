#!/usr/bin/env node
/**
 * linear-unpark-drain.js — move technically parked Linear cards to Todo so the
 * cloud workers pick them up (BRO-5626).
 *
 * Sessions file discoveries with --park "<why it needs its own session>", and
 * the picker (scripts/lib/cloud-worker-pick.js) never takes a parked Backlog
 * card unless its reason is on a narrow technical allowlist. The Mac drain
 * (scripts/linear-drain-parked.js) that promoted them stopped on 2026-09-19.
 * On 2026-10-18 the picker skipped 187 cards as parked-or-backlog; 89 had a
 * safe VERIFY and a park reason that named nothing a worker can't do.
 *
 * Each run lists open issues, keeps the ones scripts/lib/linear-drain-parked.js
 * unparkSkipReason clears (worker-takeable park reasons only, safe VERIFY, no
 * other headless blocker), re-reads each card with its comments, and with
 * --apply rewrites every "PARKED:" line to "UNPARKED (BRO-5626 drain <date>):"
 * (the reason stays readable), moves a Backlog card to Todo at its priority and
 * comments why. Highest priority first, then oldest, at most --cap per run.
 * The rewritten line makes a re-run skip the card, and a later pause sends it
 * back to Backlog as a paused card the picker already takes.
 *
 * Usage:
 *   node scripts/linear-unpark-drain.js            dry run: print what would move
 *   node scripts/linear-unpark-drain.js --apply    move up to --cap cards (default 25)
 *   --cap N   per-run limit   --json   one JSON summary line   --help
 *
 * Kill switch: LINEAR_UNPARK_DRAIN_DISABLED=1 (or true/yes). Scheduled daily by
 * .github/workflows/linear-unpark-drain.yml.
 */
'use strict';

const { parseArgs } = require('./lib/cli-args.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const DEFAULT_CAP = 25;
const DRAIN_TAG = 'BRO-5626 drain';

const USAGE = `linear-unpark-drain.js — move technically parked cards to Todo (BRO-5626).
  (no flags)  dry run       --apply  write       --cap N  per-run limit (default ${DEFAULT_CAP})
  --json      summary line  Kill switch: LINEAR_UNPARK_DRAIN_DISABLED=1`;

function unparkComment(reasons) {
  return [
    `Unparked by the daily drain (${DRAIN_TAG}, scripts/linear-unpark-drain.js): the park reason names nothing a worker cannot do, and the card has a safe VERIFY, so it moves to Todo for the cloud workers.`,
    '',
    ...reasons.map((r) => `> ${r}`),
    '',
    'If this card really waits on the owner, a key, a date or the Mac, park it again with that reason in the PARKED line.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2), deps = {}) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return null; }
  const args = parseArgs(argv, { coerceBooleans: true, textFlags: ['cap'] });
  const apply = args.apply === true;
  const cap = Number.isFinite(Number(args.cap)) && Number(args.cap) >= 0 ? Number(args.cap) : DEFAULT_CAP;
  if (/^(1|true|yes|on)$/i.test(String(process.env.LINEAR_UNPARK_DRAIN_DISABLED || '').trim())) {
    console.log('linear-unpark-drain: LINEAR_UNPARK_DRAIN_DISABLED is set, nothing done.');
    return null;
  }
  require('./lib/load-env').loadEnv();
  const linear = deps.linear || require('./lib/linear-client.js');
  const drain = require('./lib/linear-drain-parked.js');
  const { priorityRank } = require('./lib/linear-dispatch.js');
  const { PARKED_SENTINEL_RE } = require('./lib/headless-dispatchability.js');

  const open = await linear.listOpenIssuesWithDescriptions();
  const skipped = {};
  const prelim = [];
  let parkedSeen = 0;
  for (const issue of open) {
    if (!PARKED_SENTINEL_RE.test(issue.description || '')) continue;
    parkedSeen += 1;
    const why = drain.unparkSkipReason(issue);
    // A VERIFY can sit in a comment, which the list read lacks: re-check those on the full read.
    if (!why || why === 'no-safe-verify') prelim.push(issue);
    else skipped[why] = (skipped[why] || 0) + 1;
  }
  prelim.sort((a, b) => (priorityRank(a) - priorityRank(b)) || (drain.issueNumber(a.identifier) - drain.issueNumber(b.identifier)));

  const eligible = [];
  for (const issue of prelim) {
    // Applying needs only `cap` cards; a dry run reads them all to report the full count.
    if (apply && eligible.length >= cap) break;
    const full = await linear.getIssue(issue.identifier);
    if (!full) { skipped['not-found'] = (skipped['not-found'] || 0) + 1; continue; }
    const why = drain.unparkSkipReason(full);
    if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
    eligible.push(full);
  }

  const team = apply ? await linear.getTeam() : null;
  const todo = team && team.states.nodes.find((s) => s.type === 'unstarted' && /^todo$/i.test(s.name))
    || (team && team.states.nodes.find((s) => s.type === 'unstarted'));
  if (apply && !todo) throw new Error('no unstarted (Todo) state on the team');
  const tag = `${DRAIN_TAG} ${new Date().toISOString().slice(0, 10)}`;
  const moved = [];
  const failed = [];
  for (const issue of eligible.slice(0, cap)) {
    const reasons = [...String(issue.description || '').matchAll(/^\s*PARKED\s*:(.*)$/gim)].map((m) => m[1].trim());
    const line = `${issue.identifier} P${Number(issue.priority) - 1} ${issue.state.name} | ${reasons[0] || ''}`.slice(0, 200);
    if (!apply) { console.log(`would move: ${line}`); moved.push(issue.identifier); continue; }
    let written = false;
    try {
      // Re-read just before writing: a session may have claimed, edited or re-parked it since.
      const fresh = await linear.getIssue(issue.identifier);
      if (!fresh || fresh.description !== issue.description || !fresh.state || fresh.state.type !== issue.state.type
          || drain.unparkSkipReason(fresh)) {
        console.log(`changed since read, left alone: ${issue.identifier}`);
        skipped['changed-since-read'] = (skipped['changed-since-read'] || 0) + 1;
        continue;
      }
      const input = { description: drain.unparkDescription(issue.description, tag) };
      if (issue.state.type === 'backlog') input.stateId = todo.id;
      await linear.updateIssue(issue.id, input);
      written = true;
      await linear.createComment(issue.id, unparkComment(reasons));
      console.log(`moved: ${line}`);
      moved.push(issue.identifier);
    } catch (e) {
      // Moved but uncommented: the card is in Todo with its UNPARKED line, only the note is missing.
      const hint = written ? ' (moved to Todo, comment missing: the UNPARKED line in its description says why)' : '';
      console.error(`failed: ${issue.identifier}: ${e.message}${hint}`);
      failed.push(issue.identifier);
      if (written) moved.push(issue.identifier);
    }
  }
  const summary = { mode: apply ? 'apply' : 'dry-run', parkedSeen, eligible: eligible.length, moved: moved.length, failed, cap, skipped };
  console.log(args.json ? JSON.stringify(summary) : `linear-unpark-drain: ${summary.mode}, ${eligible.length} eligible, ${moved.length} ${apply ? 'moved' : 'would move'} (cap ${cap}), skipped ${JSON.stringify(skipped)}`);
  if (failed.length) process.exitCode = 1;
  return summary;
}

if (require.main === module) {
  main().catch((e) => { console.error(`linear-unpark-drain: ${e.message}`); process.exit(1); });
}

module.exports = { main, unparkComment, DEFAULT_CAP, DRAIN_TAG };
