'use strict';
/**
 * landings-ledger.js — data/audit/landings.jsonl (BRO-3873 step 5 / BRO-3425).
 *
 * land.yml appends one row per successful landing AFTER landing-verify.js has
 * proven the landed sha is an ancestor of origin/main. A fast-forward push
 * creates no commit of its own, so there is no trailer to stamp — the ledger
 * is the only durable record that a given main sha arrived through the
 * landing workflow. .github/workflows/check-direct-push-to-main.yml reads it
 * on every push to main: a non-bot push whose head sha never shows up here is
 * a direct push that skipped the gates, and is digested to the owner under
 * conditionKey `direct-push:<sha>`.
 *
 * Row shape (append-only JSONL, committed to main by land.yml):
 *   { ts, branch, sha, tip, base, runUrl, attempts }
 *     branch  the land/** branch name
 *     sha     the sha now on main (the rebased tip)
 *     tip     the branch tip the checks verified (pre-rebase)
 *
 * classifyDirectPush() is the pure verdict the detector acts on; it is the
 * function the colocated test require()s (CLAUDE.md rule 15).
 */

const fs = require('fs');
const path = require('path');

const LANDINGS_REL = path.join('data', 'audit', 'landings.jsonl');

// Committer identities the repo's own workflows write with — every one of
// the 120+ workflows configures github-actions[bot] or "GitHub Action", and
// a rebase inside land.yml re-stamps the landed commits with the runner's
// identity too. GitHub web/PR merges (committer GitHub <noreply@github.com>)
// are deliberately NOT here: a session's `gh pr merge` is a path to main
// that skips land.yml's gates, and it is judged by its paths like any other
// human push (ship-check finding).
const BOT_COMMITTER_EMAIL_RE = /(\[bot\]@users\.noreply\.github\.com|^actions@github\.com)$/i;
const BOT_COMMITTER_NAME_RE = /^(github-actions(\[bot\])?|GitHub Action)$/i;
const BOT_ACTOR_RE = /\[bot\]$/i;

// The worktree-mandatory scope (CLAUDE.md rule 1): a push that changes NONE
// of these is data/memory automation (session-stop cloud-memory sync,
// review-text fixers, core-data bots) and is not what land.yml gates. Keep
// in step with DIRECT_PUSH_CODE_PATH_RE in scripts/lib/direct-push-guard.sh.
const CODE_PATH_RE = /^(src\/|scripts\/|supabase\/|\.github\/workflows\/|CLAUDE\.md$|next\.config\.(js|ts|mjs)$|tsconfig\.json$|package\.json$|package-lock\.json$)/;

function isCodePath(p) {
  return CODE_PATH_RE.test(String(p || ''));
}

function parseLandings(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row && typeof row === 'object' && row.sha) rows.push(row);
    } catch {
      // partial line from a crashed writer — skip, never fatal
    }
  }
  return rows;
}

function readLandings(repoDir) {
  const p = path.join(repoDir, LANDINGS_REL);
  if (!fs.existsSync(p)) return { available: false, rows: [] };
  return { available: true, rows: parseLandings(fs.readFileSync(p, 'utf8')) };
}

function appendLanding({ repoDir = process.cwd(), branch, sha, tip = null, base = null, runUrl = null, attempts = null } = {}) {
  if (!branch || !sha) throw new Error('appendLanding requires branch and sha');
  const row = {
    ts: new Date().toISOString(),
    branch: String(branch).replace(/^refs\/heads\//, ''),
    sha: String(sha),
    tip: tip ? String(tip) : null,
    base: base ? String(base) : null,
    runUrl: runUrl || null,
    attempts: attempts == null ? null : Number(attempts),
  };
  const p = path.join(repoDir, LANDINGS_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `${JSON.stringify(row)}\n`);
  return row;
}

function findLanding(rows, { sha = null, tip = null } = {}) {
  return (rows || []).find(r => (sha && r.sha === sha) || (tip && r.tip === tip)) || null;
}

/**
 * The detector's verdict for one push to main.
 *
 * @param {object} o
 * @param {string} o.sha             github.sha — the pushed head
 * @param {string} [o.actor]         github.actor
 * @param {string} [o.committerName] head_commit.committer.name
 * @param {string} [o.committerEmail]
 * @param {object[]} [o.landings]    parsed landings.jsonl rows
 * @param {boolean} [o.landingsAvailable=true]  false when the file is missing → fail open
 * @param {boolean} [o.killSwitch=false]         repo variable DIRECT_PUSH_DETECT_OFF=1
 * @param {string[]|null} [o.changedFiles=null]  paths the push changed (compare API);
 *   null = unknown (judged as code). A push touching no code path → skip.
 * @returns {{verdict:'skip'|'landed'|'direct'|'unknown', reason:string}}
 *   skip     a bot's own push (workflow commit, CI rebase) or a data-only push — not what land.yml gates
 *   landed   the sha is in landings.jsonl — it came through land.yml
 *   direct   non-bot push of code, no landing row — page (digest)
 *   unknown  cannot decide (no sha, ledger missing) — fail open, never page
 */
function classifyDirectPush({ sha, actor = '', committerName = '', committerEmail = '', landings = [], landingsAvailable = true, killSwitch = false, changedFiles = null } = {}) {
  if (killSwitch) return { verdict: 'skip', reason: 'kill-switch' };
  if (!sha) return { verdict: 'unknown', reason: 'no-sha' };
  if (BOT_ACTOR_RE.test(String(actor || ''))) return { verdict: 'skip', reason: `bot-actor:${actor}` };
  if (BOT_COMMITTER_EMAIL_RE.test(String(committerEmail || '')) || BOT_COMMITTER_NAME_RE.test(String(committerName || ''))) {
    return { verdict: 'skip', reason: `bot-committer:${committerEmail || committerName}` };
  }
  if (Array.isArray(changedFiles) && changedFiles.length > 0 && !changedFiles.some(isCodePath)) {
    return { verdict: 'skip', reason: `data-only:${changedFiles.length} path(s)` };
  }
  if (!landingsAvailable) return { verdict: 'unknown', reason: 'landings-ledger-missing' };
  const row = findLanding(landings, { sha });
  if (row) return { verdict: 'landed', reason: `landings.jsonl:${row.branch}` };
  return { verdict: 'direct', reason: 'no-landing-row' };
}

function conditionKeyFor(sha) {
  return `direct-push:${String(sha || '').slice(0, 40)}`;
}

function buildDirectPushAlert({ sha, actor = '', committerName = '', committerEmail = '', message = '', runUrl = '', compareUrl = '' }) {
  if (!sha) throw new Error('buildDirectPushAlert requires sha');
  const short = String(sha).slice(0, 10);
  const parts = [
    `${short} reached main WITHOUT going through land.yml (no row in data/audit/landings.jsonl).`,
    `Pushed by ${actor || 'unknown actor'}${committerName || committerEmail ? ` (committer ${committerName || ''} ${committerEmail ? `<${committerEmail}>` : ''})`.replace(/\s+>/, '>') : ''}.`,
    message ? `Head commit: ${String(message).split('\n')[0].slice(0, 120)}` : '',
    'Direct pushes skip the delta-vs-base gates; sessions must land via scripts/merge-worktree-to-main.sh (BRO-3425).',
    compareUrl ? `Compare: ${compareUrl}` : '',
    runUrl ? `Run: ${runUrl}` : '',
  ].filter(Boolean);
  return {
    conditionKey: conditionKeyFor(sha),
    title: `Direct push to main: ${short}${actor ? ` by ${actor}` : ''}`,
    description: parts.join(' '),
    hint: 'Find the session that pushed (dispatch-ledger direct-push-* rows on the Mac name cwd + branch) and check whether test.yml went green for the sha; if the hook was bypassed with --no-verify or LAND_ENFORCE_OFF=1, that is the thing to fix.',
    severity: 'warning',
    disposition: 'digest',
    cooldownHours: 24 * 7,
    fields: [
      { name: 'sha', value: String(sha) },
      ...(actor ? [{ name: 'actor', value: String(actor) }] : []),
      ...(runUrl ? [{ name: 'run', value: String(runUrl) }] : []),
    ],
  };
}

module.exports = {
  LANDINGS_REL,
  BOT_COMMITTER_EMAIL_RE,
  BOT_COMMITTER_NAME_RE,
  BOT_ACTOR_RE,
  CODE_PATH_RE,
  isCodePath,
  parseLandings,
  readLandings,
  appendLanding,
  findLanding,
  classifyDirectPush,
  conditionKeyFor,
  buildDirectPushAlert,
};
