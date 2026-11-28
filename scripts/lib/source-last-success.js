'use strict';

/**
 * Per-source "last non-empty parse" markers (S4-T5, 2026 data audit
 * BRO-4204).
 *
 * data/audit/<source>-last-success.json — one small file per discovery /
 * cross-validation source, written on EVERY parse:
 *
 *   {
 *     "source": "olt",
 *     "at": "2026-09-28T22:00:00.000Z",   // last NON-empty parse (null: never)
 *     "count": 98,                        // entries that parse produced
 *     "emptyStreak": 0,                   // consecutive empty parses since `at`
 *     "lastEmptyAt": null                 // most recent empty parse
 *   }
 *
 * Generalises the pattern scripts/lib/playbill-broadway-schedule.js:34
 * started for the Playbill Broadway schedule (a timestamp file the coverage
 * guard reads to tell "source dark" from "source fine") so the three London /
 * Off-Broadway sources that went silent for 20+ runs without anyone noticing
 * (Official London Theatre: raw https.get 403'd from the Actions runner;
 * Theatremonkey: index carries no venue, so every candidate was dropped;
 * Lortel: lortel.org/currently-playing/ is a 404) share one marker shape and
 * one soft-404 warning instead of three inline copies.
 *
 * The marker file tracks the empty streak itself, so a source that parses
 * 0 entries three runs in a row (DEFAULT_EMPTY_STREAK_THRESHOLD) gets a
 * `::warning::` annotation naming the last good parse — the classic
 * soft-404 (200 OK with a "Page not found" body) looks exactly like "no
 * shows today" to a parser, and only the streak tells them apart.
 *
 * Fail-soft by design: a marker that cannot be written must never break the
 * discovery run that produced the parse (mirrors checkSilentRot's try/catch).
 *
 * Path override: SOURCE_LAST_SUCCESS_DIR (env) or `{ dir }` per call, so
 * unit tests and scratch runs never touch the tracked data/audit/ copies.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'data', 'audit');
const DEFAULT_EMPTY_STREAK_THRESHOLD = 3;
// Marker files are named from the source id, so keep it a plain slug — a
// caller passing a URL or a display name would otherwise mint a path.
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function resolveDir(dir) {
  return dir || process.env.SOURCE_LAST_SUCCESS_DIR || DEFAULT_DIR;
}

function toIso(now) {
  if (now === undefined || now === null) return new Date().toISOString();
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) throw new Error(`source-last-success: invalid \`now\` ${JSON.stringify(now)}`);
  return d.toISOString();
}

/** Absolute path of the marker file for `source`. */
function markerPath(source, { dir } = {}) {
  if (typeof source !== 'string' || !SOURCE_ID_RE.test(source)) {
    throw new Error(`source-last-success: invalid source id ${JSON.stringify(source)} (expected a slug like "olt")`);
  }
  return path.join(resolveDir(dir), `${source}-last-success.json`);
}

function writeMarker(file, marker) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(marker, null, 2) + '\n');
}

/**
 * Read a source's marker. Returns null when the file is missing or
 * unparseable (a corrupt marker is treated as "never succeeded", which is
 * the conservative reading — the next non-empty parse rewrites it).
 */
function readLastSuccess(source, { dir } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(markerPath(source, { dir }), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Record a NON-empty parse: stamps `at`/`count` and resets the empty streak.
 * Returns the marker written. Throws only on an invalid source id or `now`;
 * filesystem failures are logged and swallowed (fail-soft).
 */
function writeLastSuccess(source, count, { dir, now } = {}) {
  const n = Number(count);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`source-last-success: count for "${source}" must be a non-negative number, got ${JSON.stringify(count)}`);
  }
  const marker = { source, at: toIso(now), count: n, emptyStreak: 0, lastEmptyAt: null };
  try {
    writeMarker(markerPath(source, { dir }), marker);
  } catch (e) {
    console.warn(`WARNING: failed to write ${source} last-success marker: ${e.message}`);
  }
  return marker;
}

/**
 * Record an EMPTY parse (0 entries, fetch failure, soft-404 — anything that
 * produced nothing): bumps `emptyStreak`, keeps the last success `at`/`count`
 * so the warning can name it. Returns the marker written.
 */
function recordEmptyParse(source, { dir, now } = {}) {
  const prev = readLastSuccess(source, { dir });
  const marker = {
    source,
    at: prev?.at ?? null,
    count: prev?.count ?? null,
    emptyStreak: (Number(prev?.emptyStreak) || 0) + 1,
    lastEmptyAt: toIso(now),
  };
  try {
    writeMarker(markerPath(source, { dir }), marker);
  } catch (e) {
    console.warn(`WARNING: failed to write ${source} last-success marker: ${e.message}`);
  }
  return marker;
}

/**
 * Pure: the soft-404 warning text once `streak` consecutive empty parses
 * reach `threshold`, else null. `lastSuccess` ({ at, count }) is optional and
 * only enriches the message.
 */
function emptyStreakWarning(source, streak, threshold = DEFAULT_EMPTY_STREAK_THRESHOLD, lastSuccess = null) {
  const n = Number(streak) || 0;
  if (n < threshold) return null;
  const last = lastSuccess && lastSuccess.at
    ? `last non-empty parse ${lastSuccess.at} (${lastSuccess.count} entries)`
    : 'no non-empty parse on record';
  return `::warning::${source}: 0 entries parsed for ${n} consecutive runs (threshold ${threshold}) — `
    + `possible soft-404 / removed page / layout change; ${last}`;
}

/**
 * One-call form for the parse sites: non-empty → writeLastSuccess; empty →
 * recordEmptyParse and (once the streak reaches the threshold) log the
 * soft-404 warning. Returns { marker, warning } so callers/tests can assert
 * without scraping stdout. `log` defaults to console.warn.
 */
function recordParseResult(source, count, { dir, now, threshold = DEFAULT_EMPTY_STREAK_THRESHOLD, log = console.warn } = {}) {
  const n = Number(count) || 0;
  if (n > 0) {
    return { marker: writeLastSuccess(source, n, { dir, now }), warning: null };
  }
  const marker = recordEmptyParse(source, { dir, now });
  const warning = emptyStreakWarning(source, marker.emptyStreak, threshold, marker);
  if (warning && typeof log === 'function') log(warning);
  return { marker, warning };
}

module.exports = {
  DEFAULT_DIR,
  DEFAULT_EMPTY_STREAK_THRESHOLD,
  markerPath,
  readLastSuccess,
  writeLastSuccess,
  recordEmptyParse,
  emptyStreakWarning,
  recordParseResult,
};
