/**
 * score-call.js (BRO-7350): pure logic shared by the Call the Score UI, the sync loader and tests.
 * No fs, network or clock (callers pass `today`). The forecast itself never lives in this file.
 */
'use strict';

const DAY = 86400000;
const toDay = (iso) => {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const t = Date.parse(iso.slice(0, 10) + 'T00:00:00Z');
  return Number.isFinite(t) ? Math.floor(t / DAY) : null;
};

const PREVIEW_LOOKAHEAD_DAYS = 60;

/** Same rule as the pilot target predicate in scripts/lib (a unit test pins them together): a show a reader can call. */
function isCallableShow(show, today) {
  if (!show || show.category !== 'broadway') return false;
  if (show.type !== 'play' && show.type !== 'musical') return false;
  if (show.cancelledBeforeOpening || show.status === 'closed') return false;
  const open = toDay(show.openingDate);
  const t = toDay(today);
  if (open == null || t == null || !(open > t)) return false;
  if (show.status === 'previews') return true;
  const prev = toDay(show.previewsStartDate || show.previewDate);
  return prev != null && prev <= t + PREVIEW_LOOKAHEAD_DAYS;
}

/** Integer 0-100 or null. Rejects NaN, floats, strings of text. */
function parseCall(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
}

/** Strip model once the show has a Critic Score. forecast may be null. */
function resultStrip({ called, forecast, critic }) {
  if (!Number.isInteger(called) || !Number.isFinite(critic)) return null;
  const off = Math.abs(Math.round(critic) - called);
  const hasF = Number.isFinite(forecast);
  const forecastMiss = hasF ? Math.abs(Math.round(critic) - forecast) : null;
  return { off, forecastMiss, beatForecast: hasF ? off < forecastMiss : false, critic: Math.round(critic) };
}

const pts = (n) => `${n} ${n === 1 ? 'point' : 'points'}`;

const hasRange = (lo, hi) => Number.isFinite(lo) && Number.isFinite(hi);

/** Caption under the "Our forecast" tile: { word: 'likely', nums: '63 to 77' } (the UI brightens nums), or null with no range. */
function rangeCaption({ lo50, hi50 }) {
  return hasRange(lo50, hi50) ? { word: 'likely', nums: `${lo50} to ${hi50}` } : null;
}

/** Caption under the Readers tile. n is the count of OTHER readers (the viewer is never counted). */
function readersCaption(n) {
  if (!Number.isInteger(n) || n < 1) return null;
  return n === 1 ? '1 other reader' : `average of ${n}`;
}

/** Sentence under the tiles when no other reader has predicted: the gap to our forecast and whether it is inside the likely range. */
function gapSentence({ called, forecast, lo50, hi50 }) {
  if (!Number.isFinite(forecast)) return null;
  const gap = called - forecast;
  if (gap === 0) return 'Your prediction matches our forecast.';
  const dir = `Your prediction is ${pts(Math.abs(gap))} ${gap > 0 ? 'above' : 'below'} our forecast`;
  if (!hasRange(lo50, hi50)) return `${dir}.`;
  return `${dir}, ${called < lo50 || called > hi50 ? 'and outside' : 'inside'} our likely range.`;
}

/**
 * Sentence when other readers exist (it replaces gapSentence): "You are 5 points below other readers and 11 below our forecast."
 * avg is the rounded average of the OTHER readers, n how many. forecast may be null.
 */
function readersSentence({ called, forecast, readersAvg, readersN }) {
  if (!Number.isFinite(readersAvg) || !(readersN >= 1)) return null;
  const who = readersN === 1 ? 'the one other reader' : 'other readers';
  const rg = called - readersAvg;
  const first = rg === 0 ? `level with ${who}` : `${pts(Math.abs(rg))} ${rg > 0 ? 'above' : 'below'} ${who}`;
  if (!Number.isFinite(forecast)) return `You are ${first}.`;
  const fg = called - forecast;
  if (rg === 0 && fg === 0) return `You are level with ${who} and our forecast.`;
  const second = fg === 0 ? 'level with our forecast' : `${Math.abs(fg)} ${fg > 0 ? 'above' : 'below'} our forecast`;
  return `You are ${first} and ${second}.`;
}

/** The line shown when the viewer is the only one to have predicted. */
const FIRST_READER_LINE = "You're the first reader to predict this show.";

/**
 * Small print on the locked card. Range sentence only when a range exists; date clause only when the show has a date
 * (dateText is already formatted); the closing names how many parties will be scored.
 */
function smallPrint({ hasForecast, hasRange: range, hasReaders, dateText }) {
  const reviews = `Reviews come out after opening night${dateText ? ` on ${dateText}` : ''}.`;
  const close = hasForecast && hasReaders ? 'Come back to see who was closest.' : hasForecast || hasReaders ? 'Come back to see who was closer.' : 'Come back to see how close your prediction was.';
  return [range && hasForecast ? 'The Critic Score lands in our likely range about half the time.' : null, reviews, close].filter(Boolean).join(' ');
}

/** Result headline once the Critic Score exists. The tiles carry the numbers. */
function resultSentence({ r }) {
  if (r.off === 0) return r.beatForecast ? 'You got it exactly right, and beat our forecast.' : 'You got it exactly right.';
  const tie = r.forecastMiss != null && r.forecastMiss === r.off;
  return `You were ${pts(r.off)} off${r.beatForecast ? ', and closer than our forecast' : tie ? ', the same as our forecast' : ''}.`;
}

/** "The readers' average was 4 points off." avg is the rounded readers' average, critic the Critic Score. */
function readersMissSentence(readersAvg, critic) {
  if (!Number.isFinite(readersAvg) || !Number.isFinite(critic)) return null;
  return `The readers' average was ${pts(Math.abs(Math.round(critic) - readersAvg))} off.`;
}

function forecastMissSentence(r) {
  if (r.forecastMiss == null || (r.off !== 0 && r.forecastMiss === r.off)) return null; // a tie is already in the headline
  return r.forecastMiss === 0 ? 'Our forecast was exactly right.' : `Our forecast was ${pts(r.forecastMiss)} off.`;
}

// Guess first, sign up second (owner 2026-11-11). The number a signed-out reader picks waits in
// localStorage until they sign in; only the number is kept here, never the forecast.
const PENDING_KEY = 'bsc_pending_score_calls';
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function readPending(store, now) {
  try {
    const raw = store && store.getItem(PENDING_KEY);
    const o = raw ? JSON.parse(raw) : {};
    const out = {};
    for (const [id, v] of Object.entries(o || {})) {
      const score = parseCall(v && v.score);
      if (score != null && v && Number.isFinite(v.ts) && now - v.ts <= PENDING_TTL_MS) out[id] = { score, ts: v.ts };
    }
    return out;
  } catch { return {}; }
}
function writePending(store, o) {
  try { if (store) { if (Object.keys(o).length) store.setItem(PENDING_KEY, JSON.stringify(o)); else store.removeItem(PENDING_KEY); } } catch { /* private mode: reader just picks again */ }
}
/** Remember the pick for one show (one per show; a new pick replaces the old). Returns the stored integer or null. */
function setPendingCall(showId, score, store, now = Date.now()) {
  const n = parseCall(score);
  if (!showId || n == null) return null;
  const o = readPending(store, now);
  o[showId] = { score: n, ts: now };
  writePending(store, o);
  return n;
}
/** The remembered pick for a show, or null. */
function getPendingCall(showId, store, now = Date.now(), maxAgeMs = PENDING_TTL_MS) {
  const v = readPending(store, now)[showId];
  return v && now - v.ts <= maxAgeMs ? v.score : null;
}
// A number is saved on its own only right after sign-in. An older one (shared device, abandoned
// sign-in) is shown on the slider and the reader taps Lock, so nobody inherits a stranger's final pick.
const AUTOSAVE_WINDOW_MS = 30 * 60 * 1000;
function clearPendingCall(showId, store, now = Date.now()) {
  const o = readPending(store, now);
  delete o[showId];
  writePending(store, o);
}

/** Calls known after a load: locked calls never change, so ones this session already holds win over a read that may predate them. */
function mergeCalls(fetched, held) {
  return { ...(fetched && typeof fetched === 'object' ? fetched : {}), ...(held && typeof held === 'object' ? held : {}) };
}

module.exports = { mergeCalls, isCallableShow, parseCall, resultStrip, gapSentence, readersSentence, rangeCaption, readersCaption, smallPrint, readersMissSentence, FIRST_READER_LINE, resultSentence, forecastMissSentence, toDay, setPendingCall, getPendingCall, clearPendingCall, AUTOSAVE_WINDOW_MS };
