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

/** Same rule as review-forecast-pilot.isPilotTarget (a test pins them together): a show a reader can call. */
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

/** One line for the locked state, e.g. "We forecast 74 (likely 62 to 85). You are 6 above." */
function gapSentence({ called, forecast, lo80, hi80 }) {
  if (!Number.isFinite(forecast)) return null;
  const range = Number.isFinite(lo80) && Number.isFinite(hi80) ? ` (likely ${lo80} to ${hi80})` : '';
  const gap = called - forecast;
  const tail = gap === 0 ? 'You matched it.' : `You are ${Math.abs(gap)} ${gap > 0 ? 'above' : 'below'}.`;
  return `We forecast ${forecast}${range}. ${tail}`;
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

module.exports = { isCallableShow, parseCall, resultStrip, gapSentence, toDay, setPendingCall, getPendingCall, clearPendingCall, AUTOSAVE_WINDOW_MS };
