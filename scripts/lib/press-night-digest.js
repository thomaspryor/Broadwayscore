'use strict';

/**
 * press-night-digest.js — one plain-English grade per opening night for the owner's morning email,
 * and a fix card for every miss (BRO-6645, owner ask 2026-10-30: "how do we make sure future
 * openings actually work?").
 *
 * A show's line covers two things:
 *   reviews  the press-night record's verdict (scripts/lib/press-night-record.js evaluateCheck), graded
 *            against the observed release when the record has one (BRO-6614), with the per-review rows
 *            sameNightCheck returns: "18 of 18 reviews live by 1:02am", late and missing outlets by name.
 *   emails   the opening-night Resend draft (Broadway and West End) exists and shows the live numbers
 *            (scripts/lib/broadcast-refresh.js, BRO-6634), and the Reddit draft was emailed with the live
 *            numbers (scripts/lib/reddit-opening-post.js). Before the draft deadline (10am ET the morning
 *            after, scripts/lib/broadcast-deadline.js) a missing draft is "not due yet", never a miss.
 *
 * Times are ET. Pure: records, tracker files and the live numbers are passed in. The card filer takes
 * its Linear calls injected and finds earlier cards by their key line, so a re-run never files twice (fileFixCards).
 */

const { evaluateCheck, observedRecord, sameNightCheck, firstNightLive, DEFAULT_GATES } = require('./press-night-record');
const { draftBaseline, draftChanged } = require('./broadcast-refresh');
const { draftDeadlineAt } = require('./broadcast-deadline');
const { SUBREDDIT_BY_MARKET, MIN_REVIEWS, emailedNumbers } = require('./reddit-opening-post');
const { getOutletDisplayName } = require('./review-normalization');

const BROADCAST_MARKETS = new Set(['broadway', 'west-end']);
const TZ = 'America/New_York';
const MIN = 60000;

/** "1:24am" in New York time. */
function etTime(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '?';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return `${get('hour')}:${get('minute')}${String(get('dayPeriod') || '').toLowerCase()}`;
}

/** YYYY-MM-DD of `ms` in New York. */
function etDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** The press night a morning email on `nowMs` reports: yesterday, New York time. */
function lastNight(nowMs) {
  const d = new Date(`${etDate(nowMs)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const GATE_WORDS = {
  'first-live': 'when the first review went live',
  'coverage-2h': 'the critics list at the 2-hour mark',
  'same-night-completeness': 'which reviews came in that night',
  stability: 'whether reviews stayed up',
  record: 'anything (the overnight check did not run)',
};

/**
 * The reviews half of a show's grade.
 * @returns {{verdict, finalized, release, embargoAt, items, firstLive, why}}
 */
function gradeReviews(rec, nowMs = Date.now()) {
  if (!rec) return { verdict: 'UNKNOWN', finalized: false, why: 'the overnight check did not run', items: [] };
  if (!rec.probe || !rec.probe.endedAt) {
    // A probe that stopped sampling an hour ago is not coming back (a cancelled or timed-out job).
    const last = Date.parse((rec.probe && (rec.probe.lastSampleAt || rec.probe.startedAt)) || '');
    if (Number.isFinite(last) && nowMs - last > 60 * MIN) return { verdict: 'UNKNOWN', finalized: false, why: 'the overnight check stopped before it finished', items: [] };
    return { verdict: 'PENDING', finalized: false, why: 'still being checked', items: [] };
  }
  const result = evaluateCheck(rec);
  const rel = result.release || null;
  const graded = rel ? observedRecord(rec, rel) : rec;
  const gates = rel ? rel.observed.gates : result.gates;
  const verdict = rel ? rel.observed.verdict : result.verdict;
  const sn = sameNightCheck(graded, DEFAULT_GATES);
  const fl = firstNightLive(graded);
  const firstGate = gates.find((g) => g.name === 'first-live');
  let why = null;
  if (verdict === 'UNKNOWN') {
    const noPublish = firstGate && firstGate.status === 'unknown' && /no census or lane discovery shows any outlet published/.test(firstGate.detail);
    why = noPublish ? 'no reviews were published overnight'
      : `could not check ${gates.filter((g) => g.required && g.status === 'unknown').map((g) => GATE_WORDS[g.name] || g.name).join(' or ')}`;
  }
  return {
    verdict, finalized: true, release: rel, embargoAt: graded.embargoAt, items: sn.items || [],
    firstLive: fl ? { at: fl.at, outlet: fl.outlet, afterMin: Math.round((Date.parse(fl.at) - Date.parse(graded.embargoAt)) / MIN), failed: !!(firstGate && firstGate.status === 'fail') } : null,
    lastCheckedAt: rec.probe.lastOkSampleAt || null, why,
  };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Outlet name for the owner: the record's own name, the outlet registry's, else the id in words. */
function outletName(i) {
  if (i.outlet) return i.outlet;
  const reg = getOutletDisplayName(i.outletId);
  if (reg && reg !== i.outletId) return reg;
  return String(i.outletId || 'an outlet').split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/**
 * The emails half. Each entry: {kind: 'broadcast'|'reddit', status: 'ok'|'miss'|'pending', text}.
 * @param {object} p
 * @param {object} p.show            shows.json row
 * @param {object} p.sentShows       opening-night-sent.json `shows`
 * @param {object|null} p.redditDraft reddit-post-drafts.json drafts[showId]
 * @param {function} p.readNumbers   showId -> {score, reviewCount} as the site shows them, or null
 * @param {number} p.nowMs
 */
function gradeEmails({ show, sentShows = {}, redditDraft = null, readNumbers, nowMs }) {
  const out = [];
  const market = show.category || show.market;
  const id = show.id;
  const live = readNumbers(id);
  const deadline = draftDeadlineAt(show.openingDate);
  const due = !deadline || nowMs >= deadline.getTime();
  const dueText = deadline ? etTime(deadline.toISOString()) : '10:00am';
  const nums = (n) => (n && n.score != null ? `score ${n.score} from ${plural(n.reviewCount, 'review', 'reviews')}` : plural(n && n.reviewCount, 'review', 'reviews'));

  if (BROADCAST_MARKETS.has(market)) {
    const rec = sentShows[id];
    const key = rec && rec.broadcastKey;
    const ids = key ? key.slice(key.indexOf(':') + 1).split('+').filter(Boolean) : [id];
    if (rec && rec.sentAt) out.push({ kind: 'broadcast', status: 'ok', text: 'opening-night email sent' });
    else if (rec && rec.discardedAt) out.push({ kind: 'broadcast', status: 'ok', text: 'opening-night email skipped on purpose' });
    else if (rec && rec.draftId) {
      const now = {};
      for (const x of ids) now[x] = readNumbers(x);
      const complete = ids.every((x) => now[x] && now[x].reviewCount != null);
      const was = draftBaseline(sentShows, { ids, record: (key && sentShows[key]) || rec });
      if (complete && draftChanged(was, now, (key && sentShows[key]) || rec)) {
        const before = was && was[id] ? was[id] : { score: null, reviewCount: rec.reviewCount };
        const after = before.score == null ? { score: null, reviewCount: live && live.reviewCount } : live;
        out.push({ kind: 'broadcast', status: 'miss', text: `opening-night email draft is out of date (built with ${nums(before)}, the site shows ${nums(after)})` });
      } else out.push({ kind: 'broadcast', status: 'ok', text: 'opening-night email draft ready' });
    } else if (!due) out.push({ kind: 'broadcast', status: 'pending', text: `opening-night email draft not due until ${dueText}` });
    else out.push({ kind: 'broadcast', status: 'miss', text: 'no opening-night email draft' });
  }

  if (SUBREDDIT_BY_MARKET[market]) {
    const d = redditDraft;
    const expected = d || (market !== 'off-west-end' && live && live.reviewCount >= MIN_REVIEWS[market]);
    if (d && d.postedAt) out.push({ kind: 'reddit', status: 'ok', text: 'Reddit post is up' });
    else if (d && d.emailedAt) {
      const was = emailedNumbers(d);
      const stale = live && live.reviewCount != null && (was.score !== live.score || was.reviewCount !== live.reviewCount);
      out.push(stale
        ? { kind: 'reddit', status: 'miss', text: `Reddit draft emailed to you is out of date (${nums(was)}, the site shows ${nums(live)})` }
        : { kind: 'reddit', status: 'ok', text: 'Reddit draft emailed' });
    } else if (expected) {
      out.push(due ? { kind: 'reddit', status: 'miss', text: 'no Reddit draft emailed' }
        : { kind: 'reddit', status: 'pending', text: `Reddit draft not due until ${dueText}` });
    }
  }
  return out;
}

/**
 * One show's line and its misses.
 * @returns {{verdict:'PASS'|'FAIL'|'UNKNOWN'|'PENDING', line:string, misses:{key,kind,text}[]}}
 */
function buildShowLine({ title, reviews, emails = [] }) {
  if (!reviews.finalized) {
    return { verdict: reviews.verdict, line: `${title}: not graded${reviews.verdict === 'PENDING' ? ' yet' : ''}, ${reviews.why}.`, misses: [] };
  }
  const parts = [];
  const misses = [];
  const items = reviews.items;
  const by = etTime(new Date(Date.parse(reviews.embargoAt) + 2 * 3600000).toISOString());
  if (items.length) {
    const ontime = items.filter((i) => i.status === 'ontime').length;
    parts.push(`${ontime} of ${plural(items.length, 'review', 'reviews')} live by ${by}`);
  }
  if (reviews.release) {
    parts.push(`reviews came out at ${etTime(reviews.release.observedAt)}, not the expected ${etTime(reviews.release.assumedAt)}, so they were timed from ${etTime(reviews.release.observedAt)}`);
  }
  const name = (i) => (i.critic && items.filter((x) => x.outletId === i.outletId).length > 1 ? `${outletName(i)} (${i.critic})` : outletName(i));
  for (const i of items) {
    if (i.status === 'late') {
      parts.push(`${name(i)} went live at ${etTime(i.liveAt)} (late)`);
      misses.push({ key: `review:${i.outletId}:${i.critic || ''}`, kind: 'review', text: `${name(i)} went live at ${etTime(i.liveAt)} ET, after the ${by} mark${i.seenAt ? ` (we had the review at ${etTime(i.seenAt)})` : ''}` });
    } else if (i.status === 'missing') {
      const until = reviews.lastCheckedAt ? ` by ${etTime(reviews.lastCheckedAt)}` : '';
      parts.push(`${name(i)} not live${until}`);
      misses.push({ key: `review:${i.outletId}:${i.critic || ''}`, kind: 'review', text: `${name(i)} was not live${until} ET${i.seenAt ? ` (we had the review at ${etTime(i.seenAt)})` : ' (listed by the aggregators)'}` });
    } else if (i.status === 'pending') {
      parts.push(`${name(i)} not checked yet`);
    }
  }
  const fl = reviews.firstLive;
  if (fl && fl.failed && !misses.length) {
    parts.push(`the first review was not live until ${etTime(fl.at)} (${fl.afterMin} min after release)`);
    misses.push({ key: 'review:first-live', kind: 'review', text: `the first review (${fl.outlet || 'unknown outlet'}) was not live until ${etTime(fl.at)} ET, ${fl.afterMin} min after release` });
  } else if (fl && fl.failed) {
    parts.push(`the first review was not live until ${etTime(fl.at)} (${fl.afterMin} min after release)`);
  }
  if (reviews.verdict === 'FAIL' && !misses.length) {
    // A failing gate with nothing named above (a dropped review, a short census): never a silent pass.
    misses.push({ key: 'review:other', kind: 'review', text: 'the press-night record failed (node scripts/press-night-record.js --check names the gate)' });
  }
  for (const e of emails) {
    if (e.status === 'ok') continue;
    parts.push(e.text);
    if (e.status === 'miss') misses.push({ key: `email:${e.kind}`, kind: 'email', text: e.text });
  }
  if (emails.length && emails.every((e) => e.status === 'ok')) parts.push('emails ready');
  const body = `${title}: ${parts.join('; ') || 'no reviews held to the night'}`;
  if (misses.length) return { verdict: 'FAIL', line: `${body}. Failed.`, misses };
  if (reviews.verdict === 'UNKNOWN') {
    return { verdict: 'UNKNOWN', line: parts.length ? `${body}. Not graded: ${reviews.why}.` : `${title}: not graded, ${reviews.why}.`, misses };
  }
  return { verdict: 'PASS', line: `${body}, passed.`, misses };
}

/**
 * Every show with a press night on `night`: one entry per record, plus the probed-market shows with none.
 * @param {object} p
 * @param {{showId, rec}[]} p.records
 * @param {object[]} p.shows          shows.json rows
 */
function buildSection({ night, records, shows, sentShows = {}, redditDrafts = {}, readNumbers, nowMs }) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const seen = new Set();
  const entries = [];
  const add = (showId, rec) => {
    if (seen.has(showId)) return;
    seen.add(showId);
    const show = byId.get(showId) || { id: showId, title: showId, category: rec && rec.market, openingDate: night };
    const reviews = gradeReviews(rec, nowMs);
    const emails = reviews.finalized ? gradeEmails({ show, sentShows, redditDraft: redditDrafts[showId] || null, readNumbers, nowMs }) : [];
    const { verdict, line, misses } = buildShowLine({ title: show.title || showId, reviews, emails });
    entries.push({ showId, night, title: show.title || showId, verdict, line, misses });
  };
  for (const { showId, rec } of records) add(showId, rec);
  for (const s of shows) if (s.openingDate === night && (s.category === 'broadway' || s.category === 'west-end')) add(s.id, null);
  const rank = { FAIL: 0, UNKNOWN: 1, PENDING: 2, PASS: 3 };
  entries.sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.title.localeCompare(b.title));
  return { generatedAt: new Date(nowMs).toISOString(), night, entries };
}

// ── Fix cards ────────────────────────────────────────────────────────────────

function cardTitle(entry, priority) {
  return `P${priority}: Opening night miss: ${entry.title} (${entry.night})`;
}

const KEY_LINE_PREFIX = 'press-night-card-key: ';
const MISS_LINE_PREFIX = 'press-night-miss: ';

/** The show-night key a card's description carries (its first key line), or null. */
function cardKeyOf(description) {
  const m = new RegExp(`^${KEY_LINE_PREFIX}(.+)$`, 'm').exec(String(description || ''));
  return m ? m[1].trim() : null;
}

/** Miss keys already written on a card (description and comments). */
function listedMisses(texts) {
  const out = new Set();
  const re = new RegExp(`^${MISS_LINE_PREFIX}(.+)$`, 'gm');
  for (const t of texts) for (const m of String(t || '').matchAll(re)) out.add(m[1].trim());
  return out;
}

function cardNotes(entry, misses) {
  return [
    `The morning-email grade for ${entry.title} (show ${entry.showId}, press night ${entry.night}) failed (BRO-6645).`,
    '',
    `Line in the email: ${entry.line}`,
    '',
    'Misses:',
    ...misses.map((m) => `- ${m.text}`),
    '',
    'Find why each one happened and fix the cause, not just this show.',
    `Reviews: node scripts/press-night-record.js --show=${entry.showId} --night=${entry.night} --check (record data/audit/press-night/${entry.showId}-${entry.night}.json).`,
    'Email drafts: data/opening-night-sent.json (Resend draft, scripts/lib/broadcast-refresh.js) and data/audit/reddit-post-drafts.json (Reddit).',
    '',
    `${KEY_LINE_PREFIX}${entry.showId}|${entry.night}`,
    ...misses.map((m) => `${MISS_LINE_PREFIX}${m.key}`),
    '',
    '## Acceptance criteria',
    '- The cause of each miss above is fixed, so the next opening does not repeat it.',
    `VERIFY: node scripts/press-night-record.js --show=${entry.showId} --night=${entry.night} --check --json`,
  ].join('\n');
}

/**
 * File one card per show-night with misses; on a later run, comment only the misses the card does not list.
 * Linear is the record (no ledger file): every card carries a "press-night-card-key: show|night" line and one
 * "press-night-miss: <key>" line per miss, in its description or a later comment. lookupCard finds the card
 * in any state (a closed card is never re-filed), as auto-fix-first does with its key line.
 * @param {object} p
 * @param {object} p.section       buildSection output
 * @param {function} p.lookupCard  (key) -> Promise<{identifier, description, comments: string[]} | null>
 * @param {function} p.createCard  ({title, notes, priority}) -> Promise<identifier>
 * @param {function} p.commentCard (card, text) -> Promise<void>
 * @returns {Promise<{filed:string[], commented:string[], skipped:string[], errors:string[]}>}
 */
async function fileFixCards({ section, lookupCard, createCard, commentCard }) {
  const res = { filed: [], commented: [], skipped: [], errors: [] };
  for (const entry of section.entries) {
    if (!entry.misses.length) continue;
    const key = `${entry.showId}|${entry.night}`;
    try {
      const card = await lookupCard(key);
      if (!card) {
        const priority = entry.misses.some((m) => m.kind === 'review') ? 1 : 2;
        await createCard({ title: cardTitle(entry, priority), notes: cardNotes(entry, entry.misses), priority });
        res.filed.push(key);
        continue;
      }
      const known = listedMisses([card.description, ...(card.comments || [])]);
      const fresh = entry.misses.filter((m) => !known.has(m.key));
      if (!fresh.length) { res.skipped.push(key); continue; }
      await commentCard(card, [
        `New misses found for ${entry.title} (${entry.night}) since this card was filed:`,
        ...fresh.map((m) => `- ${m.text}`),
        '',
        `Line in the email now: ${entry.line}`,
        '',
        ...fresh.map((m) => `${MISS_LINE_PREFIX}${m.key}`),
      ].join('\n'));
      res.commented.push(key);
    } catch (e) {
      res.errors.push(`${key}: ${e.message}`);
    }
  }
  return res;
}

// ── Morning email block ──────────────────────────────────────────────────────

const defaultEsc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Each line already ends in its verdict, so the marker is only a colored dot.
const DOT = { PASS: '#15803d', FAIL: '#b91c1c', UNKNOWN: '#999', PENDING: '#999' };

/**
 * "Last night's openings" for send-morning-digest.js, from the press-night-digest snapshot. Renders nothing on
 * a night with no openings, or when the snapshot is about an older night than the email's last night.
 */
function renderPressNightBlock(snapshot, { esc = defaultEsc, nowMs = Date.now() } = {}) {
  if (!snapshot || !Array.isArray(snapshot.lines) || !snapshot.lines.length) return '';
  if (snapshot.night !== lastNight(nowMs)) return '';
  const rows = snapshot.lines.map((l) => {
    return `<div style="margin:0 0 8px;font-size:14px;"><span style="color:${DOT[l.verdict] || DOT.UNKNOWN};">&#9679;</span> ${esc(l.line)}</div>`;
  }).join('\n');
  return `<div style="margin:0 0 16px;">
    <p style="font-size:14px;font-weight:700;margin:0 0 8px;">Last night's openings</p>
    ${rows}
  </div>`;
}

module.exports = {
  etTime, etDate, lastNight, gradeReviews, gradeEmails, buildShowLine, buildSection,
  KEY_LINE_PREFIX, MISS_LINE_PREFIX, cardKeyOf, listedMisses,
  cardTitle, cardNotes, fileFixCards, outletName, renderPressNightBlock,
};
