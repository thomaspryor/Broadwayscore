'use strict';
/**
 * Loads a lane recording (opening-night-lane/fetch-recording.js, BRO-6651) so a real shadow or night run replays through
 * the same wiring as the archived-page nights, with the timing the pages really had.
 *
 * fetchPageFrom serves each URL the content that was current at the virtual time: the newest recorded fetch whose
 * offset (`t`, ms from the first fetch) is at or before `now() - startMs`. Before a URL's first recorded fetch, and for
 * URLs never recorded (review articles are not recorded), the optional `fallback` fetchPage answers, else a 404 error.
 * A recorded error replays as an error, so a page that was not filed yet stays missing until the pass that saw it.
 * A date-check entry replays as a bare article:published_time meta tag, which is all discovery reads from it.
 */
const fs = require('fs');
const path = require('path');
const { decrypt, KEY_VERSION } = require('../opening-night-lane/fetch-recording');

/** @returns {{entries: object[], page: (sha: string) => string|null, spanMs: number}} */
function loadRecording(dir, { key }) {
  const file = path.join(dir, 'fetches.jsonl');
  if (!fs.existsSync(file)) throw new Error(`no recording at ${dir}`);
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const header = rows.find((e) => e.header);
  if (!header || header.keyVersion !== KEY_VERSION) throw new Error(`recording at ${dir} was made with key version ${header ? header.keyVersion : 'none'}, this loader derives version ${KEY_VERSION}`);
  const entries = rows.filter((e) => e.url);
  const cache = new Map();
  const page = (sha) => {
    if (!cache.has(sha)) {
      const f = path.join(dir, 'pages', `${sha}.enc`);
      cache.set(sha, fs.existsSync(f) ? decrypt(key, fs.readFileSync(f)) : null);
    }
    return cache.get(sha);
  };
  return { entries, page, spanMs: entries.reduce((m, e) => Math.max(m, e.t || 0), 0) };
}

function replayFetchFrom(recording, { now, startMs, fallback = null }) {
  const byUrl = new Map();
  for (const e of recording.entries) { if (!byUrl.has(e.url)) byUrl.set(e.url, []); byUrl.get(e.url).push(e); }
  for (const list of byUrl.values()) list.sort((a, b) => a.t - b.t);
  const miss = async (url, opts) => {
    if (fallback) return fallback(url, opts);
    throw Object.assign(new Error(`404 ${url}`), { status: 404 });
  };
  return async (url, opts) => {
    const list = byUrl.get(url);
    const at = now() - startMs;
    const seen = list && list.filter((e) => e.t <= at);
    if (!seen || !seen.length) return miss(url, opts);
    const e = seen[seen.length - 1];
    if (e.status === 'error') throw Object.assign(new Error(e.error || `error ${url}`), e.httpStatus ? { status: e.httpStatus } : {});
    // The date-check entry holds only a date. With a fallback, the real page answers instead, so the scorer (same url) never reads a stub.
    if (e.kind === 'date-check' && fallback) return fallback(url, opts);
    if (e.kind === 'date-check') return { content: e.publishDate ? `<html><head><meta property="article:published_time" content="${e.publishDate}"></head></html>` : '<html></html>' };
    const content = recording.page(e.sha);
    if (content === null) {
      // Body dropped (oversize / capped / write failed): say so, a quiet 404 would read as a page that never existed.
      throw new Error(`recording incomplete for ${url}: body not stored${e.note ? ` (${e.note})` : ''}`);
    }
    return { content, ...(e.finalUrl ? { finalUrl: e.finalUrl } : {}) };
  };
}

module.exports = { loadRecording, replayFetchFrom };
