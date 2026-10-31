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
 * ARCHIVED CARDS: created/completed counts include archived issues.
 * Without it archived cards silently drop out (measured 2026-09-07: 41 of 101 closures hidden).
 * The open count deliberately excludes archived cards.
 */

const { execFileSync } = require('child_process');
const { TERMINAL_STATE_TYPES } = require('./linear-state-types.js');
const { windowStart } = require('./backlog-inflow-ratio.js');
const { landedPerLane, LANDED_LOG_FORMAT } = require('./codex-runner.js');
const { isAutofixFiledIssue } = require('./autofix-filed-marker.js');
const { isAwaitingOwner } = require('./owner-approval-channel.js');
const cardDedupe = require('./card-dedupe.js');
const { countRecentLinearOpusLaunches } = require('./bsc-next-model.js');
const { fetchOpusClaimEntries, withCloudOpusClaims } = require('./cloud-worker-pick.js');
const { readDispatchLedgers, PRIMARY_LEDGER } = require('./board-targeting-sources.js');
const sessionCost = require('./claude-session-cost.js');

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
 * Parked cards (BRO-5626): open Backlog cards with a PARKED line. The cloud picker never takes
 * them, and the daily unpark drain (scripts/linear-unpark-drain.js) moves only the takeable ones
 * with a safe VERIFY, so what is left waits on a real block or on someone writing a VERIFY.
 * Owner-waiting cards are left out: "Waiting on you" counts them.
 */
async function fetchParkedCards({ graphql, teamKey = TEAM_KEY, graphqlOpts = GRAPHQL_OPTS } = {}) {
  const { PARKED_SENTINEL_RE, isAutomationParked } = require('./headless-dispatchability.js');
  const { hasPersonParkHold } = require('./cloud-worker-pick.js');
  // Owner holds count as waiting on you and machine parks age into the picker, so neither is "never picked".
  const neverPicked = (n) => {
    const desc = n.description || '';
    return PARKED_SENTINEL_RE.test(desc) && !isAwaitingOwner(n) && !isAutomationParked(desc) && !hasPersonParkHold(desc);
  };
  const filter = { team: { key: { eq: teamKey } }, state: { type: { eq: 'backlog' } }, description: { contains: 'PARKED' } };
  let count = 0;
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(STUCK_QUERY, { filter, after }, graphqlOpts);
    const conn = data && data.issues;
    if (!conn || !Array.isArray(conn.nodes)) throw new Error('Linear returned no issues connection for the parked-card count');
    count += conn.nodes.filter(neverPicked).length;
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) return { count, truncated: false };
    after = conn.pageInfo.endCursor;
  }
  return { count, truncated: true };
}

const RECENT_QUERY = `query RecentCards($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: 100, after: $after, includeArchived: true) {
    pageInfo { hasNextPage endCursor }
    nodes { title description createdAt completedAt canceledAt state { name } }
  }
}`;

// Keep this narrow: a repair ABOUT a routine is work, not the routine's daily log.
function ceremonyKind(card, nowMs) {
  const title = String(card.title || '').trim();
  if (/^\[E2E Canary\]/i.test(title)) return 'canary';
  // BRO-6338: sessions' own end-to-end test cards ("TEST (BRO-6235): ... safe to ignore") close themselves.
  if (/^TEST \(BRO-\d+\):.*\bsafe to ignore\b/i.test(title)) return 'canary';
  // BRO-6130: a card closed as a Duplicate of another is the same work counted twice.
  if (String(card.state && card.state.name || '').trim().toLowerCase() === 'duplicate') return 'duplicate';
  if (/^Opening-night (?:watch|audit) \d{4}-\d{2}-\d{2}$/i.test(title)
    || /^CANARY: touch\b/i.test(title)
    || /^Week in Review(?:\s*[,\u2014:-]\s*|\s+)\d{4}-\d{2}-\d{2}(?: to \d{4}-\d{2}-\d{2})?$/i.test(title)) return 'routineLog';
  const created = Date.parse(card.createdAt);
  const closed = Date.parse(card.completedAt || card.canceledAt);
  // A quick automated repair or an unmarked card is still real work. Only
  // explicitly session-filed cards qualify; never guess from updatedAt.
  if (cardDedupe.inferCardSource(card) === 'session' && closed <= nowMs
    && closed >= created && closed - created <= 6 * 3600_000) return 'sessionTracking';
  return null;
}

/** Digest-only counts: other inflow-ratio callers still measure the whole board. */
function summarizeBoardFlow(cards, { now = new Date(), windowDays = 7 } = {}) {
  const since = windowStart(now, windowDays);
  const startMs = Date.parse(since);
  const nowMs = now.getTime();
  const empty = () => ({ canary: 0, routineLog: 0, sessionTracking: 0, duplicate: 0 });
  const result = { created: 0, completed: 0, canceled: 0, excluded: { created: empty(), completed: empty() }, windowDays, since };
  for (const card of cards || []) {
    const kind = ceremonyKind(card, nowMs);
    for (const [key, field] of [['created', 'createdAt'], ['completed', 'completedAt'], ['canceled', 'canceledAt']]) {
      const ts = Date.parse(card[field]);
      if (!(ts >= startMs && ts <= nowMs)) continue;
      if (kind && key !== 'canceled') result.excluded[key][kind]++;
      else result[key]++;
    }
  }
  return result;
}

const BOARD_FLOW_QUERY = `query BoardFlow($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: 250, after: $after, includeArchived: true) {
    pageInfo { hasNextPage endCursor }
    nodes { title description createdAt completedAt canceledAt state { name } }
  }
}`;

/** One paginated walk per window, including old cards completed in the window. */
async function fetchBoardInflowCounts({ graphql, now = new Date(), windowDays = 7, teamKey = TEAM_KEY, maxPages = MAX_PAGES, graphqlOpts = GRAPHQL_OPTS } = {}) {
  const since = windowStart(now, windowDays);
  const filter = {
    team: { key: { eq: teamKey } },
    or: ['createdAt', 'completedAt', 'canceledAt'].map((field) => ({ [field]: { gte: since } })),
  };
  const cards = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await graphql(BOARD_FLOW_QUERY, { filter, after }, graphqlOpts);
    const conn = data && data.issues;
    if (!conn || !Array.isArray(conn.nodes)) throw new Error('Linear returned no issues connection for the board flow');
    cards.push(...conn.nodes);
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) return { ...summarizeBoardFlow(cards, { now, windowDays }), truncated: false, truncatedCounts: [] };
    after = conn.pageInfo.endCursor;
  }
  return { ...summarizeBoardFlow(cards, { now, windowDays }), truncated: true, truncatedCounts: ['created', 'completed', 'canceled'] };
}

/**
 * PURE. Cards added in the window, per filer (the "Filed by:" footer the front door
 * stamps since BRO-5488, else card-dedupe's title/body rules), plus floods: one
 * filer's FLOOD_THRESHOLD+ cards of one kind. -> { total, bySource:[{source,count}], floods:[{source,kind,count}] }
 */
function summarizeInflowBySource(cards, { now = new Date() } = {}) {
  const bySource = new Map();
  const byKind = new Map();
  let total = 0;
  for (const c of cards || []) {
    if (ceremonyKind(c, now.getTime())) continue;
    total++;
    const footer = cardDedupe.parseSourceFooter(c.description);
    const source = footer ? footer.source : cardDedupe.inferCardSource(c);
    bySource.set(source, (bySource.get(source) || 0) + 1);
    if (source === 'rollup') continue;
    const kind = footer && footer.kind ? footer.kind : cardDedupe.titleKind(c.title);
    const key = `${source}\u0000${kind}`;
    byKind.set(key, (byKind.get(key) || 0) + 1);
  }
  const desc = (a, b) => b.count - a.count || String(a.source).localeCompare(String(b.source));
  return {
    total,
    bySource: [...bySource].map(([source, count]) => ({ source, count })).sort(desc),
    floods: [...byKind].filter(([, n]) => n >= cardDedupe.FLOOD_THRESHOLD)
      .map(([k, count]) => { const [source, kind] = k.split('\u0000'); return { source, kind, count }; }).sort(desc),
  };
}

/** Cards created in the last 24h (archived included), summarized by filer. */
async function fetchInflowBySource({ graphql, now = new Date(), teamKey = TEAM_KEY, graphqlOpts = GRAPHQL_OPTS } = {}) {
  const filter = { team: { key: { eq: teamKey } }, createdAt: { gte: new Date(now.getTime() - 24 * 3600 * 1000).toISOString() } };
  const cards = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(RECENT_QUERY, { filter, after }, graphqlOpts);
    const conn = data && data.issues;
    if (!conn || !Array.isArray(conn.nodes)) throw new Error('Linear returned no issues connection for the inflow-by-source read');
    cards.push(...conn.nodes);
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) return { ...summarizeInflowBySource(cards, { now }), truncated: false };
    after = conn.pageInfo.endCursor;
  }
  return { ...summarizeInflowBySource(cards, { now }), truncated: true };
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
      const lines = run(['log', ref, '--since=7.days', `--format=%ct%x09${LANDED_LOG_FORMAT}`]).split('\n').filter(Boolean);
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

/** Same ledger + deduplicated cloud claims and counter as pickLinearModel (BRO-5770).
 * Also the count the daily Opus budget spends against (BRO-6684, opus-budget.js). Missing either source is unknown, not zero.
 */
async function fetchOpusUsage({ now = new Date(), readLedger = readDispatchLedgers, fetchClaims = fetchOpusClaimEntries } = {}) {
  // Use the canonical Mac ledger path, as the dispatcher does, even from a digest worktree.
  const ledger = readLedger({ files: [PRIMARY_LEDGER] });
  if (!ledger.sources.some((s) => s.file === PRIMARY_LEDGER && s.present)) {
    throw new Error(`could not read ${PRIMARY_LEDGER}`);
  }
  const nowMs = now.getTime();
  const claims = await fetchClaims(nowMs);
  if (!Array.isArray(claims)) throw new Error('could not read cloud Opus claims');
  return {
    count: countRecentLinearOpusLaunches(withCloudOpusClaims(ledger.rows, claims), nowMs),
  };
}

const CODEX_RUNNER_CARD = process.env.CODEX_RUNNER_CARD || 'BRO-4745';
const RUNNER_COMMENTS_QUERY = `query RunnerComments($id: String!, $since: DateTimeOrDuration!, $after: String) {
  issue(id: $id) { comments(first: 100, after: $after, filter: { createdAt: { gte: $since } }) { pageInfo { hasNextPage endCursor } nodes { body createdAt } } }
}`;

/**
 * BRO-5671: 7-day Claude spend from data/audit/claude-session-cost.jsonl (written by cloud sessions
 * via record-claude-session-cost.js) and the Codex lane's Claude-check spend from the runner card's
 * run summaries. Each half fails soft to null on its own. -> { claude, codex, days }
 */
async function fetchClaudeCost({ graphql, now = new Date(), cwd, days = 7, readLedger = sessionCost.readLedger, graphqlOpts = GRAPHQL_OPTS } = {}) {
  const nowMs = now.getTime();
  let claude = null;
  try {
    // A missing ledger is "nothing recorded" (no session has written a row yet), not unknown.
    const { rows } = readLedger({ file: sessionCost.ledgerPath(cwd) });
    claude = sessionCost.summarizeCost(rows, { nowMs, days });
  } catch { /* n/a */ }
  let codex = null;
  try {
    const since = new Date(nowMs - days * 86400 * 1000).toISOString();
    const nodes = [];
    let after = null;
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await graphql(RUNNER_COMMENTS_QUERY, { id: CODEX_RUNNER_CARD, since, after }, graphqlOpts);
      const conn = data && data.issue && data.issue.comments;
      if (!conn || !Array.isArray(conn.nodes)) break;
      nodes.push(...conn.nodes);
      if (!conn.pageInfo || !conn.pageInfo.hasNextPage) { complete = true; break; }
      after = conn.pageInfo.endCursor;
    }
    // A partial walk would understate spend and per-card cost: unknown, not a smaller number.
    if (complete) codex = sessionCost.summarizeCodexCheck(nodes, { nowMs, days });
  } catch { /* n/a */ }
  return { claude, codex, days };
}

/** Every live read, each fail-soft on its own: a missing piece renders "n/a", never blocks the digest. */
async function fetchBoardNumbersData({ graphql, now = new Date(), cwd, readLandedFn = readLanded, fetchInflow = fetchBoardInflowCounts, fetchOpen = fetchOpenByPriority, fetchStuck = fetchStuckCards, fetchBySource = fetchInflowBySource, fetchParked = fetchParkedCards, fetchOpus = fetchOpusUsage, fetchCost = fetchClaudeCost, fetchDaily = require('./board-summary.js').fetchDailyFlow } = {}) {
  const soft = async (fn) => { try { return await fn(); } catch (err) { return { error: String(err && err.message || err).slice(0, 120) }; } };
  // Sequential on purpose because of Linear rate limits.
  const open = await soft(() => fetchOpen({ graphql }));
  const d1 = await soft(() => fetchInflow({ graphql, now, windowDays: 1 }));
  const d7 = await soft(() => fetchInflow({ graphql, now, windowDays: 7 }));
  const stuckCards = await soft(() => fetchStuck({ graphql, now }));
  const bySource = await soft(() => fetchBySource({ graphql, now }));
  const parked = await soft(() => fetchParked({ graphql }));
  const opus = await soft(() => fetchOpus({ now }));
  const cost = await soft(() => fetchCost({ graphql, now, cwd }));
  const daily = await soft(() => fetchDaily({ graphql, now }));
  let landed = null;
  try { landed = readLandedFn({ cwd, nowMs: now.getTime() }); } catch { /* n/a */ }
  return {
    open,
    d1,
    d7,
    stuckCards,
    bySource,
    parked,
    opus,
    cost,
    daily,
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
  // Only truncation of the counts we show matters.
  const shownTrunc = (w) => ok(w) && (w.truncatedCounts || []).some((n) => n !== 'open');
  const floors = !!((ok(data.open) && !!data.open.truncated) || shownTrunc(data.d1) || shownTrunc(data.d7) || (ok(data.stuckCards) && data.stuckCards.truncated) || (ok(data.parked) && data.parked.truncated));
  return {
    open,
    added: { d1: pick(data.d1, 'created'), d7: pick(data.d7, 'created') },
    completed: { d1: pick(data.d1, 'completed'), d7: pick(data.d7, 'completed') },
    canceled: { d1: pick(data.d1, 'canceled'), d7: pick(data.d7, 'canceled') },
    excluded: {
      added: { d1: ok(data.d1) ? data.d1.excluded?.created : null, d7: ok(data.d7) ? data.d7.excluded?.created : null },
      completed: { d1: ok(data.d1) ? data.d1.excluded?.completed : null, d7: ok(data.d7) ? data.d7.excluded?.completed : null },
    },
    waiting: num(waiting),
    stuck: num(stuck),
    stuckCards: ok(data.stuckCards) ? num(data.stuckCards.count) : null,
    stuckCardsFloor: ok(data.stuckCards) && !!data.stuckCards.truncated,
    technicalInReview: num(technicalInReview),
    parked: ok(data.parked) ? num(data.parked.count) : null,
    bySource: ok(data.bySource) ? data.bySource : null,
    opus: { count: pick(data.opus, 'count') },
    lanes: { d1: data.landed1 || null, d7: data.landed7 || null },
    cost: ok(data.cost) ? data.cost : null,
    // BRO-6081: per-day added/closed for the owner summary chart (board-summary.js).
    daily: ok(data.daily) && Array.isArray(data.daily.days) ? data.daily.days : null,
    dailyTruncated: ok(data.daily) && !!data.daily.truncated,
    floors,
  };
}

/**
 * BRO-6338. PURE. When cards were added faster than they were closed on each of the last
 * two complete days, one line naming the top filing source of the last 24h. null otherwise.
 * Daily counts cover every card (session self-tracking included); the source split excludes
 * test alarms, routine logs and self-tracking, so the line says which is which.
 */
function filingOutpacesClosingLine(m) {
  // A truncated page makes the daily counts minimums, so the comparison can't be trusted.
  const days = m && Array.isArray(m.daily) && !m.dailyTruncated ? m.daily.slice(-2) : [];
  if (days.length < 2 || !days.every((d) => d.added > d.closed)) return null;
  const top = m.bySource && Array.isArray(m.bySource.bySource) ? m.bySource.bySource[0] : null;
  const added = days.reduce((a, d) => a + d.added, 0);
  const closed = days.reduce((a, d) => a + d.closed, 0);
  const total = m.bySource && Number.isFinite(m.bySource.total) ? m.bySource.total : null;
  const who = top ? ` Top filer in 24h: ${top.source}, ${top.count}${total ? ` of ${total}` : ''} (not counting test alarms, routine logs and self-tracking).` : '';
  const flood = m.bySource && m.bySource.floods && m.bySource.floods[0]
    ? ` Biggest flood: ${m.bySource.floods[0].source} "${m.bySource.floods[0].kind}" ${m.bySource.floods[0].count}.` : '';
  return `Filing is outpacing closing for 2 days: ${added} added, ${closed} closed (all cards, canceled counted as closed).${who}${flood}`;
}

const FLOOD_LABEL = `${cardDedupe.FLOOD_THRESHOLD}+ cards of one kind from one filer in 24h`;
const show = (v) => (v === null || v === undefined ? 'n/a' : String(v));

/** Plain-text lines (also what gets pasted into the card Outcome). */
function renderBoardNumbersLines(m) {
  const lines = [];
  const flowLine = (label, counts) => `${label}: ${show(counts.d1)} in 24h (7-day average ${counts.d7 === null ? 'n/a' : (counts.d7 / 7).toFixed(1)}/day), ${show(counts.d7)} in 7 days`;
  const exclusions = (label, counts) => {
    for (const [key, name] of [['canary', 'test alarms'], ['routineLog', 'routine logs'], ['sessionTracking', 'session self-tracking (closed within 6h)'], ['duplicate', 'duplicates']]) {
      lines.push(`${label} ${name}: ${show(counts.d1?.[key])} in 24h, ${show(counts.d7?.[key])} in 7 days`);
    }
  };
  lines.push(m.open
    ? `Open cards: ${m.open.total} (${m.open.rows.map((r) => `${r.count} ${r.label}`).join(', ')})`
    : 'Open cards: n/a');
  lines.push('Added and Completed exclude the test alarms, routine logs, session self-tracking and duplicates reported separately below.');
  lines.push(flowLine('Added', m.added));
  exclusions('Added', m.excluded.added);
  if (m.bySource && m.bySource.bySource) {
    lines.push(`Added in 24h by source: ${m.bySource.bySource.map((r) => `${r.source} ${r.count}`).join(', ') || 'none'}`);
    if (m.bySource.floods.length) {
      lines.push(`Floods (${FLOOD_LABEL}): ${m.bySource.floods.slice(0, 5).map((f) => `${f.source} "${f.kind}" ${f.count}`).join('; ')}`);
    }
  }
  const outpacing = filingOutpacesClosingLine(m);
  if (outpacing) lines.push(outpacing);
  lines.push(flowLine('Completed', m.completed));
  exclusions('Completed', m.excluded.completed);
  lines.push(`Canceled: ${show(m.canceled.d1)} in 24h, ${show(m.canceled.d7)} in 7 days`);
  lines.push(`Parked, never picked: ${show(m.parked)}${m.parked === null ? '' : ' (Backlog cards with a PARKED line)'}`);
  lines.push(`Waiting on you: ${show(m.waiting)}`);
  lines.push(`Stuck cards: ${show(m.stuckCards)}${m.stuckCards === null ? '' : ' (In Progress or In Review, no update in 48h+, not waiting on you)'}`);
  lines.push(`Stuck alerts: ${show(m.stuck)}${m.technicalInReview ? ` (plus ${m.technicalInReview} technical cards parked In Review)` : ''}`);
  const lane = (l) => (l ? `Codex ${l.codex}, Claude ${l.claude}` : 'n/a');
  lines.push(`Landed on main, 24h: ${lane(m.lanes.d1)}`);
  lines.push(`Landed on main, 7 days: ${lane(m.lanes.d7)}`);
  lines.push(`Opus in last 24h: ${show(m.opus.count)} (no cap)`);
  lines.push(m.cost ? sessionCost.renderCostLine(m.cost) : 'Claude cost, 7 days: n/a');
  if (m.floors) lines.push('Some counts hit the page limit and are minimums.');
  return lines;
}

function renderBoardNumbersHtml(m, esc = (s) => String(s)) {
  const rows = renderBoardNumbersLines(m).map((l) => {
    const i = l.indexOf(': ');
    return i < 0
      ? `<tr><td colspan="2" style="padding:2px 0;color:#666;">${esc(l)}</td></tr>`
      : `<tr><td style="width:34%;padding:2px 10px 2px 0;color:#555;vertical-align:top;word-wrap:break-word;">${esc(l.slice(0, i))}</td><td style="padding:2px 0;word-wrap:break-word;overflow-wrap:anywhere;">${esc(l.slice(i + 2))}</td></tr>`;
  });
  // Fixed layout + wrapping (BRO-6081): the nowrap labels pushed this table
  // ~20px past a 390px phone screen.
  return `<div style="margin:0 0 14px;"><p style="font-size:13px;font-weight:700;margin:0 0 4px;">Board numbers (detail)</p><table style="font-size:12px;border-collapse:collapse;width:100%;table-layout:fixed;">${rows.join('')}</table></div>`;
}

module.exports = {
  summarizeBoardFlow, fetchBoardInflowCounts,
  fetchOpenByPriority, fetchStuckCards, fetchParkedCards, fetchInflowBySource, summarizeInflowBySource, readLanded, fetchOpusUsage, fetchClaudeCost, fetchBoardNumbersData, buildBoardNumbers, renderBoardNumbersLines, renderBoardNumbersHtml, filingOutpacesClosingLine, ceremonyKind, PRIORITY_LABELS,
};
