'use strict';
// BRO-7488: tripwire for "a morning-digest row has been listed for days and no
// card exists for it". The Action's email is report-only and the Mac's
// --autofix-only pass files the cards from a machine-local persistence file,
// so a row can sit in the digest as "no automatic fix confirmed" for days with
// nothing visible to say whether it is being watched or forgotten
// (2026-11-14: three rows, 3 to 5 days).
//
// The clock is the row's `firstSeen` in the tracked health snapshot
// (health-first-seen.js), which keeps running across short clears. The alert
// ledger's incident clock restarts after a gap, so it read 5h to 62h for these
// rows and is no use here. A row's card is matched the way digest-autofix does
// it: plan title (family-collapsed, "BSC Daily: <condition>"), the number-free
// title, or a `covers-digest-row:` line on any open card.
//
// Advisory: the row this feeds is warn-only (CLAUDE.md rule 19).

const { planAutofix, numberFreeTitle, coveredRowTitles } = require('./digest-autofix.js');

const UNCARDED_AFTER_DAYS = 4;
const ROW_NAME = 'Autofix: digest rows listed 4+ days with no card';
const TITLE_PREFIX_RE = /^(?:Fix: )?/;

/**
 * PURE. Plan rows of the snapshot that are still 'needs-card', were first seen
 * at least `minDays` ago (believable firstSeen only), and have no open card.
 * @param {{errors?:object[], warns?:object[], queued?:object[]}} snapshot
 * @param {Array<{title:string, description?:string}>} openIssues
 * @param {number} nowMs
 * @returns {Array<{title:string, days:number}>} oldest first
 */
function findUncardedDigestRows(snapshot, openIssues, nowMs, { minDays = UNCARDED_AFTER_DAYS } = {}) {
  const plan = planAutofix({ health: snapshot || {}, tasks: [], queued: (snapshot && snapshot.queued) || [], today: new Date(nowMs).toISOString().slice(0, 10) });
  const issues = Array.isArray(openIssues) ? openIssues : [];
  const titles = new Set(issues.map((i) => String((i && i.title) || '').replace(TITLE_PREFIX_RE, '')));
  const free = new Set([...titles].map((t) => numberFreeTitle(t)));
  const covered = coveredRowTitles(issues);
  const out = [];
  for (const row of plan) {
    if (row.state !== 'needs-card' || !row.firstSeen) continue;
    const days = (nowMs - Date.parse(row.firstSeen)) / 86400000;
    if (!(days >= minDays)) continue;
    const free1 = numberFreeTitle(row.title);
    const plain = row.title.replace(/^BSC Daily: /, '');
    if (titles.has(row.title) || free.has(free1) || covered.has(free1) || covered.has(numberFreeTitle(plain)) || (row.name && covered.has(numberFreeTitle(row.name)))) continue;
    out.push({ title: row.title, days: Math.floor(days) });
  }
  return out.sort((a, b) => b.days - a.days);
}

/** The health-check row. Linear failure reports unmeasurable rather than passing. */
async function uncardedDigestRowsResult({ snapshot, listOpenIssues, nowMs = Date.now() }) {
  if (!snapshot) return { name: ROW_NAME, status: 'pass', message: 'No previous digest snapshot to check' };
  let openIssues;
  try {
    openIssues = await listOpenIssues();
  } catch (err) {
    return { name: ROW_NAME, status: 'warn', message: `Unmeasurable: could not list open Linear issues (${String(err.message || err).slice(0, 160)})` };
  }
  const rows = findUncardedDigestRows(snapshot, openIssues, nowMs);
  if (rows.length === 0) return { name: ROW_NAME, status: 'pass', message: `Every digest row listed ${UNCARDED_AFTER_DAYS}+ days has a card` };
  const list = rows.slice(0, 5).map((r) => `${r.title.replace(/^BSC Daily: /, '')} (${r.days}d)`).join('; ');
  return {
    name: ROW_NAME,
    status: 'warn',
    message: `${rows.length} digest row(s) listed ${UNCARDED_AFTER_DAYS}+ days with no card: ${list}${rows.length > 5 ? '; ...' : ''}`,
    hint: 'Cards for digest rows are filed by the Mac pass (send-morning-digest.js --autofix-only) once a row passes the 72h hold; the hold now reads the snapshot firstSeen, so a row this old means that pass is not running, is failing to file, or the card was closed while the row stayed red. Check the Mac morning-digest job log and data/audit/digest-autofix-ledger.jsonl.',
  };
}

module.exports = { findUncardedDigestRows, uncardedDigestRowsResult, ROW_NAME, UNCARDED_AFTER_DAYS };
