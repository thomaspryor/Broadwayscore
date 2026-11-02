'use strict';
/**
 * board-categories.js — ONE way to report the board (BRO-6442).
 *
 * The owner asked (2026-10-27) that every session and the morning email report
 * the open board the same way, so they never have to re-derive it. This module
 * puts every open card in EXACTLY ONE category (first match wins, in the order
 * of CATEGORIES) and also counts, per category, every card that has that trait
 * (the overlap count). scripts/board-report.js prints it; the morning digest
 * renders the same numbers (board-summary.js renderBoardCategoriesHtml).
 *
 * No rule here is new: each trait calls the helper that already owns it
 * (owner decisions, visual asks, RECHECK-AFTER stamps, park classifiers, the
 * cloud worker's skip and pause-history verdicts, the Codex bounce marker).
 * The only local definitions are the category order and the words that make a
 * park reason a "real block" (the card's own definition, BRO-6442).
 *
 * categorizeBoard is pure. fetchOpenBoard and fetchFlow24h take an injected
 * graphql (linear-client.js graphql) like board-summary.js fetchDailyFlow.
 */

const { findOwnerDecisions } = require('./owner-decision-notify.js');
const { holdReason } = require('./owner-decision-quiet-period.js');
const { isAutomationParked, OWNER_HOLD_PARK_RE, visualAskOpen, commentClearsOwnerGate } = require('./headless-dispatchability.js');
const { parseRecheckAfterFromCard } = require('./recheck-stamp.js');
const { skipReason, historySkipReason } = require('./cloud-worker-pick.js');
const { codexBouncedRecently, codexBounceCapped } = require('./codex-runner.js');
const { proseDateWait } = require('./prose-date-wait.js');

// Order matters: a card's exclusive category is the first one whose trait it has.
const CATEGORIES = [
  { key: 'waiting-owner', label: 'Waiting on your answer' },
  { key: 'being-worked', label: 'Being worked on now' },
  { key: 'started-idle', label: 'Started, but no update for 2+ days' },
  { key: 'dated-future', label: 'Waiting for a date in the future' },
  // BRO-6853: split by the recheck ledger's last verdict. Without a ledger every past-dated card is "waiting".
  { key: 'dated-past-failed', label: 'Date passed, its check failed' },
  { key: 'dated-past', label: 'Date passed, waiting for its check' },
  { key: 'parked-real-block', label: 'Needs a password, money or your devices' },
  { key: 'parked-automatic', label: 'Automatic alert or estimate' },
  { key: 'parked-owner-wording', label: 'Says it needs you, but asks nothing' },
  { key: 'parked-no-reason', label: 'Parked with no reason written' },
  { key: 'parked-prose-wait', label: 'Waits on a time written in words, so never restarts' },
  { key: 'parked-other', label: 'Parked for another reason' },
  { key: 'paused', label: 'Paused' },
  { key: 'ready', label: 'Ready, a worker will pick it up' },
  { key: 'cooling-off', label: 'Cooling off after recent activity' },
  { key: 'codex-bounced', label: 'Second-check reviewer rejected it, short wait' },
  { key: 'owner-gated-no-question', label: 'Held for you, but no question written yet' },
  { key: 'app-repo', label: 'iPhone-app card (automatic workers cannot open it)' },
  { key: 'needs-safe-check', label: 'Needs a way to prove it works (a daily job drafts these)' },
  { key: 'other', label: 'Other' },
];
// BRO-6870: the morning email shows the rows under four plain headings. Every
// category key sits in exactly one group (tested), so subtotals add to the total.
const GROUPS = [
  { key: 'needs-you', title: 'Needs you', blurb: 'Waiting for a yes or no from you.',
    keys: ['waiting-owner'] },
  { key: 'moving', title: 'Moving', blurb: 'Nothing to do. Workers pick these up and dated ones restart on their own.',
    keys: ['being-worked', 'ready', 'cooling-off', 'dated-future'] },
  { key: 'stuck', title: 'Stuck, the system is handling it', blurb: 'A daily job reclaims, rechecks or asks again. Nothing to do unless one is Urgent.',
    keys: ['started-idle', 'dated-past', 'dated-past-failed', 'needs-safe-check', 'codex-bounced', 'owner-gated-no-question', 'parked-owner-wording', 'parked-no-reason', 'parked-prose-wait'] },
  { key: 'parked', title: 'Parked on purpose', blurb: 'Held until the block clears. Nothing to do.',
    keys: ['parked-real-block', 'parked-automatic', 'parked-other', 'paused', 'app-repo', 'other'] },
];

/**
 * PURE. The report's category rows under GROUPS, with subtotals. A category nobody put in a group
 * lands in a last "Not sorted yet" group, so a new category can never blank the email table or lose cards
 * (a test still requires every CATEGORIES key to have a real group).
 */
function groupBoard(report) {
  const byKey = new Map((report.categories || []).map((c) => [c.key, c]));
  const placed = new Set(GROUPS.flatMap((g) => g.keys));
  const uh = (c) => c.byPriority.urgent + c.byPriority.high;
  const make = (g, rows) => ({ key: g.key, title: g.title, blurb: g.blurb, rows, exclusive: rows.reduce((a, c) => a + c.exclusive, 0),
    overlap: rows.reduce((a, c) => a + c.overlap, 0), urgentHigh: rows.reduce((a, c) => a + uh(c), 0) });
  const groups = GROUPS.map((g) => make(g, g.keys.map((k) => byKey.get(k)).filter(Boolean)));
  const lost = [...byKey.values()].filter((c) => !placed.has(c.key));
  if (lost.length) groups.push(make({ key: 'unsorted', title: 'Not sorted yet', blurb: 'New kinds of card that have not been placed under a heading.' }, lost));
  return groups;
}

// Same idle window as linear-reclaim-abandoned.js RECLAIM_IDLE_MS.
const STARTED_IDLE_MS = 48 * 60 * 60 * 1000;
const COMMENT_FETCH_CAP = 100;
const NEEDS_SAFE_CHECK_REASONS = new Set(['no-safe-verify', 'verify-not-cloud-runnable']);

const PRIORITY_KEYS = { 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low', 0: 'none' };
// Same priority-to-lane map as check-linear-drain-health.js tierOf.
const TIER_BY_PRIORITY = { 1: 'p0p1', 2: 'p0p1', 3: 'p2', 4: 'p3' };
const PARKED_REASON_RE = /^\s*PARKED\s*:(.*)$/gim;
// A park only something outside the fleet can lift: a key or credential, money, or the owner's devices.
// "key" alone, but not "key decision/question/point" (owner wording, not a credential).
const REAL_BLOCK_RE = /\b(?:api[- ]?keys?|keys?(?!\s+(?:decisions?|questions?|points?|calls?|choices?)\b)|tokens?|credentials?|creds|spend(?:ing)?|credits?|budget|mac|launchd|iphone|simulator)\b/i;
const MACHINE_FILED_RE = /notify-pending-commercial/i;
const MACHINE_TITLE_RE = /^\s*BSC (?:Daily|Rebuild)\b/i;
// Skip reasons meaning the dispatcher holds the card for the owner (BRO-6443).
const OWNER_GATED_REASONS = new Set(['awaiting-owner', 'owner-judgment', 'blocker-OWNER_DECISION_GATE']);
const COOLING_REASONS = new Set(['recent-activity', 'recently-paused', 'paused-repeatedly']);

function priorityKey(p) { return PRIORITY_KEYS[Number(p)] || 'none'; }

/** Comments oldest first (the helpers that scan for "the newest" read from the end). */
function sortedComments(issue) {
  const nodes = (issue && issue.comments && Array.isArray(issue.comments.nodes)) ? issue.comments.nodes : [];
  return nodes.filter(Boolean).slice().sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
}

function parkReasons(description) {
  return [...String(description || '').matchAll(PARKED_REASON_RE)].map((m) => m[1].trim());
}

/** Start of the UTC day: RECHECK-AFTER stamps are UTC dates (recheck-stamp.js). */
function utcDayStart(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** An open owner question (or awaiting-owner label, or open visual ask) nobody has answered. */
function waitsOnOwner(issue, bodies, { secret, nowMs }) {
  if (visualAskOpen(issue.description, bodies)) return true;
  const d = findOwnerDecisions([issue])[0];
  if (!d) return false;
  if (commentClearsOwnerGate(bodies, issue.description)) return false;
  if (d.question) {
    const hold = holdReason(issue, d, { secret, now: nowMs });
    if (hold && hold.reason === 'answered') return false;
  }
  return true;
}

/**
 * PURE. Every trait one card has, and why it is in "Other" when it lands there.
 * -> { traits: Set<key>, reason }
 */
function cardTraits(issue, { nowMs, secret = null, lastRecheckStatus = null } = {}) {
  const traits = new Set(['other']);
  const comments = sortedComments(issue);
  const bodies = comments.map((c) => String(c.body || ''));
  const description = String(issue.description || '');
  const stateName = String(issue.state && issue.state.name || '');
  const stateType = String(issue.state && issue.state.type || '');

  if (waitsOnOwner(issue, bodies, { secret, nowMs })) traits.add('waiting-owner');
  if (stateType === 'started') {
    // Newest touch = card edit or newest comment. A full comment page may hide a newer one: count it active.
    const touched = Math.max(Date.parse(issue.updatedAt) || 0, ...comments.map((c) => Date.parse(c.createdAt) || 0));
    const idle = touched > 0 && comments.length < COMMENT_FETCH_CAP && nowMs - touched >= STARTED_IDLE_MS;
    traits.add(idle ? 'started-idle' : 'being-worked');
  }

  // The recheck only reads paused (Paused/Backlog) cards, so an old stamp on a
  // card back in Todo or In Progress is history, not a date it waits on.
  const stamp = (stateName === 'Paused' || stateName === 'Backlog')
    ? parseRecheckAfterFromCard({ comments: bodies, notes: description }) : null;
  if (stamp != null) {
    if (stamp >= utcDayStart(nowMs)) traits.add('dated-future');
    else traits.add(lastRecheckStatus === 'fail' ? 'dated-past-failed' : 'dated-past');
  }

  const reasons = parkReasons(description);
  const parked = reasons.length > 0 || stateName === 'Backlog';
  if (reasons.some((r) => REAL_BLOCK_RE.test(r))) traits.add('parked-real-block');
  if (parked && (isAutomationParked(description) || MACHINE_FILED_RE.test(description) || MACHINE_TITLE_RE.test(issue.title || ''))) traits.add('parked-automatic');
  if (reasons.some((r) => OWNER_HOLD_PARK_RE.test(r))) traits.add('parked-owner-wording');
  if (stateName === 'Backlog' && !reasons.length) traits.add('parked-no-reason');
  if (reasons.some((r) => proseDateWait(r)) && stamp == null) traits.add('parked-prose-wait');
  if (reasons.length) traits.add('parked-other');
  if (stateName === 'Paused') traits.add('paused');

  const tier = TIER_BY_PRIORITY[Number(issue.priority)];
  const skip = tier ? skipReason(issue, nowMs, { tier }) : 'no-priority';
  const history = historySkipReason(issue, comments, nowMs);
  // Two Codex rejections hand the card to the Claude worker for good (BRO-6857): still ready, for that lane.
  const capped = codexBounceCapped(comments, nowMs);
  const bounced = !capped && codexBouncedRecently(comments, nowMs);
  if (!skip && !history && !bounced) traits.add('ready');
  if (COOLING_REASONS.has(skip) || COOLING_REASONS.has(history)) traits.add('cooling-off');
  if (bounced) traits.add('codex-bounced');
  // Last so every other row wins first; a real question already landed in waiting-owner above.
  if (OWNER_GATED_REASONS.has(skip) || OWNER_GATED_REASONS.has(history)) traits.add('owner-gated-no-question');

  const why = skip || history;
  if (why === 'ios-app-repo') traits.add('app-repo');
  if (NEEDS_SAFE_CHECK_REASONS.has(why)) traits.add('needs-safe-check');

  const reason = skip || history || (bounced ? 'codex-bounced' : null) || `state-${stateType || 'unknown'}`;
  return { traits, reason };
}

function emptyPriorities() { return { urgent: 0, high: 0, medium: 0, low: 0, none: 0 }; }

/**
 * PURE. The board report. `issues` are the open cards with comments
 * ({identifier,title,description,priority,url,createdAt,updatedAt,state{name,type},labels{nodes},comments{nodes}}).
 * `secret` is APPROVAL_HMAC_SECRET: without it the "already answered" test can
 * only see the ANSWERED line the answer path writes, so answeredCheck says so.
 * Throws when the exclusive counts do not add up to the open count.
 */
function categorizeBoard(issues, { now = new Date(), secret = null, lastRecheckStatusById = null } = {}) {
  const nowMs = now.getTime();
  const rows = new Map(CATEGORIES.map((c) => [c.key, { ...c, exclusive: 0, overlap: 0, byPriority: emptyPriorities() }]));
  const cards = [];
  const list = (issues || []).filter((i) => i && i.identifier);
  for (const issue of list) {
    let traits;
    let reason;
    try {
      ({ traits, reason } = cardTraits(issue, { nowMs, secret, lastRecheckStatus: lastRecheckStatusById && lastRecheckStatusById.get(issue.identifier) || null }));
    } catch (err) {
      // One malformed card must not blank the whole report.
      traits = new Set(['other']);
      reason = `categorize-error: ${String(err && err.message || err).slice(0, 80)}`;
    }
    const category = CATEGORIES.find((c) => traits.has(c.key)).key;
    // "Other" is the fallback, so it fits only the cards that land there.
    for (const key of traits) if (key !== 'other' || category === 'other') rows.get(key).overlap++;
    const row = rows.get(category);
    row.exclusive++;
    row.byPriority[priorityKey(issue.priority)]++;
    cards.push({
      identifier: issue.identifier,
      title: issue.title || issue.identifier,
      url: issue.url || null,
      priority: Number(issue.priority) || 0,
      state: issue.state && issue.state.name || null,
      category,
      reason: category === 'other' ? reason : null,
      traits: CATEGORIES.map((c) => c.key).filter((k) => k !== 'other' && traits.has(k)),
    });
  }
  const categories = [...rows.values()];
  const sum = categories.reduce((a, c) => a + c.exclusive, 0);
  if (sum !== list.length) {
    throw new Error(`board-categories invariant broken: exclusive counts sum to ${sum} but ${list.length} cards are open`);
  }
  const totals = { exclusive: sum, byPriority: emptyPriorities() };
  for (const c of categories) for (const k of Object.keys(totals.byPriority)) totals.byPriority[k] += c.byPriority[k];
  return {
    generatedAt: now.toISOString(),
    open: list.length,
    answeredCheck: secret ? 'full' : 'answered-line-only',
    categories,
    totals,
    importantStuck: importantAndStuck(cards),
    cards,
  };
}

// Other-row reasons that mean the dispatcher holds the card for the owner.
function ownerGatedNoQuestion(report) {
  return (report.cards || []).filter((c) => c.category === 'owner-gated-no-question'
    || (c.category === 'other' && OWNER_GATED_REASONS.has(c.reason))).length;
}

const NOT_STUCK = new Set(['waiting-owner', 'dated-future', 'dated-past', 'dated-past-failed']);

/**
 * Urgent or High cards nobody is on: not being worked, not dated, not waiting on
 * the owner. Only In Progress counts as worked here: In Review is a started state
 * too, and idle In Review cards are where stuck work hides (in-review-backlog.js).
 */
function importantAndStuck(cards) {
  return cards
    .filter((c) => (c.priority === 1 || c.priority === 2) && !c.traits.some((t) => NOT_STUCK.has(t)))
    .filter((c) => !(c.traits.includes('being-worked') && c.state !== 'In Review'))
    .sort((a, b) => a.priority - b.priority || a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
}

/** Last 24h from board-numbers' flow walk (fetchBoardInflowCounts, windowDays 1). */
function flowFromInflow(f) {
  if (!f) return null;
  const ex = f.excluded || {};
  return {
    created: f.created,
    createdSelf: (ex.created && ex.created.sessionTracking) || 0,
    done: f.completed,
    doneSelf: (ex.completed && ex.completed.sessionTracking) || 0,
    canceled: f.canceled,
    truncated: !!f.truncated,
  };
}

/** The counts a later run compares against: no titles or ids (the file can sit in a checkout). */
function snapshotOf(report, flow = null) {
  return {
    generatedAt: report.generatedAt,
    open: report.open,
    categories: report.categories.map((c) => ({ key: c.key, exclusive: c.exclusive, overlap: c.overlap })),
    importantStuck: report.importantStuck.length,
    flow,
  };
}

/** PURE. Per-category change from a saved snapshot (or full --json report) to now. */
function compareReports(prev, cur) {
  const before = new Map(((prev && prev.categories) || []).map((c) => [c.key, c]));
  return {
    from: prev && prev.generatedAt || null,
    to: cur.generatedAt,
    open: { before: prev && Number.isFinite(prev.open) ? prev.open : null, after: cur.open },
    rows: cur.categories.map((c) => {
      const b = before.get(c.key);
      return { key: c.key, label: c.label, before: b ? b.exclusive : null, after: c.exclusive, delta: b ? c.exclusive - b.exclusive : null };
    }),
  };
}

/**
 * PURE. Last real verdict per card from the recheck ledger rows (BRO-6853). Only cards keyed
 * "BRO-N" count (older rows are Notion ids); a skipped row (status null) says nothing about the
 * check, so it never overwrites an earlier verdict. Rows are read oldest first.
 * -> Map<identifier, 'pass'|'fail'|'unverifiable'|...>
 */
function lastRecheckStatuses(entries) {
  const out = new Map();
  // Sorted by ts so an appended retry of an older run cannot overwrite a newer verdict.
  const rows = (entries || []).filter(Boolean).slice().sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  for (const e of rows) {
    if (!e || e.event !== 'recheck' || !/^BRO-\d+$/.test(String(e.cardId || '')) || !e.status) continue;
    out.set(e.cardId, e.status);
  }
  return out;
}

/** Ledger entries for the board report; [] when the file is missing (every past-dated card then reads "waiting"). */
function readRecheckLedgerStatuses(ledgerPath) {
  const fs = require('fs');
  const path = require('path');
  const file = ledgerPath || path.join(__dirname, '..', '..', 'data', 'audit', 'autonomous-recheck-ledger.jsonl');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return new Map(); }
  const entries = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { entries.push(JSON.parse(line)); } catch { /* skip a torn line */ } }
  return lastRecheckStatuses(entries);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function flowLine(flow) {
  if (!flow) return 'Last 24 hours: not available.';
  const self = (n) => (n ? ` (plus ${n} that sessions filed to track their own work)` : '');
  return `Last 24 hours: ${plural(flow.created, 'card')} added${self(flow.createdSelf)}, ${flow.done} done${self(flow.doneSelf)}, ${flow.canceled} canceled${flow.truncated ? ' (minimums: Linear did not return every card)' : ''}.`;
}

/**
 * PURE. The plain-English table sessions paste to the owner. No card ids,
 * reason codes or file names: the owner reads titles and categories.
 */
function formatMarkdown(report, { flow = null, maxStuck = 15 } = {}) {
  const urgentHigh = (c) => c.byPriority.urgent + c.byPriority.high;
  const lines = [
    `**The board: ${plural(report.open, 'open card')}**`,
    '',
    '| Category | Only here | All with this | Urgent+High |',
    '|---|---:|---:|---:|',
    ...report.categories.map((c) => `| ${c.label} | ${c.exclusive} | ${c.overlap} | ${urgentHigh(c)} |`),
    `| **Total** | **${report.totals.exclusive}** | | **${report.totals.byPriority.urgent + report.totals.byPriority.high}** |`,
    '',
    '"Only here" counts each card once, in the first row that fits it, so it adds up to the total. "All with this" counts every card that fits the row.',
    '',
    flowLine(flow),
    '',
  ];
  const stuck = report.importantStuck;
  if (!stuck.length) {
    lines.push('Important and stuck: none. Every Urgent or High card is being worked, dated or waiting on you.');
  } else {
    const label = new Map(CATEGORIES.map((c) => [c.key, c.label]));
    lines.push(`Important and stuck (${plural(stuck.length, 'Urgent or High card')} nobody is on):`);
    for (const c of stuck.slice(0, maxStuck)) lines.push(`- ${c.priority === 1 ? 'Urgent' : 'High'}: ${c.title} (${c.state === 'In Review' ? 'In Review, nobody on it' : label.get(c.category)})`);
    if (stuck.length > maxStuck) lines.push(`- and ${stuck.length - maxStuck} more`);
  }
  const gated = ownerGatedNoQuestion(report);
  if (gated) lines.push('', `${plural(gated, 'card')} ${gated === 1 ? 'is' : 'are'} held for you but ${gated === 1 ? 'has' : 'have'} no clear DECISION NEEDED question, so ${gated === 1 ? 'it is' : 'they are'} not in "Waiting on your answer". ${gated === 1 ? 'It needs' : 'They need'} a real question or a release to a worker.`);
  const broken = report.cards.filter((c) => /^categorize-error/.test(c.reason || '')).length;
  if (broken) lines.push('', `${plural(broken, 'card')} could not be read and ${broken === 1 ? 'is' : 'are'} counted under Other.`);
  if (report.answeredCheck !== 'full') {
    lines.push('', '_Answered questions were recognised from the card text only (no answer-link secret in this run)._');
  }
  return lines.join('\n');
}

function formatCompareMarkdown(cmp) {
  const d = (n) => (n == null ? 'new' : n > 0 ? `+${n}` : String(n));
  return [
    `**Board change since ${cmp.from ? cmp.from.slice(0, 16).replace('T', ' ') + ' UTC' : 'the saved report'}**`,
    '',
    '| Category | Before | Now | Change |',
    '|---|---:|---:|---:|',
    ...cmp.rows.map((r) => `| ${r.label} | ${r.before == null ? '' : r.before} | ${r.after} | ${d(r.delta)} |`),
    `| **Open** | ${cmp.open.before == null ? '' : cmp.open.before} | ${cmp.open.after} | ${cmp.open.before == null ? '' : d(cmp.open.after - cmp.open.before)} |`,
  ].join('\n');
}

// ── I/O (graphql injected) ────────────────────────────────────────────────

const OPEN_BOARD_QUERY = `query OpenBoard($teamKey: String!, $after: String) {
  issues(filter: { team: { key: { eq: $teamKey } }, state: { type: { nin: ["completed", "canceled"] } } }, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id identifier title description priority url createdAt updatedAt state { name type } labels { nodes { name } }
      comments(first: 100, orderBy: createdAt) { nodes { body createdAt } } }
  }
}`;
const MAX_PAGES = 15;

/** Every open card with its comments. Refuses a partial list rather than report a short board. */
async function fetchOpenBoard({ graphql, teamKey = 'BRO', maxPages = MAX_PAGES } = {}) {
  const out = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await graphql(OPEN_BOARD_QUERY, { teamKey, after });
    const conn = data && data.issues;
    if (!conn || !Array.isArray(conn.nodes)) throw new Error('Linear returned no issues connection for the open board');
    out.push(...conn.nodes);
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) return out;
    after = conn.pageInfo.endCursor;
  }
  throw new Error(`more than ${maxPages * 100} open cards; refusing to report a partial board`);
}

async function fetchFlow24h({ graphql, now = new Date() } = {}) {
  const { fetchBoardInflowCounts } = require('./board-numbers.js');
  return flowFromInflow(await fetchBoardInflowCounts({ graphql, now, windowDays: 1 }));
}

/** board-report.js flags (kept here so the CLI is a printer and its parsing is tested with the lib). */
function parseReportArgs(argv) {
  const opts = { mode: 'markdown', compare: null, save: null };
  const modes = new Set();
  for (const a of argv) {
    if (a === '--markdown') { opts.mode = 'markdown'; modes.add(a); }
    else if (a === '--json') { opts.mode = 'json'; modes.add(a); }
    else if (a.startsWith('--compare=')) { opts.mode = 'compare'; opts.compare = a.slice('--compare='.length); modes.add('--compare'); }
    else if (a.startsWith('--save=')) opts.save = a.slice('--save='.length);
    else return { error: `unknown argument: ${a}` };
  }
  if (modes.size > 1) return { error: `pick one of ${[...modes].join(', ')}` };
  if (opts.mode === 'compare' && !opts.compare) return { error: '--compare needs a file' };
  if (opts.save === '') return { error: '--save needs a file' };
  return opts;
}

module.exports = {
  CATEGORIES, GROUPS, groupBoard, REAL_BLOCK_RE, lastRecheckStatuses, readRecheckLedgerStatuses,
  cardTraits, categorizeBoard, importantAndStuck, ownerGatedNoQuestion, flowFromInflow, snapshotOf, compareReports,
  flowLine, formatMarkdown, formatCompareMarkdown, parseReportArgs,
  fetchOpenBoard, fetchFlow24h,
};
