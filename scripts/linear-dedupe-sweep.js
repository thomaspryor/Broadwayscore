#!/usr/bin/env node
/**
 * linear-dedupe-sweep.js — measure and clean up repeat cards with the SAME
 * rules the card front door applies (scripts/lib/card-dedupe.js, BRO-5488).
 *
 *   node scripts/linear-dedupe-sweep.js --replay-days=7
 *       Replays every card created in the window, oldest first, against the
 *       cards open at that moment: how many the front door would have noted on
 *       an open card (near-duplicate) or folded into a rollup card. Read-only.
 *   node scripts/linear-dedupe-sweep.js --open [--apply]
 *       Open near-duplicate groups (oldest card kept). Dry-run by default;
 *       --apply marks each newer copy Duplicate of the oldest via
 *       linear-brain.js update (the relation + a comment), Backlog copies
 *       only, never a Todo or started card.
 *
 * Two replay numbers, because history does not say which filer opted in:
 *   as-shipped  near-dup for parked cards with no per-card contract (not the alert
 *               router, digest-autofix or the canary); rollup only for parked
 *               workflow:* filings, which old cards cannot be told apart
 *               from, so 0 is reported for rollup here.
 *   all-filers  the same rules applied to every automated filer (upper bound).
 */

'use strict';

require('./lib/cli-help').exitOnHelp(module);

const { spawnSync } = require('child_process');
const path = require('path');
const d = require('./lib/card-dedupe.js');

const DAY = 86400e3;

function parseArgs(argv) {
  const a = { replayDays: null, open: false, apply: false };
  for (const x of argv) {
    if (x.startsWith('--replay-days=')) a.replayDays = Number(x.split('=')[1]);
    else if (x === '--open') a.open = true;
    else if (x === '--apply') a.apply = true;
  }
  return a;
}

const closedAt = (c) => Math.min(Date.parse(c.completedAt || '') || Infinity, Date.parse(c.canceledAt || '') || Infinity);
const isParked = (c) => /^\s*PARKED\s*:/.test(c.description || '');
// Twin-serves rule (linear-issue-create.js twinServes) cannot be replayed: a
// card's state at an earlier moment is not recorded, so any open card counts.

/**
 * PURE. Replay `windowCards` (created in the window) in creation order.
 * `history` = every card that could have been open (window + older open ones).
 */
function replayFilings({ windowCards, history, allFilers = false }) {
  const all = history.map((c) => ({ ...c, at: Date.parse(c.createdAt), end: closedAt(c) }));
  const filed = [];
  const out = { total: windowCards.length, nearDup: [], refused: [], rolledUp: [] };
  for (const c of [...windowCards].sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt))) {
    const at = Date.parse(c.createdAt);
    const source = d.inferCardSource(c);
    const contract = d.hasPerCardContract(c.description) || source === 'digest-autofix' || source === 'alert-router';
    const eligible = source !== 'e2e-canary' && source !== 'rollup' && (allFilers || !contract);
    // As shipped: a parked repeat is noted on the open card; a --dispatch
    // repeat (a session's card) is refused with "already open".
    if (eligible) {
      const openThen = all.filter((o) => o.identifier !== c.identifier && o.at < at && o.end > at);
      const m = d.findNearDuplicate(c.title, openThen);
      if (m && (allFilers || isParked(c))) { out.nearDup.push({ card: c, match: m.card, score: m.score }); continue; }
      if (m) { out.refused.push({ card: c, match: m.card, score: m.score }); continue; }
    }
    if (allFilers && eligible && isParked(c) && source !== 'session' && source !== 'unknown') {
      const kind = d.titleKind(c.title);
      const recent = filed.filter((f) => at - Date.parse(f.createdAt) <= d.FLOOD_WINDOW_MS);
      if (d.countSameKind({ source, kind, recent, nowMs: at }) >= d.FLOOD_THRESHOLD) { out.rolledUp.push({ card: c, source, kind }); continue; }
    }
    filed.push(c);
  }
  return out;
}

// Same exclusions as the front door: filers that key state on their own card.
const hasContract = (c) => d.hasPerCardContract(c.description)
  || ['digest-autofix', 'alert-router', 'e2e-canary'].includes(d.inferCardSource(c));

/** PURE. Near-duplicate groups among open cards: each newer card -> oldest match. */
function openDuplicateGroups(openCards) {
  const sorted = [...openCards].sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
  const pairs = [];
  const canonicalOf = new Map();
  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i];
    if (hasContract(c) || String(c.title).startsWith(d.ROLLUP_TITLE_PREFIX)) continue;
    const m = d.findNearDuplicate(c.title, sorted.slice(0, i).filter((o) => !canonicalOf.has(o.identifier) && !hasContract(o)));
    if (m) { canonicalOf.set(c.identifier, m.card.identifier); pairs.push({ card: c, keep: m.card, score: m.score }); }
  }
  return pairs;
}

const FIELDS = 'identifier title description createdAt completedAt canceledAt state { name type }';
async function walk(graphql, filter) {
  const q = `query($f: IssueFilter, $after: String) { issues(first: 100, after: $after, includeArchived: true, filter: $f) { pageInfo { hasNextPage endCursor } nodes { ${FIELDS} } } }`;
  const out = [];
  let after = null;
  for (let p = 0; p < 50; p++) {
    const data = await graphql(q, { f: filter, after });
    out.push(...data.issues.nodes);
    if (!data.issues.pageInfo.hasNextPage) return out;
    after = data.issues.pageInfo.endCursor;
  }
  throw new Error('more than 5000 cards; refusing a partial answer');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.replayDays && !args.open) {
    console.error('Usage: linear-dedupe-sweep.js --replay-days=7 | --open [--apply]');
    process.exit(1);
  }
  const { graphql, TEAM_KEY } = require('./lib/linear-client.js');
  const team = { key: { eq: TEAM_KEY } };
  const openCards = await walk(graphql, { team, state: { type: { nin: ['completed', 'canceled', 'duplicate'] } } });

  if (args.replayDays) {
    const since = new Date(Date.now() - args.replayDays * DAY).toISOString();
    // History reaches back 30 days so a card open at the window's start but closed since is still a candidate.
    const history = await walk(graphql, { team, createdAt: { gte: new Date(Date.now() - (args.replayDays + 30) * DAY).toISOString() } });
    const byId = new Map([...history, ...openCards].map((c) => [c.identifier, c]));
    const windowCards = history.filter((c) => c.createdAt >= since);
    const shipped = replayFilings({ windowCards, history: [...byId.values()] });
    const upper = replayFilings({ windowCards, history: [...byId.values()], allFilers: true });
    console.log(`Replay of ${windowCards.length} cards created in the last ${args.replayDays} days:`);
    console.log(`  as shipped:  ${shipped.nearDup.length} parked repeats noted on an open card + ${shipped.refused.length} --dispatch repeats refused as already open = ${shipped.nearDup.length + shipped.refused.length} fewer cards`);
    console.log(`  all filers:  ${upper.nearDup.length} near-duplicates + ${upper.rolledUp.length} rolled up = ${upper.nearDup.length + upper.rolledUp.length} fewer cards`);
    for (const r of shipped.refused) console.log(`    refused ${r.score.toFixed(2)} ${r.card.identifier} "${r.card.title.slice(0, 70)}" -> ${r.match.identifier} "${r.match.title.slice(0, 50)}"`);
    for (const r of shipped.nearDup) console.log(`    ${r.score.toFixed(2)} ${r.card.identifier} "${r.card.title.slice(0, 70)}" -> ${r.match.identifier}`);
    const kinds = {};
    for (const r of upper.rolledUp) kinds[`${r.source} "${r.kind}"`] = (kinds[`${r.source} "${r.kind}"`] || 0) + 1;
    for (const [k, n] of Object.entries(kinds)) console.log(`    rollup ${k}: ${n}`);
  }

  if (args.open) {
    const pairs = openDuplicateGroups(openCards);
    // Backlog only: a Todo copy may already be queued for a worker.
    const movable = pairs.filter((p) => (p.card.state && p.card.state.type) === 'backlog');
    console.log(`Open cards: ${openCards.length}. Near-duplicate copies: ${pairs.length} (${movable.length} in Backlog).`);
    for (const p of pairs) console.log(`  ${p.score.toFixed(2)} ${p.card.identifier} [${p.card.state.name}] "${p.card.title.slice(0, 70)}" -> keep ${p.keep.identifier}`);
    if (args.apply) {
      let done = 0;
      for (const p of movable) {
        const r = spawnSync('node', [path.join(__dirname, 'linear-brain.js'), 'update', p.card.identifier, '--state', 'Duplicate',
          '--duplicate-of', p.keep.identifier, '--comment', `Same work as ${p.keep.identifier} ("${p.keep.title}"); merged by the BRO-5488 one-time duplicate sweep (title match ${p.score.toFixed(2)}). Continue on ${p.keep.identifier}.`],
        { encoding: 'utf8', timeout: 60_000 });
        if (r.status === 0) done++;
        else console.error(`  ! ${p.card.identifier}: ${(r.stderr || '').trim().split('\n').pop()}`);
      }
      console.log(`Marked ${done} of ${movable.length} as Duplicate.`);
    }
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(2); });
}

module.exports = { replayFilings, openDuplicateGroups, parseArgs };
