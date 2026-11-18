'use strict';
/**
 * BRO-7779 item 5: the lane's own index and feed reads must fail loudly.
 *
 * Before this, a feed that would not load, or a feed that loaded but would not parse, or a section index that timed out,
 * was skipped with a bare `continue` (discovery.js rss / section-index adapters). A source could be dead all night and
 * nobody would know. This tracker is kept for the whole night by lane-runner.js and fed by the adapters:
 *
 *   fetch-failing  a source failed FAIL_ALERT_AFTER reads in a row (fetch error or unparseable body). One alert per
 *                  failure streak; a success ends the streak, so a later new streak alerts again.
 *   source-stale   a source the adapter expects to read was not attempted for STALE_AFTER_MS (rotation starved it,
 *                  or it is resting after failures). One alert per stale period; a read ends the period.
 *
 * Pure state machine, no I/O (CLAUDE.md rule 15). Alerts go through near-miss.recordNew (per-night dedupe on `key`) and
 * the press-signals notifier.
 */

const FAIL_ALERT_AFTER = 3;
const STALE_AFTER_MS = 30 * 60 * 1000;

function createSourceHealth({ failAlertAfter = FAIL_ALERT_AFTER, staleAfterMs = STALE_AFTER_MS, now = Date.now } = {}) {
  const state = new Map(); // source -> { adapter, outletId, fails, streakStart, lastError, lastAttempt, expectedSince, failAlerted, staleAlerted }
  const get = (source, meta = {}) => {
    let s = state.get(source);
    if (!s) { s = { adapter: meta.adapter || null, outletId: meta.outletId || null, fails: 0, streakStart: null, lastError: null, lastAttempt: null, lastOk: null, expectedSince: null, failAlerted: false, staleAlerted: false }; state.set(source, s); }
    if (meta.adapter && !s.adapter) s.adapter = meta.adapter;
    if (meta.outletId && !s.outletId) s.outletId = meta.outletId;
    return s;
  };
  return {
    /** The sources an adapter will read in rotation tonight. A source is only judged stale once it is expected. */
    expect(sources, meta = {}, at = now()) {
      for (const src of sources || []) { if (!src) continue; const s = get(src, meta); if (s.expectedSince == null) s.expectedSince = at; }
    },
    /** One read of a source: ok, or failed with an error (a fetch error or a body that would not parse). */
    record(source, { ok, error = null, adapter, outletId } = {}, at = now()) {
      if (!source) return;
      const s = get(source, { adapter, outletId });
      s.lastAttempt = at;
      s.staleAlerted = false;
      if (ok) { s.fails = 0; s.streakStart = null; s.lastError = null; s.failAlerted = false; s.lastOk = at; return; }
      if (s.fails === 0) s.streakStart = at;
      s.fails += 1;
      s.lastError = String((error && error.message) || error || 'unknown').slice(0, 160);
    },
    /** New alerts as of `at`. Each streak or stale period alerts once (the returned key carries its start). */
    alerts(at = now()) {
      const out = [];
      for (const [source, s] of state) {
        if (s.fails >= failAlertAfter && !s.failAlerted) {
          s.failAlerted = true;
          out.push({ kind: 'fetch-failing', key: `fetch-failing|${source}|${new Date(s.streakStart).toISOString()}`, url: source, adapter: s.adapter, outletId: s.outletId, fails: s.fails, lastError: s.lastError, lastOkAt: s.lastOk ? new Date(s.lastOk).toISOString() : null });
        }
        const since = s.lastAttempt != null ? s.lastAttempt : s.expectedSince;
        if (since != null && s.expectedSince != null && at - since >= staleAfterMs && !s.staleAlerted) {
          s.staleAlerted = true;
          out.push({ kind: 'source-stale', key: `source-stale|${source}|${new Date(since).toISOString()}`, url: source, adapter: s.adapter, outletId: s.outletId, idleMin: Math.round((at - since) / 60000), lastAttemptAt: s.lastAttempt ? new Date(s.lastAttempt).toISOString() : null });
        }
      }
      return out;
    },
    snapshot() { return [...state.entries()].map(([source, s]) => ({ source, ...s })); },
  };
}

// A page that loaded but holds no content: a bot wall or an error page. Read as a failed read, never as "nothing new".
const BLOCKED_TITLE_RE = /<title[^>]*>\s*(?:Just a moment|Attention Required|Verifying Device|Security Verification|Access Denied|Request Rejected|Too Many Requests)/i;

/** Why a section index body is not a real index page, or null when it looks fine. */
function indexBodyProblem(html) {
  const t = String(html || '');
  if (!t.trim()) return 'empty body';
  if (BLOCKED_TITLE_RE.test(t.slice(0, 5000))) return 'bot wall or error page';
  return null;
}

/** Why a feed body is not a feed, or null. An empty but real feed (an <rss>/<feed>/<rdf> root) is fine. */
function feedBodyProblem(body, items) {
  const t = String(body || '');
  if (Array.isArray(items) && items.length) return null;
  if (!t.trim()) return 'empty body';
  if (/<(?:rss|feed|rdf:RDF)[\s>]/i.test(t.slice(0, 5000))) return null;
  return BLOCKED_TITLE_RE.test(t.slice(0, 5000)) ? 'bot wall or error page' : 'not a feed';
}

/** A tracker that records nothing: the default when a caller (tests, old replays) passes none. */
const NOOP_HEALTH = { expect() {}, record() {}, alerts() { return []; }, snapshot() { return []; } };

module.exports = { createSourceHealth, NOOP_HEALTH, indexBodyProblem, feedBodyProblem, BLOCKED_TITLE_RE, FAIL_ALERT_AFTER, STALE_AFTER_MS };
