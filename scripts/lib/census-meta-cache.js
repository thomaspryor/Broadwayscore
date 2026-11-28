'use strict';
/**
 * BRO-7163 F16: the census page-meta cache used to keep an error entry ("HTTP 503", a timeout) forever,
 * so one bad fetch hid that article's author/date from every later run. Error entries now carry
 * errorAt and attempts and are retried with a growing delay (1d, 2d, 4d ... capped at 14d).
 */
const DAY_MS = 86400000;
const MAX_BACKOFF_DAYS = 14;

function metaNeedsFetch(entry, nowMs = Date.now()) {
  if (!entry) return true;
  if (entry.error) {
    const at = Date.parse(entry.errorAt || '');
    if (!Number.isFinite(at)) return true; // legacy error entry with no timestamp: retry once and stamp it
    const waitDays = Math.min(MAX_BACKOFF_DAYS, 2 ** Math.max(0, (entry.attempts || 1) - 1));
    return nowMs - at >= waitDays * DAY_MS;
  }
  return !('reviewAuthor' in entry); // pre-BRO-6485 entries are re-read once
}

function errorEntry(message, previous, nowMs = Date.now()) {
  return { error: message, errorAt: new Date(nowMs).toISOString(), attempts: ((previous && previous.error && previous.attempts) || 0) + 1 };
}

module.exports = { metaNeedsFetch, errorEntry, MAX_BACKOFF_DAYS };
