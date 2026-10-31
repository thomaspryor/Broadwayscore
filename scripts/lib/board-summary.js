'use strict';
/**
 * board-summary.js — the owner-facing "How the board is doing" block at the top
 * of the morning digest (BRO-6081). The owner asked (2026-10-23) for a summary
 * they can read in five seconds: a verdict first (keeping up or falling
 * behind), a 7-day added-vs-closed chart, and four plain tiles. The full Board
 * numbers table (board-numbers.js) moved under Technical details.
 *
 * Email-safe on purpose: tables, inline styles, no SVG or script, so it renders
 * the same in Gmail and iOS Mail. Colors are the dataviz reference palette's
 * categorical slots 2 (orange, added) and 1 (blue, closed), validated together
 * (CVD dE 24.7, both >= 3:1 on white); values and labels stay in text ink.
 */

const TEAM_KEY = 'BRO';
// The digest is sent and dated on the Mac's clock, 07:30 America/New_York
// (launchd plist; send-morning-digest.js date line), so its days are NY days.
const TZ = 'America/New_York';
const DAYS = 7;
// ~425 issues/week is 2 pages; 8 pages x (2 x 6s) bounds the worst case inside
// the digest's shared 330s board-numbers budget.
const MAX_PAGES = 8;
const ADDED_COLOR = '#eb6834';
const CLOSED_COLOR = '#2a78d6';
const INK = '#1a1a19';
const MUTED = '#6b6b66';

const DAILY_FLOW_QUERY = `query DailyFlow($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: 250, after: $after, includeArchived: true) {
    pageInfo { hasNextPage endCursor }
    nodes { createdAt completedAt canceledAt }
  }
}`;

/** YYYY-MM-DD of a timestamp in the owner's time zone. */
function localDay(ts, tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

/**
 * The last `days` complete local dates, oldest first, ending yesterday: the
 * digest goes out around 07:30, so "today" would be a near-empty bar.
 */
function dayKeys(now, days = DAYS, tz = TZ) {
  const today = localDay(now.getTime(), tz);
  const out = [];
  // Step back in 12h increments so a DST day can never skip or repeat a date.
  for (let h = 12; out.length < days && h < (days + 2) * 24; h += 12) {
    const d = localDay(now.getTime() - h * 3_600_000, tz);
    if (d !== today && !out.includes(d)) out.push(d);
  }
  return out.reverse();
}

/**
 * PURE. Issue timestamps -> [{ day, added, closed }] for the last `days` local
 * days (closed = completed or canceled; an issue created and closed in the
 * window counts on both days).
 */
function bucketDailyFlow(nodes, { now = new Date(), days = DAYS, tz = TZ } = {}) {
  const keys = dayKeys(now, days, tz);
  const rows = new Map(keys.map((d) => [d, { day: d, added: 0, closed: 0, canceled: 0 }]));
  for (const n of nodes || []) {
    if (!n) continue;
    if (n.createdAt) { const r = rows.get(localDay(n.createdAt, tz)); if (r) r.added++; }
    const closedAt = n.completedAt || n.canceledAt;
    if (closedAt) {
      const r = rows.get(localDay(closedAt, tz));
      if (r) { r.closed++; if (!n.completedAt) r.canceled++; }
    }
  }
  return keys.map((d) => rows.get(d));
}

/** Fetch the window's created/closed timestamps and bucket them. -> { days, truncated } */
async function fetchDailyFlow({ graphql, now = new Date(), days = DAYS, teamKey = TEAM_KEY, maxPages = MAX_PAGES } = {}) {
  // Start of the oldest local day, with a day of slack; bucketDailyFlow drops anything outside.
  const since = new Date(now.getTime() - (days + 2) * 86_400_000).toISOString();
  const filter = {
    team: { key: { eq: teamKey } },
    or: [{ createdAt: { gte: since } }, { completedAt: { gte: since } }, { canceledAt: { gte: since } }],
  };
  const nodes = [];
  let after = null;
  for (let page = 0; ; page++) {
    const data = await graphql(DAILY_FLOW_QUERY, { filter, after }, { maxAttempts: 2, timeoutMs: 6_000, baseMs: 250 });
    const conn = data && data.issues;
    if (!conn || !Array.isArray(conn.nodes)) throw new Error('Linear returned no issues connection for the daily flow');
    nodes.push(...conn.nodes);
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) return { days: bucketDailyFlow(nodes, { now, days }), truncated: false };
    if (page + 1 >= maxPages) return { days: bucketDailyFlow(nodes, { now, days }), truncated: true };
    after = conn.pageInfo.endCursor;
  }
}

const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * PURE. The verdict: are cards being closed at least as fast as they arrive?
 * Uses the chart's own days when present so the sentence and the chart agree,
 * else board-numbers' 7-day counts. -> { tone: 'good'|'warn'|null, headline, sentence }
 */
function boardVerdict(m, daily, { partial = false } = {}) {
  const open = m.open ? m.open.total : null;
  let added = null;
  let closed = null;
  let canceled = null;
  if (Array.isArray(daily) && daily.length) {
    added = sum(daily, 'added');
    closed = sum(daily, 'closed');
    canceled = sum(daily, 'canceled');
  } else if (m.added.d7 !== null && m.completed.d7 !== null && m.canceled.d7 !== null) {
    added = m.added.d7;
    closed = m.completed.d7 + m.canceled.d7;
    canceled = m.canceled.d7;
  }
  if (added === null) return { tone: null, headline: 'No numbers today', sentence: 'The board could not be read this morning.' };
  const net = added - closed;
  // Canceled is named so a cleanup sweep can't pass as throughput; the pile
  // change is net flow, so "about" (reopens and archiving move it too).
  const closedText = `${closed} cards were closed${canceled ? ` (${canceled} of them canceled, not done)` : ''}`;
  const pile = net === 0 ? ', so the open pile held about steady'
    : `, so the open pile is about ${Math.abs(net)} ${net < 0 ? 'smaller' : 'bigger'}`;
  const sentence = `Over the last 7 days ${closedText} and ${added} were added${pile}${open === null ? '' : ` (${open} open now)`}.`;
  if (partial) return { tone: null, headline: 'Partial numbers today', sentence: `${sentence} Linear did not return every card, so these are minimums.` };
  if (net <= 0) return { tone: 'good', headline: 'Keeping up', sentence };
  return { tone: 'warn', headline: 'Falling behind', sentence };
}

function weekdayLabel(day, tz = TZ) {
  // day is a local YYYY-MM-DD; noon UTC keeps it on the same calendar date in New York.
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(new Date(`${day}T12:00:00Z`));
}

function bar(value, max, color) {
  const pct = max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100)) : 0;
  const fill = pct > 0
    ? `<td width="${pct}%" style="background-color:${color};height:8px;line-height:8px;font-size:0;border-radius:0 4px 4px 0;">&nbsp;</td>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>${fill}<td style="height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr></table>`;
}

function renderChart(daily, esc, { now = new Date(), tz = TZ } = {}) {
  const max = Math.max(1, ...daily.map((r) => Math.max(r.added, r.closed)));
  const rows = daily.map((r) => {
    const label = weekdayLabel(r.day, tz);
    return `<tr>
<td style="width:44px;padding:5px 8px 5px 0;font-size:12px;color:${MUTED};vertical-align:middle;white-space:nowrap;">${esc(label)}</td>
<td style="padding:5px 0;vertical-align:middle;">${bar(r.added, max, ADDED_COLOR)}<div style="height:2px;line-height:2px;font-size:0;">&nbsp;</div>${bar(r.closed, max, CLOSED_COLOR)}</td>
<td style="width:64px;padding:5px 0 5px 8px;font-size:12px;color:${INK};text-align:right;vertical-align:middle;white-space:nowrap;">+${r.added} / &minus;${r.closed}</td>
</tr>`;
  }).join('');
  const key = (color, text) => `<span style="white-space:nowrap;"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background-color:${color};vertical-align:middle;"></span> <span style="vertical-align:middle;">${text}</span></span>`;
  return `<p style="font-size:13px;font-weight:700;color:${INK};margin:16px 0 2px;">Cards added vs closed, last 7 full days</p>
<p style="font-size:12px;color:${MUTED};margin:0 0 4px;">${key(ADDED_COLOR, 'added (+)')} &nbsp;&nbsp; ${key(CLOSED_COLOR, 'closed (&minus;)')}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows}</table>
<p style="font-size:11px;color:${MUTED};margin:2px 0 0;">Closed includes canceled cards.</p>`;
}

function tile(big, label, note, esc, side) {
  return `<td width="50%" style="padding:${side === 'left' ? '4px 4px 4px 0' : '4px 0 4px 4px'};vertical-align:top;"><div style="background-color:#f4f4f1;border-radius:8px;padding:10px 12px;">
<div style="font-size:12px;color:${MUTED};">${esc(label)}</div>
<div style="font-size:20px;font-weight:700;color:${INK};line-height:1.3;">${esc(big)}</div>
<div style="font-size:11px;color:${MUTED};">${esc(note)}</div></div></td>`;
}

function money(usd) { return `$${Math.round(usd)}`; }

/** The four tiles: shipped, waiting on you, stuck, cost. Missing data reads "n/a", never 0. */
function tilesFor(m) {
  const lanes7 = m.lanes.d7;
  const lanes1 = m.lanes.d1;
  const shipped = lanes7 ? lanes7.codex + lanes7.claude : null;
  const cost = m.cost || {};
  const claudeUsd = cost.claude && cost.claude.sessions ? cost.claude.totalUsd : null;
  const codexUsd = cost.codex ? cost.codex.usd : null;
  const costBig = claudeUsd === null && codexUsd === null ? 'n/a' : money((claudeUsd || 0) + (codexUsd || 0));
  const costNote = claudeUsd === null
    ? (codexUsd === null ? 'not recorded' : 'Codex checks only; Claude spend not recorded')
    : `Claude ${money(claudeUsd)}${codexUsd === null ? '' : `, Codex checks ${money(codexUsd)}`}`;
  return [
    // landedPerLane counts card ids in landed commit subjects, per lane.
    ['Cards with code shipped', shipped === null ? 'n/a' : String(shipped),
      lanes7 ? `last 7 days; ${lanes1 ? `${lanes1.codex + lanes1.claude} in the last day; ` : ''}Claude ${lanes7.claude}, Codex ${lanes7.codex}` : 'not available'],
    ['Waiting on you', m.waiting === null ? 'n/a' : m.waiting === 0 ? 'Nothing' : plural(m.waiting, 'decision'),
      m.waiting === null ? 'could not be read' : m.waiting ? 'listed at the top of this email' : 'no decisions pending'],
    ['Stuck', m.stuckCards === null ? 'n/a' : `${m.stuckCards}${m.stuckCardsFloor ? '+' : ''} card${m.stuckCards === 1 && !m.stuckCardsFloor ? '' : 's'}`,
      'started, no progress in 2+ days'],
    ['Spent this week', costBig, costNote],
  ];
}

/** The owner-facing block. `daily` is fetchDailyFlow's days or null. */
function renderBoardSummaryHtml(m, daily, esc = (s) => String(s), { now = new Date(), partial = false } = {}) {
  const v = boardVerdict(m, daily, { partial });
  const tone = v.tone === 'good'
    ? { bg: '#e8f6e8', dot: '#0ca30c', icon: '&#10003;' }
    : v.tone === 'warn' ? { bg: '#fdf3dc', dot: '#b97e00', icon: '!' } : { bg: '#f4f4f1', dot: MUTED, icon: '?' };
  const t = tilesFor(m);
  const tiles = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:10px 0 0;">
<tr>${tile(t[0][1], t[0][0], t[0][2], esc, 'left')}${tile(t[1][1], t[1][0], t[1][2], esc, 'right')}</tr>
<tr>${tile(t[2][1], t[2][0], t[2][2], esc, 'left')}${tile(t[3][1], t[3][0], t[3][2], esc, 'right')}</tr></table>`;
  return `<div style="margin:0 0 18px;">
<p style="font-size:15px;font-weight:700;color:${INK};margin:0 0 8px;">How the board is doing</p>
<div style="background-color:${tone.bg};border-radius:8px;padding:10px 12px;">
<div style="font-size:15px;font-weight:700;color:${INK};"><span style="display:inline-block;width:18px;height:18px;line-height:18px;border-radius:9px;background-color:${tone.dot};color:#fff;font-size:12px;text-align:center;margin-right:6px;">${tone.icon}</span>${esc(v.headline)}</div>
<div style="font-size:13px;color:${INK};margin-top:4px;">${esc(v.sentence)}</div></div>
${Array.isArray(daily) && daily.length ? renderChart(daily, esc, { now }) : ''}
${tiles}
</div>`;
}

/**
 * BRO-6442: the same category table board-report.js prints, email-safe (inline
 * styles, no SVG). Labels wrap and numbers never do, so it reads at 390px.
 * `prev` is yesterday's snapshot (board-categories.js snapshotOf); without it
 * no change column is shown. `report` null renders a visible "unavailable"
 * line rather than dropping the block silently.
 */
function renderBoardCategoriesHtml(report, prev, esc = (s) => String(s)) {
  const title = `<p style="font-size:15px;font-weight:700;color:${INK};margin:0 0 6px;">Every open card, once</p>`;
  if (!report || !Array.isArray(report.categories)) {
    return `<div style="margin:0 0 18px;">${title}<p style="font-size:13px;color:${MUTED};margin:0;">Board table unavailable this morning (the board could not be read from Linear).</p></div>`;
  }
  const before = new Map((prev && Array.isArray(prev.categories) ? prev.categories : []).filter((c) => c && Number.isFinite(c.exclusive)).map((c) => [c.key, c.exclusive]));
  const hasPrev = before.size > 0;
  const delta = (key, now) => {
    if (!before.has(key)) return '';
    const d = now - before.get(key);
    if (!d) return '';
    return ` <span style="font-size:11px;color:${MUTED};">(${d > 0 ? '+' : ''}${d})</span>`;
  };
  const th = (s, align) => `<th style="font-size:11px;font-weight:600;color:${MUTED};text-align:${align};padding:4px 4px;border-bottom:1px solid #e4e4df;">${s}</th>`;
  const num = 'font-size:13px;color:#1a1a19;text-align:right;padding:4px 4px;white-space:nowrap;border-bottom:1px solid #f0f0ec;';
  const rows = report.categories.map((c) => {
    const uh = c.byPriority.urgent + c.byPriority.high;
    return `<tr><td style="font-size:13px;color:${INK};padding:4px 4px;border-bottom:1px solid #f0f0ec;">${esc(c.label)}</td>`
      + `<td style="${num}font-weight:700;">${c.exclusive}${delta(c.key, c.exclusive)}</td>`
      + `<td style="${num}color:${MUTED};">${c.overlap}</td>`
      + `<td style="${num}${uh ? '' : `color:${MUTED};`}">${uh}</td></tr>`;
  }).join('\n');
  const tb = report.totals.byPriority;
  const openDelta = hasPrev && Number.isFinite(prev.open) && report.open !== prev.open
    ? ` <span style="font-size:11px;color:${MUTED};">(${report.open > prev.open ? '+' : ''}${report.open - prev.open})</span>` : '';
  const stuck = report.importantStuck || [];
  const gated = require('./board-categories.js').ownerGatedNoQuestion(report);
  return `<div style="margin:0 0 18px;">
${title}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
<tr>${th('', 'left')}${th('Only here', 'right')}${th('All with this', 'right')}${th('Urgent+High', 'right')}</tr>
${rows}
<tr><td style="font-size:13px;font-weight:700;color:${INK};padding:6px 4px;">Total open</td><td style="${num}font-weight:700;border-bottom:0;">${report.totals.exclusive}${openDelta}</td><td style="${num}border-bottom:0;"></td><td style="${num}font-weight:700;border-bottom:0;">${tb.urgent + tb.high}</td></tr>
</table>
<p style="font-size:12px;color:${MUTED};margin:6px 0 0;">Each card counts once, in the first row that fits${hasPrev ? '; numbers in brackets are the change since the last morning email' : ''}. "All with this" counts every card that fits the row. The questions at the top of this email also include ones from your Mac tabs, so that number can differ.${stuck.length ? ` ${stuck.length} Urgent or High ${stuck.length === 1 ? 'card has' : 'cards have'} nobody on ${stuck.length === 1 ? 'it' : 'them'}.` : ''}${gated ? ` ${gated} ${gated === 1 ? 'card in Other is' : 'cards in Other are'} held for you without a clear question.` : ''}</p>
</div>`;
}

module.exports = {
  DAILY_FLOW_QUERY, localDay, dayKeys, bucketDailyFlow, fetchDailyFlow, boardVerdict, tilesFor, renderBoardSummaryHtml, renderBoardCategoriesHtml,
};
