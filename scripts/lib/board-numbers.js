'use strict';

/**
 * board-numbers.js (BRO-5482): the "Board numbers" block of the morning digest.
 *
 * Owner ask 2026-10-16: "each morning in my digest I'd love to see the full numbers for the
 * system. Number of cards at each level, how many added in last 24 hours and last 7 days, how
 * many completed, how many stuck, how many waiting on me, how many by codex."
 *
 * Pure builder + renderer; the Linear/git reads live in fetchBoardNumbersData below and are
 * injected, so the node --test file needs no network.
 *
 * ONE DEFINITION RULE: `waiting` and `stuck` are NOT counted here. The digest passes in the
 * numbers its own sections already use (buildOwnerView().decisions, countStuckSignals), so this
 * block can never disagree with them.
 *
 * ARCHIVED CARDS: created/completed counts come from fetchInflowCounts (includeArchived:true).
 * Without it archived cards silently drop out (measured 2026-09-07: 41 of 101 closures hidden).
 * The open count deliberately excludes archived cards.
 */

const { execFileSync } = require('child_process');
const { TERMINAL_STATE_TYPES } = require('./linear-state-types.js');
const { fetchInflowCounts } = require('./backlog-inflow-ratio.js');
const { landedPerLane } = require('./codex-runner.js');
const { isAutofixFiledIssue } = require('./autofix-filed-marker.js');
const { isAwaitingOwner } = require('./owner-approval-channel.js');

const TEAM_KEY = 'BRO';
const PRIORITY_LABELS = [[1, 'Urgent'], [2, 'High'], [3, 'Medium'], [4, 'Low'], [0, 'No priority']];
const OPEN_PRIORITY_QUERY = `query OpenByPriority($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: 250, after: $after, includeArchived: false) {
    pageInfo { hasNextPage endCursor }
    nodes { priority }
  }
}`;
const MAX_PAGES = 20;
const STUCK_AFTER_MS = 48 * 3600 * 1000;
const STUCK_QUERY = `query StuckCards($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: 250, after: $after, includeArchived: false) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier title description state { name } labels { nodes { name } } }
  }
}`;
const GRAPHQL_OPTS = { maxAttempts: 2, timeoutMs: 6_000, baseMs: 250 };

/** Open cards per priority. Priority 0 (or anything unknown) counts as "No priority". */
async function fetchOpenByPriority({ graphql, teamKey = TEAM_KEY, graphqlOpts = GRAPHQL_OPTS } = {}) {
  const filter = { team: { key: { eq: teamKey } }, state: { type: { nin: TERMINAL_STATE_TYPES } } };
  const byPriority = { 1: 0, 2: 0, 3: 0, 4: 0, 0: 0 };
  let total = 0;
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(OPEN_PRIORITY_QUERY, { filter, after }, graphqlOpts);
    const conn = data && data.issues;
    if (!conn || !Array.isArray(conn.nodes)) throw new Error('Linear returned no issues connection for the open-by-priority count');
    for (const n of conn.nodes) {
      const p = [1, 2, 3, 4].includes(Number(n.priority)) ? Number(n.priority) : 0;
      byPriority[p] += 1;
      total += 1;
    }
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) return { total, byPriority, truncated: false };
    after = conn.pageInfo.endCursor;
  }
  return { total, byPriority, truncated: true };
}

/**
 * Stuck CARDS: open cards In Progress or In Review with no update for 48h+. The 48h rule alone;
 * the picker's paused-repeatedly history (cloud-worker-pick.js historySkipReason) needs every
 * card's comments, which is too many reads for a digest.
 */
async function fetchStuckCards({ graphql, now = new Date(), teamKey = TEAM_KEY, graphqlOpts = GRAPHQL_OPTS } = {}) {
  const filter = {
    team: { key: { eq: teamKey } },
    state: { type: { eq: 'started' } }, // exactly In Progress and In Review on this team; survives a rename
    updatedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS).toISOString() },
  };
  let count = 0;
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(STUCK_QUERY, { filter, after }, graphqlOpts);
    const conn = data && data.issues;
    if (!conn || !Array.isArray(conn.nodes)) throw new Error('Linear returned no issues connection for the stuck-card count');
    // Same exclusions as the digest's other sections: pipeline-owned cards (autofix/canary) are
    // not stuck work, and owner-waiting cards are already counted under "Waiting on you".
    count += conn.nodes.filter((n) => !isAutofixFiledIssue(n) && !isAwaitingOwner(n)).length;
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) return { count, truncated: false };
    after = conn.pageInfo.endCursor;
  }
  return { count, truncated: true };
}

/**
 * Codex vs Claude cards landed on main in the last 24h and 7 days, from ONE git log (the
 * history fetch is the slow part: ~12k commits/week, mostly bots). -> { d1, d7 } or null.
 */
function readLanded({ cwd = process.cwd(), exec = execFileSync, nowMs = Date.now() } = {}) {
  const run = (args, timeout = 30_000) => exec('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout, maxBuffer: 64 * 1024 * 1024 });
  // CI checks out depth 1; deepen to 7 days without blobs. Only when shallow: --shallow-since
  // on a full clone would truncate its history. Fail-soft.
  // A shallow clone whose deepen failed would undercount silently, so that reads as n/a (null).
  try {
    if (String(run(['rev-parse', '--is-shallow-repository'])).trim() === 'true') {
      run(['fetch', '--quiet', '--filter=blob:none', '--shallow-since=8.days.ago', 'origin', 'main'], 120_000);
    }
  } catch (err) {
    try { if (String(run(['rev-parse', '--is-shallow-repository'])).trim() === 'true') return null; } catch { return null; }
  }
  for (const ref of ['origin/main', 'HEAD']) {
    try {
      const lines = run(['log', ref, '--since=7.days', '--format=%ct%x09%an%x09%s']).split('\n').filter(Boolean);
      const dayAgo = nowMs / 1000 - 86400;
      const strip = (l) => l.slice(l.indexOf('\t') + 1);
      return {
        d7: landedPerLane(lines.map(strip).join('\n')),
        d1: landedPerLane(lines.filter((l) => Number(l.slice(0, l.indexOf('\t'))) >= dayAgo).map(strip).join('\n')),
      };
    } catch { /* next ref */ }
  }
  return null;
}

/** Every live read, each fail-soft on its own: a missing piece renders "n/a", never blocks the digest. */
async function fetchBoardNumbersData({ graphql, now = new Date(), cwd, readLandedFn = readLanded, fetchInflow = fetchInflowCounts, fetchOpen = fetchOpenByPriority, fetchStuck = fetchStuckCards } = {}) {
  const soft = async (fn) => { try { return await fn(); } catch (err) { return { error: String(err && err.message || err).slice(0, 120) }; } };
  // Sequential on purpose: backlog-inflow-ratio.js walks one at a time because of Linear rate limits.
  const open = await soft(() => fetchOpen({ graphql }));
  const d1 = await soft(() => fetchInflow({ graphql, now, windowDays: 1 }));
  const d7 = await soft(() => fetchInflow({ graphql, now, windowDays: 7 }));
  const stuckCards = await soft(() => fetchStuck({ graphql, now }));
  let landed = null;
  try { landed = readLandedFn({ cwd, nowMs: now.getTime() }); } catch { /* n/a */ }
  return {
    open,
    d1,
    d7,
    stuckCards,
    landed1: landed ? landed.d1 : null,
    landed7: landed ? landed.d7 : null,
  };
}

const num = (v) => (Number.isFinite(v) ? v : null);

/**
 * -> { open: {total, rows:[{label,count}]}|null, added:{d1,d7}, completed:{d1,d7}, canceled:{d1,d7}, waiting, stuck,
 *      technicalInReview, lanes:{d1:{codex,claude}|null, d7:...}, floors:boolean }
 * Any count that could not be read is null (rendered "n/a"); counts from a truncated walk are floors.
 */
function buildBoardNumbers({ data = {}, waiting = null, stuck = null, technicalInReview = null } = {}) {
  const ok = (x) => x && !x.error;
  const open = ok(data.open)
    ? { total: data.open.total, rows: PRIORITY_LABELS.map(([p, label]) => ({ label, count: data.open.byPriority[p] || 0 })) }
    : null;
  const pick = (w, k) => (ok(w) ? num(w[k]) : null);
  // fetchInflowCounts also walks an open count we never use; only truncation of the counts we show matters.
  const shownTrunc = (w) => ok(w) && (w.truncatedCounts || []).some((n) => n !== 'open');
  const floors = !!((ok(data.open) && !!data.open.truncated) || shownTrunc(data.d1) || shownTrunc(data.d7) || (ok(data.stuckCards) && data.stuckCards.truncated));
  return {
    open,
    added: { d1: pick(data.d1, 'created'), d7: pick(data.d7, 'created') },
    completed: { d1: pick(data.d1, 'completed'), d7: pick(data.d7, 'completed') },
    canceled: { d1: pick(data.d1, 'canceled'), d7: pick(data.d7, 'canceled') },
    waiting: num(waiting),
    stuck: num(stuck),
    stuckCards: ok(data.stuckCards) ? num(data.stuckCards.count) : null,
    stuckCardsFloor: ok(data.stuckCards) && !!data.stuckCards.truncated,
    technicalInReview: num(technicalInReview),
    lanes: { d1: data.landed1 || null, d7: data.landed7 || null },
    floors,
  };
}

const show = (v) => (v === null || v === undefined ? 'n/a' : String(v));

/** Plain-text lines (also what gets pasted into the card Outcome). */
function renderBoardNumbersLines(m) {
  const lines = [];
  lines.push(m.open
    ? `Open cards: ${m.open.total} (${m.open.rows.map((r) => `${r.count} ${r.label}`).join(', ')})`
    : 'Open cards: n/a');
  lines.push(`Added: ${show(m.added.d1)} in 24h, ${show(m.added.d7)} in 7 days`);
  lines.push(`Completed: ${show(m.completed.d1)} in 24h, ${show(m.completed.d7)} in 7 days`);
  lines.push(`Canceled: ${show(m.canceled.d1)} in 24h, ${show(m.canceled.d7)} in 7 days`);
  lines.push(`Waiting on you: ${show(m.waiting)}`);
  lines.push(`Stuck cards: ${show(m.stuckCards)}${m.stuckCards === null ? '' : ' (In Progress or In Review, no update in 48h+, not waiting on you)'}`);
  lines.push(`Stuck alerts: ${show(m.stuck)}${m.technicalInReview ? ` (plus ${m.technicalInReview} technical cards parked In Review)` : ''}`);
  const lane = (l) => (l ? `Codex ${l.codex}, Claude ${l.claude}` : 'n/a');
  lines.push(`Landed on main, 24h: ${lane(m.lanes.d1)}`);
  lines.push(`Landed on main, 7 days: ${lane(m.lanes.d7)}`);
  if (m.floors) lines.push('Some counts hit the page limit and are minimums.');
  return lines;
}

function renderBoardNumbersHtml(m, esc = (s) => String(s)) {
  const rows = renderBoardNumbersLines(m).map((l) => {
    const i = l.indexOf(': ');
    return i < 0
      ? `<tr><td colspan="2" style="padding:2px 0;color:#666;">${esc(l)}</td></tr>`
      : `<tr><td style="padding:2px 12px 2px 0;color:#555;white-space:nowrap;vertical-align:top;">${esc(l.slice(0, i))}</td><td style="padding:2px 0;">${esc(l.slice(i + 2))}</td></tr>`;
  });
  return `<div style="margin:0 0 14px;"><p style="font-size:13px;font-weight:700;margin:0 0 4px;">Board numbers</p><table style="font-size:12px;border-collapse:collapse;">${rows.join('')}</table></div>`;
}

module.exports = {
  fetchOpenByPriority, fetchStuckCards, readLanded, fetchBoardNumbersData, buildBoardNumbers, renderBoardNumbersLines, renderBoardNumbersHtml, PRIORITY_LABELS,
};
