'use strict';
/**
 * BRO-6645: one plain-English grade per opening night for the owner's morning email, and the fix cards its
 * misses file. Pure: every input (records, trackers, the clock, the card filer) is passed in.
 *
 * Reviews come from the press-night record (scripts/lib/press-night-record.js evaluateCheck), graded on the
 * observed release when the record has one (BRO-6614). Emails come from the opening-night tracker
 * (opening-night-sent.json, BRO-6634 keeps drafts current) and the Reddit drafts file. They are only due the
 * day after opening (the draft deadline, scripts/lib/broadcast-deadline.js), so a night is shown for 48h: the
 * first morning grades the reviews and says when the emails are due, the second grades the emails too.
 *
 * Times are Eastern (the owner's clock), whatever the market.
 */

const { evaluateCheck } = require('./press-night-record');
const { draftDeadlineAt } = require('./broadcast-deadline');
const { isUnsentDraft, draftBaseline, draftChanged } = require('./broadcast-refresh');
const { MIN_REVIEWS, emailedNumbers } = require('./reddit-opening-post');

const HOUR = 3600000;
const WINDOW_H = 48;
// Emails are graded this long after the draft deadline: the hourly Reddit and broadcast runs land minutes to an
// hour late, and a grade must not fail a draft that is on its way.
const EMAIL_GRACE_H = 2;
const EMAIL_MARKETS = new Set(['broadway', 'west-end']);
const LEDGER_VERSION = 1;
// First press night the filer files cards for (BRO-6645 landed 2026-10-30).
const FILE_FROM = '2026-10-30';

const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true });
/** 2026-10-30T05:24:12Z -> "1:24am" (Eastern). */
function etClock(iso) {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return ET.format(new Date(ms)).replace(/\s?([AP])M$/i, (_, a) => `${a.toLowerCase()}m`);
}

function humanizeId(id) {
  return String(id).split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/** "a, b and c" */
function joinAnd(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function gateOf(result, name) {
  return (result && result.gates || []).find((g) => g.name === name) || null;
}

/** True when nothing shows any outlet published that night (no live review, no census, no lane discovery). */
function nothingPublished(rec) {
  if (!rec) return false;
  if ((rec.liveCount || 0) > 0 || (rec.perReview || []).length > 0) return false;
  const refs = Object.values(rec.reference || {});
  if (refs.some((r) => r && r.count > 0)) return false;
  return !(rec.laneShadow && rec.laneShadow.firstDiscoveredAt);
}

/**
 * The reviews half of a line. Uses the observed-release grade when the record has one.
 * @param {object|null} rec  press-night record
 * @param {{outletName?: (id: string) => string, gates?: object}} [opts]  gates: bar overrides for evaluateCheck
 * @returns {{verdict: 'PASS'|'FAIL'|'UNKNOWN', text: string, misses: {key: string, text: string}[]}}
 */
function reviewGrade(rec, { outletName = humanizeId, gates = {} } = {}) {
  if (!rec) return { verdict: 'UNKNOWN', text: 'the overnight review check did not run, so reviews could not be graded', misses: [] };
  const full = evaluateCheck(rec, gates);
  const rel = full.release || null;
  const result = rel ? rel.observed : full;
  const parts = [];
  const misses = [];
  if (rel) parts.push(`reviews came out at ${etClock(rel.observedAt)}, not ${etClock(rel.assumedAt)} as assumed`);

  if (result.verdict === 'UNKNOWN' && nothingPublished(rec)) {
    return { verdict: 'UNKNOWN', text: 'no reviews came out overnight, so there was nothing to grade', misses: [] };
  }

  const sn = gateOf(result, 'same-night-completeness');
  const facts = sn && sn.facts;
  const nameOf = (m) => (m.outlet && m.outlet !== m.outletId ? m.outlet : outletName(m.outletId));
  if (facts && facts.outlets.length) {
    const lateOrMissing = facts.misses.filter((m) => m.phase === '2h');
    const live = facts.outlets.length - lateOrMissing.length;
    parts.push(`${live} of ${facts.outlets.length} reviews live by ${etClock(facts.deadlineAt)}`);
    const said = facts.misses.map((m) => {
      const name = nameOf(m);
      const text = m.liveAt
        ? `${name} went live at ${etClock(m.liveAt)} (late)`
        : `${name} still not live when the check ended${facts.probeEndAt ? ` at ${etClock(facts.probeEndAt)}` : ''}`;
      misses.push({ key: `review:${m.outletId}`, text });
      return text;
    });
    if (said.length) parts.push(said.join(', '));
  } else {
    // No review-file snapshot: fall back to the aggregator list at +2h.
    const cov = gateOf(result, 'coverage-2h');
    const ref2 = rec.reference && rec.reference['2h'];
    if (cov && cov.status !== 'unknown' && ref2 && ref2.count) {
      parts.push(`${ref2.covered} of ${ref2.count} listed reviews live 2 hours after release`);
      for (const id of ref2.missing || []) {
        const text = `${outletName(id)} not live by then`;
        misses.push({ key: `review:${id}`, text });
        parts.push(text);
      }
    }
  }

  const fl = gateOf(result, 'first-live');
  if (fl && fl.status === 'fail' && fl.facts) {
    const f = fl.facts;
    const text = f.noneLiveMin != null
      ? `no review was live ${f.noneLiveMin} minutes after release (limit ${f.bar})`
      : `the first review took ${f.minLow === f.minHigh ? f.minHigh : `${f.minLow} to ${f.minHigh}`} minutes to go live (limit ${f.bar})`;
    misses.push({ key: 'review:first-live', text });
    parts.push(text);
  }
  const st = gateOf(result, 'stability');
  if (st && st.status === 'fail') {
    const text = 'a review dropped off the page after going live';
    misses.push({ key: 'review:dropped', text });
    parts.push(text);
  }
  if (result.verdict === 'FAIL' && !misses.length) {
    // A required gate failed without a structured miss: never print a FAIL with no reason.
    const failed = result.gates.filter((g) => g.required && g.status === 'fail').map((g) => g.name);
    const text = `the overnight check failed (${failed.join(', ')})`;
    misses.push({ key: `review:${failed.join('+')}`, text });
    parts.push(text);
  }
  if (result.verdict === 'UNKNOWN') parts.push('not every check could be measured');
  return { verdict: result.verdict, text: parts.join('; '), misses };
}

/**
 * The email half of a line: the opening-night email draft (Broadway and West End only) and the Reddit draft.
 * Not graded before the draft deadline plus EMAIL_GRACE_H.
 * @returns {{status: 'ok'|'miss'|'pending'|'unknown'|'none', text: string, misses: {key: string, text: string}[]}}
 */
function emailGrade({ show, sentShows = null, redditDrafts = {}, numbersNow = null, readNumbers = () => null, nowMs }) {
  const market = show.category || 'broadway';
  const deadline = draftDeadlineAt(show.openingDate);
  const dueMs = deadline ? deadline.getTime() + EMAIL_GRACE_H * HOUR : null;
  const wantsBroadcast = EMAIL_MARKETS.has(market);
  const minReddit = MIN_REVIEWS[market];
  const reviewCount = numbersNow && Number.isFinite(numbersNow.reviewCount) ? numbersNow.reviewCount : null;
  // Reddit is owed for Broadway and West End once the show has the review count the drafter waits for.
  const wantsReddit = wantsBroadcast && minReddit != null && reviewCount != null && reviewCount >= minReddit;
  if (!wantsBroadcast) return { status: 'none', text: '', misses: [] };
  if (dueMs == null || nowMs < dueMs) {
    return { status: 'pending', text: dueMs == null ? '' : `emails due by ${etClock(dueMs)} today`, misses: [] };
  }
  // No tracker (core-data checkout failed): unknown, never "no draft was made".
  if (!sentShows) return { status: 'unknown', text: 'emails could not be checked (the email tracker was not readable)', misses: [] };
  const misses = [];
  const ok = [];
  const fmt = (n) => (n && n.score != null ? `score ${n.score}, ${n.reviewCount} reviews` : null);

  const rec = findBroadcastRecord(sentShows, show.id);
  if (!rec) {
    misses.push({ key: 'email:broadcast-missing', text: 'no opening-night email draft was made' });
  } else if (rec.record.sentAt) {
    ok.push('opening-night email sent');
  } else if (rec.record.discardedAt) {
    ok.push('opening-night email draft discarded on purpose');
  } else if (isUnsentDraft(rec.record)) {
    const was = draftBaseline(sentShows, rec);
    const now = {};
    for (const id of rec.ids) now[id] = id === show.id ? numbersNow : readNumbers(id);
    const complete = rec.ids.every((id) => now[id] && now[id].reviewCount != null);
    if (complete && draftChanged(was, now, rec.record)) {
      const wasTxt = was && fmt(was[show.id]);
      misses.push({ key: 'email:broadcast-stale', text: `the opening-night email draft is out of date${wasTxt ? ` (it says ${wasTxt}, the site says ${fmt(numbersNow)})` : ''}` });
    } else ok.push(`opening-night email draft ready${numbersNow && numbersNow.score != null ? ` at ${numbersNow.score}` : ''}`);
  } else {
    misses.push({ key: 'email:broadcast-missing', text: 'no opening-night email draft was made' });
  }

  const d = redditDrafts[show.id];
  if (wantsReddit) {
    if (!d || !d.emailedAt) {
      misses.push({ key: 'email:reddit-missing', text: 'the Reddit draft was not emailed' });
    } else {
      const was = emailedNumbers(d);
      if (numbersNow && (was.score !== numbersNow.score || was.reviewCount !== numbersNow.reviewCount)) {
        misses.push({ key: 'email:reddit-stale', text: `the Reddit draft is out of date (it says ${fmt(was)}, the site says ${fmt(numbersNow)})` });
      } else ok.push('Reddit draft emailed');
    }
  }
  const text = [...ok, ...misses.map((m) => m.text)].join(', ');
  return { status: misses.length ? 'miss' : 'ok', text, misses };
}

/**
 * The tracker record (keyed `<market>:<id+id>`) whose draft covers this show. Per-show mirrors point at it
 * through broadcastKey. Returns {broadcastKey, market, ids, record} or null.
 */
function findBroadcastRecord(sentShows, showId) {
  const asEntry = (key) => {
    const r = sentShows[key];
    if (!r || !key.includes(':')) return null;
    const i = key.indexOf(':');
    return { broadcastKey: key, market: key.slice(0, i), ids: key.slice(i + 1).split('+').filter(Boolean), record: r };
  };
  const mirror = sentShows[showId];
  if (mirror && mirror.broadcastKey && sentShows[mirror.broadcastKey]) return asEntry(mirror.broadcastKey);
  for (const key of Object.keys(sentShows)) {
    if (key.startsWith('preview:') || key.startsWith('push:') || key.startsWith('overdue-alert:')) continue;
    const e = asEntry(key);
    if (e && !e.record.broadcastKey && e.ids.includes(showId)) return e;
  }
  return null;
}

/**
 * One line per show whose press night (the record's embargo, else opening date) is in the last 48h.
 * @param {object} p
 * @param {object[]} p.shows            shows.json entries
 * @param {(id: string, night: string) => object|null} p.readRecord
 * @param {(id: string) => ({score, reviewCount}|null)} p.readNumbers
 * @param {object|null} [p.sentShows]   opening-night-sent.json `shows`; null when unreadable (emails then ungraded)
 * @param {object} [p.redditDrafts]     reddit-post-drafts.json `drafts`
 * @param {number} p.nowMs
 * @param {(id: string) => string} [p.outletName]
 */
function gradeOpenings({ shows, readRecord, readNumbers, sentShows = null, redditDrafts = {}, nowMs, outletName }) {
  const out = [];
  const fromYmd = new Date(nowMs - (WINDOW_H + 24) * HOUR).toISOString().slice(0, 10);
  const toYmd = new Date(nowMs).toISOString().slice(0, 10);
  for (const show of shows) {
    const night = show.openingDate;
    if (!show.id || typeof night !== 'string' || night < fromYmd || night > toYmd) continue;
    if (show.category === 'tour') continue; // a tour's first stop is no press night (BRO-4724)
    const rec = readRecord(show.id, night);
    const embargoMs = rec && Date.parse(rec.embargoAt);
    // Without a record the opening date stands in (its evening is the press night).
    const nightMs = Number.isFinite(embargoMs) ? embargoMs : Date.parse(`${night}T23:59:00Z`);
    if (nightMs > nowMs || nowMs - nightMs > WINDOW_H * HOUR) continue;
    out.push(gradeShow({ show, rec, numbersNow: readNumbers(show.id), readNumbers, sentShows, redditDrafts, nowMs, outletName }));
  }
  return out.sort((a, b) => (a.night === b.night ? a.title.localeCompare(b.title) : (a.night < b.night ? 1 : -1)));
}

/** One show-night: the sentence and the misses behind it. */
function gradeShow({ show, rec, numbersNow, readNumbers = () => null, sentShows, redditDrafts, nowMs, outletName }) {
  const rv = reviewGrade(rec, { outletName });
  const em = emailGrade({ show, sentShows, redditDrafts, numbersNow, readNumbers, nowMs });
  let verdict = rv.verdict;
  if (em.status === 'miss') verdict = 'FAIL';
  const word = verdict === 'PASS' ? 'Passed.' : (verdict === 'FAIL' ? 'Failed.' : 'Not graded.');
  const body = [rv.text, em.text].filter(Boolean).join('; ');
  const title = show.title || humanizeId(show.id);
  return {
    showId: show.id, night: show.openingDate, title, verdict,
    line: `${title}: ${body ? `${body[0].toUpperCase()}${body.slice(1)}. ` : ''}${word}`,
    emails: em.status,
    misses: [...rv.misses, ...em.misses],
  };
}

// ---- auto-filed fix cards -------------------------------------------------------------------------------

function emptyLedger() {
  return { version: LEDGER_VERSION, filed: {} };
}

/**
 * Card actions for the graded lines. One card per show-night: the first run with a miss creates it, a later
 * run that finds misses the card does not list yet comments them on it once. A show-night already in the
 * ledger never gets a second card. P1 when a review was missing or late, P2 when only email drafts missed.
 * @returns {({type:'create', key, title, priority, notes, missKeys} | {type:'comment', key, card, text, missKeys})[]}
 */
function planFiling(entries, ledger, { fileFrom = FILE_FROM } = {}) {
  const filed = (ledger && ledger.filed) || {};
  const actions = [];
  for (const e of entries) {
    if (!e.misses.length) continue;
    const key = `${e.showId}:${e.night}`;
    const prior = filed[key];
    // Nights before the filer existed were graded by hand and already have their cards (BRO-6614, BRO-6634).
    if (e.night < fileFrom) continue;
    const fresh = e.misses.filter((m) => !(prior && (prior.missKeys || []).includes(m.key)));
    if (!fresh.length) continue;
    const list = fresh.map((m) => `- ${m.text}`).join('\n');
    if (!prior) {
      const reviewMiss = e.misses.some((m) => m.key.startsWith('review:'));
      actions.push({
        type: 'create', key, missKeys: fresh.map((m) => m.key),
        priority: reviewMiss ? 1 : 2,
        title: `Opening night missed: ${e.title} (${e.night})`,
        notes: [
          `The morning-email grade for ${e.title}'s press night on ${e.night} failed. Find why each item below`,
          'missed and fix the cause so the next opening does not repeat it.',
          '',
          `Owner's line: ${e.line}`,
          '',
          'Misses:',
          list,
          '',
          `press-night-grade-key: ${key}`,
          '',
          '## Acceptance criteria',
          `- The cause of each miss is fixed in code, with a test.`,
          `- VERIFY: node scripts/press-night-record.js --show=${e.showId} --night=${e.night} --check`,
        ].join('\n'),
      });
    } else {
      actions.push({ type: 'comment', key, card: prior.card, missKeys: fresh.map((m) => m.key), text: `More misses for this show-night from the morning-email grade:\n${list}` });
    }
  }
  return actions;
}

/**
 * Runs the planned actions through `fileCard` / `commentCard` and records each in the ledger as soon as it
 * succeeds, so a crash part way never re-files the actions already done. Returns the new ledger.
 * @param {Function} fileCard     ({title, priority, notes}) => Promise<string>  card identifier
 * @param {Function} commentCard  (card, text) => Promise<void>
 * @param {Function} [save]       (ledger) => void, called after each action
 */
async function applyFiling(actions, ledger, { fileCard, commentCard, save = () => {}, nowIso = new Date().toISOString() }) {
  const next = { ...emptyLedger(), ...(ledger || {}), filed: { ...((ledger && ledger.filed) || {}) } };
  const results = [];
  for (const a of actions) {
    try {
      if (a.type === 'create') {
        const card = await fileCard({ title: a.title, priority: a.priority, notes: a.notes });
        next.filed[a.key] = { card, filedAt: nowIso, priority: a.priority, missKeys: a.missKeys };
      } else {
        await commentCard(a.card, a.text);
        const prev = next.filed[a.key];
        next.filed[a.key] = { ...prev, missKeys: [...new Set([...(prev.missKeys || []), ...a.missKeys])], updatedAt: nowIso };
      }
      save(next);
      results.push({ ...a, ok: true, card: next.filed[a.key].card });
    } catch (err) {
      results.push({ ...a, ok: false, error: String(err && err.message || err).slice(0, 200) });
    }
  }
  return { ledger: next, results };
}

module.exports = {
  WINDOW_H, EMAIL_GRACE_H, FILE_FROM, etClock, humanizeId, joinAnd, nothingPublished, reviewGrade, emailGrade,
  findBroadcastRecord, gradeOpenings, gradeShow, emptyLedger, planFiling, applyFiling,
};
