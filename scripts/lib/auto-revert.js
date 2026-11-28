'use strict';
/**
 * auto-revert.js — BRO-7102 item 2: when one landing turns main red and a
 * re-run confirms it, revert that landing instead of leaving main red while a
 * worker finds the fix. PURE decision logic only; callers do the I/O.
 *
 * SHADOW ONLY. Nothing reverts until AUTO_REVERT_MODE=armed, and arming is a
 * separate card that needs a 30-day replay (scripts/auto-revert-replay.js)
 * with zero false reverts. Kill switch: AUTO_REVERT_DISABLED=true.
 *
 * Never reverted: data-bot commits (a *[bot] author, or a diff that only
 * touches data/ and audit ledgers) and reverts themselves. Only a single
 * candidate landing is ever reverted: two or more landings in the green->red
 * window is ambiguous and is left to the red-escalation worker.
 */

// Both bot spellings seen on main: "github-actions[bot]" and "GitHub Action".
const BOT_AUTHOR_RE = /\[bot\]$|^github[- ]actions?$/i;
// Paths bots rewrite on a schedule. A commit that only touches these is data, never code.
// public/images/ and public/opening-night-status.json are bot-fetched images and a
// bot status file: the 30-day replay found them behind 31 of 34 "bot edited code" holds.
const DATA_PATH_RE = /^(?:data\/|public\/data\/|public\/images\/|public\/opening-night-status\.json$|\.claude\/review-verdicts\.jsonl$)/;
const DOCS_PATH_RE = /^(?:memory\/|cloud-memory\/|docs\/)|\.md$/;
const REVERT_SUBJECT_RE = /^Revert\b|^revert:/i;
const REVERT_BODY_RE = /\bThis reverts commit [0-9a-f]{7,40}\b/;

/** PURE. How a commit in the window is classified: 'revert' | 'merge' | 'data-bot' | 'bot-code' | 'docs-only' | 'landing'. */
function classifyCommit(c) {
  // A merge's file list (its diff against the first parent) repeats the commits it
  // brings in, which sit in the same window and are classified one by one. But a
  // merge can also carry its own conflict resolution, which the API cannot separate
  // out, so a merge in the window holds the decision (merge-in-window): never blame
  // the person beside it. It is never a fixer either.
  if (c && Number(c.parents) > 1) return 'merge';
  const subject = String((c && c.subject) || '');
  const body = String((c && c.body) || '');
  if (REVERT_SUBJECT_RE.test(subject) || REVERT_BODY_RE.test(body)) return 'revert';
  const author = String((c && (c.authorLogin || c.authorName)) || '');
  const files = Array.isArray(c && c.files) ? c.files : null;
  const dataOnly = files && files.length && files.every((f) => DATA_PATH_RE.test(f) || DOCS_PATH_RE.test(f));
  if (BOT_AUTHOR_RE.test(author)) {
    // A bot is data only when its files say so (or are unknown). A bot that edits
    // code (a dependency bump) could be the break: never blame a person beside it.
    return !files || !files.length || dataOnly ? 'data-bot' : 'bot-code';
  }
  if (files && files.length && files.every((f) => DATA_PATH_RE.test(f))) return 'data-bot';
  if (files && files.length && files.every((f) => DOCS_PATH_RE.test(f) || DATA_PATH_RE.test(f))) return 'docs-only';
  return 'landing';
}

/**
 * PURE. Would we revert, for one green->red transition on main?
 * @param {object} p
 * @param {Array<object>} p.commits - commits after the last green sha up to and including the red sha
 *   ({ sha, subject, body, authorLogin|authorName, files }).
 * @param {('failure'|'success'|null)} p.confirm - the confirming re-run's conclusion (null: not run yet)
 * @param {object} [p.env]
 * @returns {{revert: boolean, shadow: boolean, reason: string, sha: (string|null), classes: object}}
 */
function decideAutoRevert({ commits, confirm, env = process.env }) {
  const shadow = !(env && env.AUTO_REVERT_MODE === 'armed');
  const out = (revert, reason, sha = null, classes = {}) => ({ revert, shadow, reason, sha, classes });
  if (env && env.AUTO_REVERT_DISABLED === 'true') return out(false, 'kill-switch');
  const list = Array.isArray(commits) ? commits : [];
  if (!list.length) return out(false, 'no-commits');
  const classes = {};
  for (const c of list) classes[c.sha] = classifyCommit(c);
  if (list.some((c) => classes[c.sha] === 'merge')) return out(false, 'merge-in-window', null, classes);
  if (list.some((c) => classes[c.sha] === 'bot-code')) return out(false, 'bot-code-in-window', null, classes);
  const landings = list.filter((c) => classes[c.sha] === 'landing');
  if (landings.length === 0) {
    // Only bots, docs or reverts moved: the red is data drift or a flake, not a landing.
    return out(false, list.some((c) => classes[c.sha] === 'data-bot') ? 'data-only-window' : 'no-landing', null, classes);
  }
  if (landings.length > 1) return out(false, 'multiple-landings', null, classes);
  const sha = landings[0].sha;
  if (confirm == null) return out(false, 'awaiting-confirm', sha, classes);
  if (confirm !== 'failure') return out(false, 'not-confirmed', sha, classes);
  return out(true, 'confirmed-breaking-landing', sha, classes);
}

/**
 * PURE (replay ground truth). After a would-revert, was it a false revert?
 * @param {object} p
 * @param {object} p.candidate - the landing commit we would have reverted ({ sha, files })
 * @param {Array<object>} p.fixWindow - commits after the red sha up to and including the next green sha
 * @returns {'true-breakage'|'false-revert'|'other-fix'|'still-red'}
 *   true-breakage: the red cleared when someone reverted the candidate or changed one of its files.
 *   false-revert: it cleared with only data-bot/docs commits (flake or data drift): reverting would have been wrong.
 *   other-fix: a person fixed something else (often a stale test the landing exposed). Reverting
 *     would have turned main green too, but the code was not the cause. Counted apart, not as false.
 *   still-red: main never went green in the window read.
 */
function classifyReplayOutcome({ candidate, fixWindow, cleared = true }) {
  if (!cleared) return 'still-red';
  const files = new Set((candidate && candidate.files) || []);
  const shortSha = String((candidate && candidate.sha) || '').slice(0, 7);
  const commits = Array.isArray(fixWindow) ? fixWindow : [];
  const fixers = commits.filter((c) => {
    const k = classifyCommit(c);
    return k === 'landing' || k === 'revert' || k === 'bot-code';
  });
  if (!fixers.length) return 'false-revert';
  const touchesCandidate = fixers.some((c) => {
    const text = `${c.subject || ''}\n${c.body || ''}`;
    if (shortSha && classifyCommit(c) === 'revert' && text.includes(shortSha)) return true;
    return (c.files || []).some((f) => files.has(f));
  });
  return touchesCandidate ? 'true-breakage' : 'other-fix';
}

module.exports = { classifyCommit, decideAutoRevert, classifyReplayOutcome, DATA_PATH_RE, BOT_AUTHOR_RE };
