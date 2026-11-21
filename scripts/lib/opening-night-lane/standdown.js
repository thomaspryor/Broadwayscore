'use strict';
/**
 * LANE_STANDDOWN (BRO-6617): the owner's phone switch for the opening-night lane, a repo variable in the same spirit as
 * ORCHESTRATOR_PAUSED. Empty or unset means normal. Set it in the GitHub app (Settings, Secrets and variables, Actions,
 * Variables) to a market ("broadway", "west-end"), a category ("off-broadway", "off-west-end"), a comma list of those,
 * or "all". The lane notices a mid-run change at its next heartbeat (every 10 minutes) and finishes its current pass. A night-mode lane checks it before its arm check and at every heartbeat:
 *   - set before the start: the lane exits 3 (stood down) before it claims the lease;
 *   - set mid-run: the lane stops scoring, drops its unpublished queue (each scored review is already in review-texts,
 *     so the regular pipeline picks it up), lets an in-flight publish finish and then releases the lease, which lets the
 *     old-path writers back in.
 * "broadway" matches show.market, so it covers Off-Broadway shows too (they are market "broadway").
 * Anything that is not a known market or category reads as "all": a typo stands everything down rather than nothing.
 */

const VARIABLE = 'LANE_STANDDOWN';
const OFF_VALUES = new Set(['', 'false', '0', 'off', 'no', 'none']);
const ALL_VALUES = new Set(['all', 'true', '1', 'on', 'yes']);
const KNOWN_TOKENS = new Set(['broadway', 'west-end', 'off-broadway', 'off-west-end', 'regional', 'tour']);
const READ_TIMEOUT_MS = 10 * 1000;

/**
 * @returns {{all: boolean, tokens: Set<string>, unknown: string[]}} Pure.
 * `unknown: 'all'` (LANE_STANDDOWN) reads a typo or "all" as every market. `unknown: 'ignore'` (LANE_ONLY_MARKETS,
 * lane-only-markets.js) drops them instead and lists them in `unknown`, so a typo leaves the old path on.
 */
function parseStanddown(value, { unknown: onUnknown = 'all' } = {}) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (OFF_VALUES.has(raw)) return { all: false, tokens: new Set(), unknown: [] };
  // Comma-separated; spaces inside an entry become hyphens, so "West End" reads as west-end.
  const tokens = new Set(raw.split(/[,;]+/).map((t) => t.trim().replace(/\s+/g, '-')).filter(Boolean));
  const unknown = [...tokens].filter((t) => ALL_VALUES.has(t) || !KNOWN_TOKENS.has(t));
  if (onUnknown === 'ignore') return { all: false, tokens: new Set([...tokens].filter((t) => !unknown.includes(t))), unknown };
  return { all: unknown.length > 0, tokens, unknown };
}

/** Whether a parsed token set names this show ({market, category}). "broadway" matches market, so Off-Broadway too. */
function tokensMatchShow(tokens, show) {
  const s = show || {};
  return [s.market, s.category].some((x) => x && tokens.has(String(x).toLowerCase()));
}

/** Whether `value` stands the lane down for this show ({market, category}). Pure. */
function standsDown(value, show) {
  const p = parseStanddown(value);
  if (p.all) return true;
  return tokensMatchShow(p.tokens, show);
}

/**
 * The variable's current value, read live so a running lane sees a change. A 404 means unset. No token, a timeout or
 * any other failure falls back to `envValue` (the job-start `vars.LANE_STANDDOWN` snapshot), never to "unset".
 * @returns {Promise<{value: string, source: 'live'|'env-fallback', detail?: string}>}
 */
async function readStanddownLive({ repo, token, envValue = '', fetchImpl = globalThis.fetch, timeoutMs = READ_TIMEOUT_MS } = {}) {
  const fallback = (detail) => ({ value: String(envValue || ''), source: 'env-fallback', detail });
  if (!repo || !token || typeof fetchImpl !== 'function') return fallback('no repo or token');
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/variables/${VARIABLE}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { value: '', source: 'live' };
    if (!res.ok) return fallback(`HTTP ${res.status}`);
    const body = await res.json();
    return { value: String((body && body.value) || ''), source: 'live' };
  } catch (e) {
    return fallback(String((e && e.message) || e).slice(0, 120));
  }
}

/** The driver's `standdown` dep: read, then decide for this show. */
function createStanddownCheck({ show, repo, token, envValue, fetchImpl, timeoutMs }) {
  return async () => {
    const r = await readStanddownLive({ repo, token, envValue, fetchImpl, timeoutMs });
    return { standDown: standsDown(r.value, show), value: r.value, source: r.source, detail: r.detail };
  };
}

module.exports = { VARIABLE, parseStanddown, tokensMatchShow, standsDown, readStanddownLive, createStanddownCheck };
