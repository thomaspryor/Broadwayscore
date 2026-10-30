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

const { evaluateCheck, observedRecord, sameNightCheck, firstNightLive, DEFAULT_GATES, publishPath, nightManualActions } = require('./press-night-record');
const { draftBaseline, draftChanged } = require('./broadcast-refresh');
const { draftDeadlineAt } = require('./broadcast-deadline');
const { SUBREDDIT_BY_MARKET, MIN_REVIEWS, emailedNumbers } = require('./reddit-opening-post');
const { getOutletDisplayName } = require('./review-normalization');
const { classifyShowBroadcastState } = require('./missed-broadcasts');
const { getConfidenceFloors } = require('./score-confidence-gate');
const { foldDiacritics } = require('./title-match');
// Time helpers and the email block live in a module with no package imports: the morning-email job runs
// without npm ci (tests/unit/morning-digest-action.test.mjs), and this file reaches the scraper.
const { etTime, etDate, lastNight, renderPressNightBlock, scoreboardLine } = require('./press-night-digest-render');

const BROADCAST_MARKETS = new Set(['broadway', 'west-end']);
const MIN = 60000;

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
    // The probe runs to +6h in two jobs (early to +2h, late from that checkpoint), so a quiet record between
    // them is normal. Past +7h with no end it is not coming back (a cancelled or timed-out job).
    const embargo = Date.parse(rec.embargoAt || '');
    const last = Date.parse((rec.probe && (rec.probe.lastSampleAt || rec.probe.startedAt)) || '');
    const abandoned = Number.isFinite(embargo) ? nowMs > embargo + 7 * 60 * MIN : Number.isFinite(last) && nowMs - last > 60 * MIN;
    if (abandoned) return { verdict: 'UNKNOWN', finalized: false, why: 'the overnight check stopped before it finished', items: [] };
    return { verdict: 'PENDING', finalized: false, why: 'still being checked', items: [] };
  }
  const result = evaluateCheck(rec);
  const rel = result.release || null;
  const graded = rel ? observedRecord(rec, rel) : rec;
  const gates = rel ? rel.observed.gates : result.gates;
  const rawVerdict = rel ? rel.observed.verdict : result.verdict;
  const sn = sameNightCheck(graded, DEFAULT_GATES);
  const fl = firstNightLive(graded);
  const firstGate = gates.find((g) => g.name === 'first-live');
  const items = annotateQueued(sn.items || [], graded);
  let verdict = rawVerdict;
  if (verdict === 'FAIL' && onlyPaywalledCauses(items, graded)
    && gates.every((g) => !g.required || g.status !== 'fail' || ITEM_GATES.has(g.name))) {
    // The only failures were paywalled outlets: excused, so the night grades on its other gates.
    verdict = gates.some((g) => g.required && g.status === 'unknown') ? 'UNKNOWN' : 'PASS';
  }
  let why = null;
  if (verdict === 'UNKNOWN') {
    const noPublish = firstGate && firstGate.status === 'unknown' && /no census or lane discovery shows any outlet published/.test(firstGate.detail);
    why = noPublish ? 'no reviews were published overnight'
      : `could not check ${gates.filter((g) => g.required && g.status === 'unknown').map((g) => GATE_WORDS[g.name] || g.name).join(' or ')}`;
  }
  return {
    verdict, finalized: true, release: rel, embargoAt: graded.embargoAt, items,
    publishedBy: publishPath(rec), manualActions: nightManualActions(rec),
    firstLive: fl ? { at: fl.at, outlet: fl.outlet, afterMin: Math.round((Date.parse(fl.at) - Date.parse(graded.embargoAt)) / MIN), failed: !!(firstGate && firstGate.status === 'fail') } : null,
    lastCheckedAt: rec.probe.lastOkSampleAt || null, why,
  };
}

// Owner decision 2026-10-30 ("Ignore NYT"): a hard-paywalled outlet passes once it is listed or queued.
// Its full text may never come through, so it never fails a night or shows as a miss. Mirrors the
// domains in paywall-completeness.js HARD_PAYWALL_FLOORS, keyed by outlet id.
// BRO-6652 (card item 3b): "queued" means queued on time. The excuse holds only when the review was queued
// (its review-text file first seen, or on a lane night the lane's 'discovered' row) by the +2h mark. A
// paywalled outlet that was never queued is a miss like any other.
const PAYWALLED_OUTLETS = new Set(['nytimes', 'newyorker', 'washpost', 'washingtonpost', 'chicagotribune', 'wsj']);
const QUEUE_BY_MIN = 120;
const isPaywallExcused = (i) => !!i.paywallExcused;

/** When the pipeline queued this outlet's review: its file's first-seen time, else the lane's discovery on a lane night. */
function queuedAtFor(outletId, item, rec) {
  if (item && item.seenAt) return item.seenAt;
  const files = (rec.fileState && rec.fileState.files) || [];
  const seen = files.filter((f) => f.outletId === outletId && f.includable && f.firstSeenAt).map((f) => f.firstSeenAt).sort()[0];
  if (seen) return seen;
  const lane = publishPath(rec) === 'lane' && rec.laneShadow && rec.laneShadow.discoveredByOutlet;
  return (lane && lane[outletId]) || null;
}

const queuedOnTime = (at, rec) => Date.parse(at || '') <= Date.parse(rec.embargoAt) + QUEUE_BY_MIN * MIN;

/** Items with queuedAt, and paywallExcused for a late or missing paywalled review queued on time. Pure. */
function annotateQueued(items, rec) {
  return items.map((i) => {
    const queuedAt = queuedAtFor(i.outletId, i, rec);
    const paywallExcused = PAYWALLED_OUTLETS.has(i.outletId) && (i.status === 'late' || i.status === 'missing') && queuedOnTime(queuedAt, rec);
    return { ...i, queuedAt, ...(paywallExcused ? { paywallExcused } : {}) };
  });
}

// The item gates (same-night-completeness, coverage-2h) fail on late or missing reviews and on census outlets
// listed but not live (missing or suppressed). They are excused only when every one of those outlets is
// paywalled and was queued on time.
const ITEM_GATES = new Set(['same-night-completeness', 'coverage-2h']);
function onlyPaywalledCauses(items, rec) {
  const ref2 = (rec.reference && rec.reference['2h']) || {};
  const causes = [
    ...items.filter((i) => i.status === 'late' || i.status === 'missing').map((i) => i.outletId),
    ...(ref2.missing || []), ...(ref2.suppressedMissing || []),
  ];
  const excused = (id) => PAYWALLED_OUTLETS.has(id)
    && queuedOnTime(queuedAtFor(id, items.find((i) => i.outletId === id && i.queuedAt), rec), rec);
  return causes.length > 0 && causes.every(excused);
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
    // One draft can cover several shows; only its first show files the card, so one draft gets one worker.
    const files = ids[0] === id;
    // The tracker's own reading (missed-broadcasts.js): a send seen on any record of the draft is a send,
    // a cancelled draft counts as no draft, a draft Resend no longer lists is ambiguous (often a send).
    const state = classifyShowBroadcastState(sentShows, id);
    if (state === 'sent') out.push({ kind: 'broadcast', status: 'ok', text: 'opening-night email sent' });
    else if (state === 'discarded') out.push({ kind: 'broadcast', status: 'ok', text: 'opening-night email skipped on purpose' });
    else if (state === 'draft-unknown') out.push({ kind: 'broadcast', status: 'pending', text: 'opening-night email draft is no longer in Resend (it may have been sent)' });
    else if (state === 'draft-stuck') {
      const now = {};
      for (const x of ids) now[x] = readNumbers(x);
      const complete = ids.every((x) => now[x] && now[x].reviewCount != null);
      const record = (key && sentShows[key]) || rec;
      const was = draftBaseline(sentShows, { ids, record });
      if (!complete) out.push({ kind: 'broadcast', status: 'pending', text: "could not check the opening-night email draft (the site's numbers could not be read)" });
      else if (draftChanged(was, now, record)) {
        const before = was && was[id] ? was[id] : { score: null, reviewCount: rec.reviewCount };
        const after = before.score == null ? { score: null, reviewCount: live && live.reviewCount } : live;
        const text = `opening-night email draft is out of date (built with ${nums(before)}, the site shows ${nums(after)})`;
        // Before the 10am deadline the refresher still has time; reviews keep landing overnight.
        out.push(due ? { kind: 'broadcast', status: 'miss', text, files } : { kind: 'broadcast', status: 'pending', text });
      } else out.push({ kind: 'broadcast', status: 'ok', text: 'opening-night email draft ready' });
    } else if (!due) out.push({ kind: 'broadcast', status: 'pending', text: `opening-night email draft not due until ${dueText}` });
    else {
      // The draft waits for the broadcast's own review floor (score-confidence-gate.js); below it no draft is
      // owed yet, so the gap is in the reviews, not the email.
      const floor = getConfidenceFloors(market).total;
      const have = (live && live.reviewCount) || 0;
      if (have < floor) out.push({ kind: 'broadcast', status: 'pending', text: `no opening-night email draft yet (the site has ${have} of the ${floor} reviews a draft needs)` });
      else out.push({ kind: 'broadcast', status: 'miss', text: 'no opening-night email draft', files });
    }
  }

  if (SUBREDDIT_BY_MARKET[market]) {
    const d = redditDraft;
    const expected = d || (market !== 'off-west-end' && live && live.reviewCount >= MIN_REVIEWS[market]);
    if (d && d.postedAt) out.push({ kind: 'reddit', status: 'ok', text: 'Reddit post is up' });
    else if (d && d.emailedAt) {
      const was = emailedNumbers(d);
      if (!live || live.reviewCount == null) out.push({ kind: 'reddit', status: 'pending', text: "could not check the Reddit draft (the site's numbers could not be read)" });
      else if (was.score !== live.score || was.reviewCount !== live.reviewCount) {
        // After three update emails the drafter waits 6h before the next (reddit-opening-post.js
        // updateAllowed), so a stale emailed draft only files a card once it outlived that wait.
        out.push({ kind: 'reddit', status: 'miss', graceMin: 7 * 60, text: `Reddit draft emailed to you is out of date (${nums(was)}, the site shows ${nums(live)})` });
      } else out.push({ kind: 'reddit', status: 'ok', text: 'Reddit draft emailed' });
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
function emailParts(emails) {
  const parts = [];
  const misses = [];
  for (const e of emails) {
    if (e.status === 'ok') continue;
    parts.push(e.text);
    if (e.status === 'miss') misses.push({ key: `email:${e.kind}:${/^no /.test(e.text) ? 'missing' : 'stale'}`, kind: 'email', text: e.text, graceMin: e.graceMin, files: e.files !== false });
  }
  if (emails.length && emails.every((e) => e.status === 'ok')) parts.push('emails ready');
  return { parts, misses };
}

function buildShowLine({ title, reviews, emails = [] }) {
  if (!reviews.finalized) {
    // The emails are graded on their own: a stopped probe must not hide a missing draft.
    const em = emailParts(emails);
    const head = `${title}: ${em.misses.length ? 'reviews ' : ''}not graded${reviews.verdict === 'PENDING' ? ' yet' : ''}, ${reviews.why}`;
    if (em.misses.length) return { verdict: 'FAIL', line: `${head}; ${em.parts.join('; ')}. Failed.`, misses: em.misses };
    return { verdict: reviews.verdict, line: `${head}${em.parts.length ? `; ${em.parts.join('; ')}` : ''}.`, misses: [] };
  }
  const parts = [];
  const misses = [];
  // BRO-6652: say which path published the night, and any hand fix (it keeps the night off "on their own").
  const lead = [reviews.publishedBy === 'lane' ? 'published by the new lane' : 'published by the regular pipeline'];
  for (const m of reviews.manualActions || []) {
    lead.push(`${m.outlet || (m.outletId ? outletName({ outletId: m.outletId }) : 'a review')} fixed by hand at ${etTime(m.at)}`);
  }
  const items = reviews.items.filter((i) => !isPaywallExcused(i));
  const by = etTime(new Date(Date.parse(reviews.embargoAt) + 2 * 3600000).toISOString());
  const byMs = Date.parse(reviews.embargoAt) + 2 * 3600000;
  // A review that came out later in the night counts as on time when it went live within 30 min of coming
  // out (same-night-completeness), but it was not live by the +2h mark, so it is named, not counted.
  const liveBy = (i) => i.status === 'ontime' && !(Date.parse(i.liveAt || '') > byMs);
  if (items.length) {
    parts.push(`${items.filter(liveBy).length} of ${plural(items.length, 'review', 'reviews')} live by ${by}`);
  }
  if (reviews.release) {
    parts.push(`reviews came out at ${etTime(reviews.release.observedAt)}, not the expected ${etTime(reviews.release.assumedAt)}, so they were timed from ${etTime(reviews.release.observedAt)}`);
  }
  const name = (i) => (i.critic && items.filter((x) => x.outletId === i.outletId).length > 1 ? `${outletName(i)} (${i.critic})` : outletName(i));
  // An excused paywalled review in two parts: listed on time, then when its text was scored (late after +2h).
  for (const i of reviews.items.filter(isPaywallExcused)) {
    // Older records carry no scoredAt: the review going live (the site lists scored reviews only) stands in.
    const at = i.scoredAt || i.liveAt;
    const text = at ? `text scored at ${etTime(at)}${Date.parse(at) > byMs ? ' (late)' : ''}`
      : `text not scored${reviews.lastCheckedAt ? ` by ${etTime(reviews.lastCheckedAt)}` : ' yet'}`;
    parts.push(`${outletName(i)} listed on time, ${text}`);
  }
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
    } else if (!liveBy(i)) {
      parts.push(`${name(i)} came out later and went live at ${etTime(i.liveAt)}, on time`);
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
  const em = emailParts(emails);
  parts.push(...em.parts);
  misses.push(...em.misses);
  const body = `${title}: ${[...lead, ...(parts.length ? parts : ['no reviews held to the night'])].join('; ')}`;
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
    const emails = gradeEmails({ show, sentShows, redditDraft: redditDrafts[showId] || null, readNumbers, nowMs });
    const { verdict, line, misses } = buildShowLine({ title: show.title || showId, reviews, emails });
    entries.push({ showId, night, title: show.title || showId, verdict, line, misses });
  };
  for (const { showId, rec } of records) add(showId, rec);
  for (const s of shows) if (s.openingDate === night && BROADCAST_MARKETS.has(s.category)) add(s.id, null);
  const rank = { FAIL: 0, UNKNOWN: 1, PENDING: 2, PASS: 3 };
  entries.sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.title.localeCompare(b.title));
  return { generatedAt: new Date(nowMs).toISOString(), night, entries };
}

/**
 * BRO-6652: every finished press-night record's reviews grade, counted. "Passed on their own" is a pass
 * with no hand fix in the night window; a record older than the manualActions stamp never counts (nobody
 * logged its fixes), so the count only ever undersells.
 * @param {{showId, rec}[]} records  all records, any night
 * @returns {{graded:number, passed:number, passedOnOwn:number}}
 */
function scoreboard(records, nowMs = Date.now()) {
  const out = { graded: 0, passed: 0, passedOnOwn: 0 };
  for (const { rec } of records) {
    const r = gradeReviews(rec, nowMs);
    if (!r.finalized || r.verdict === 'UNKNOWN' || r.verdict === 'PENDING') continue;
    out.graded += 1;
    if (r.verdict !== 'PASS') continue;
    out.passed += 1;
    // Any logged hand fix rules the night out, inside the night window or not (the card: "excludes any night
    // with manualActions"). A record never stamped (no array) never counts as on its own.
    if (Array.isArray(rec.manualActions) && !rec.manualActions.length) out.passedOnOwn += 1;
  }
  return out;
}

// ── Fix cards ────────────────────────────────────────────────────────────────

function cardTitle(entry, priority) {
  return `P${priority}: Opening night miss: ${entry.title} (${entry.night})`;
}

// The Resend draft refresher and the Reddit drafter both run hourly at :41, so a score or review count that
// moves just after them reads "out of date" (or "no Reddit draft") for up to an hour before they catch up.
// An email miss only files a card once it has been seen for longer than one full cycle plus slack.
const EMAIL_MISS_GRACE_MIN = 75;

/**
 * When each current miss was first seen, carried from the previous run's snapshot.
 * @returns {Object<string,string>} "show|night|missKey" -> ISO time, current misses only
 */
function missFirstSeen(section, previous = {}, nowIso) {
  const out = {};
  for (const e of section.entries) {
    for (const m of e.misses) {
      const k = `${e.showId}|${e.night}|${m.key}`;
      out[k] = (previous && previous[k]) || nowIso;
    }
  }
  return out;
}

/** The section with email misses younger than the grace dropped (review misses come from finished records). */
function settledMisses(section, firstSeen, nowMs, graceMin = EMAIL_MISS_GRACE_MIN) {
  const settled = (e, m) => {
    if (m.kind !== 'email') return true;
    const at = Date.parse(firstSeen[`${e.showId}|${e.night}|${m.key}`]);
    return Number.isFinite(at) && nowMs - at >= (m.graceMin || graceMin) * 60000;
  };
  return { ...section, entries: section.entries.map((e) => ({ ...e, misses: e.misses.filter((m) => settled(e, m)) })) };
}

const KEY_LINE_PREFIX = 'press-night-card-key: ';
const MISS_LINE_PREFIX = 'press-night-miss: ';

// Key and miss lines are written as [a-z0-9-] slugs so Linear's markdown handling can never escape them
// ("|", "_", "*" in a critic's name) and break the match that stops a card being filed twice.
const slug = (k) => foldDiacritics(String(k)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// At most this many new cards per run: a dedupe that stopped matching must not file one per show per hour.
const MAX_NEW_CARDS_PER_RUN = 5;

/** The show-night slug a card's description carries (its first key line), or null. */
function cardKeyOf(description) {
  const m = new RegExp(`^${KEY_LINE_PREFIX}([a-z0-9-]+)`, 'm').exec(String(description || ''));
  return m ? m[1] : null;
}

/** Miss slugs already written on a card (description and comments). */
function listedMisses(texts) {
  const out = new Set();
  const re = new RegExp(`^${MISS_LINE_PREFIX}([a-z0-9-]+)`, 'gm');
  for (const t of texts) for (const m of String(t || '').matchAll(re)) out.add(m[1]);
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
    `${KEY_LINE_PREFIX}${slug(`${entry.showId}|${entry.night}`)}`,
    ...misses.map((m) => `${MISS_LINE_PREFIX}${slug(m.key)}`),
    '',
    '## Acceptance criteria',
    '- The cause of each miss above is fixed, so the next opening does not repeat it.',
    ...(misses.some((m) => m.kind === 'review')
      ? ['- The press-night record is history: its --check keeps failing after the fix. Close with PR-EVIDENCE (merged deployed checked) for the fix and its test.']
      : [`VERIFY: node scripts/produce-press-night-digest-snapshot.js --night=${entry.night} --check=${entry.showId}`]),
  ].join('\n');
}

/**
 * File one card per show-night with misses; on a later run, comment only the misses the card does not list.
 * Linear is the record (no ledger file): every card carries a "press-night-card-key: <show-night slug>" line
 * and one "press-night-miss: <miss slug>" line per miss, in its description or a later comment. lookupCards
 * finds the show-night's cards in any state (closed included), so a listed miss is never filed again. A new
 * miss becomes a comment on the open card, or a new card when every card is closed (a comment on a closed
 * card reaches nobody).
 * @param {object} p
 * @param {object} p.section       buildSection output
 * @param {function} p.lookupCards (keySlug) -> Promise<{identifier, description, comments: string[], completedAt?, canceledAt?}[]>
 * @param {function} p.createCard  ({title, notes, priority}) -> Promise<identifier>
 * @param {function} p.commentCard (card, text) -> Promise<void>
 * @returns {Promise<{filed:string[], commented:string[], skipped:string[], errors:string[]}>}
 */
async function fileFixCards({ section, lookupCards, createCard, commentCard }) {
  const res = { filed: [], commented: [], skipped: [], errors: [] };
  for (const raw of section.entries) {
    const entry = { ...raw, misses: raw.misses.filter((m) => m.files !== false) };
    if (!entry.misses.length) continue;
    const key = `${entry.showId}|${entry.night}`;
    try {
      const cards = await lookupCards(slug(key));
      const known = listedMisses(cards.flatMap((c) => [c.description, ...(c.comments || [])]));
      const fresh = entry.misses.filter((m) => !known.has(slug(m.key)));
      if (!fresh.length) { res.skipped.push(key); continue; }
      const card = cards.find((c) => !c.completedAt && !c.canceledAt);
      if (!card) {
        if (res.filed.length >= MAX_NEW_CARDS_PER_RUN) { res.errors.push(`${key}: not filed, ${MAX_NEW_CARDS_PER_RUN} cards already filed this run`); continue; }
        const priority = fresh.some((m) => m.kind === 'review') ? 1 : 2;
        await createCard({ title: cardTitle(entry, priority), notes: cardNotes(entry, fresh), priority });
        res.filed.push(key);
        continue;
      }
      await commentCard(card, [
        `New misses found for ${entry.title} (${entry.night}) since this card was filed:`,
        ...fresh.map((m) => `- ${m.text}`),
        '',
        `Line in the email now: ${entry.line}`,
        '',
        ...fresh.map((m) => `${MISS_LINE_PREFIX}${slug(m.key)}`),
      ].join('\n'));
      res.commented.push(key);
    } catch (e) {
      res.errors.push(`${key}: ${e.message}`);
    }
  }
  return res;
}

module.exports = {
  etTime, etDate, lastNight, gradeReviews, gradeEmails, buildShowLine, buildSection, scoreboard,
  EMAIL_MISS_GRACE_MIN, missFirstSeen, settledMisses,
  KEY_LINE_PREFIX, MISS_LINE_PREFIX, MAX_NEW_CARDS_PER_RUN, slug, cardKeyOf, listedMisses,
  cardTitle, cardNotes, fileFixCards, outletName, renderPressNightBlock, scoreboardLine, PAYWALLED_OUTLETS,
};
