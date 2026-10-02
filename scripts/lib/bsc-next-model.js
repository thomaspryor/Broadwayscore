/**
 * bsc-next-model.js — model resolution for bsc-next dispatches (task #151).
 *
 * Before this, bsc-next pinned every dispatch to --model sonnet — a correct
 * emergency floor against silent Fable inheritance (95b5a5286a3), but blunt:
 * a hard M/L-complexity card (architecture, multi-file refactor, adversarial
 * debugging) genuinely warrants Opus.
 *
 * Resolution order:
 *   1. explicit --model flag — always wins, including --model fable.
 *   2. an explicit model hint on the card ("Model: Opus" in notes or the
 *      task's mirrored description).
 *   3. the autonomous loop's OWN pickModel() (autonomous-budget.js) — never a
 *      second policy. The loop's triage already sizes every card it has seen
 *      (data/audit/autonomous-queue.json); S maps to attempt 1 (Sonnet), M/L
 *      maps to the loop's own attempt-2-on-content-failure case (Opus) — the
 *      loop's own definition of "hard enough to escalate".
 *   4. sonnet floor — no triage data (card never triaged, or queue missing).
 *
 * Fable/Mythos is excluded from every hint/triage path: MODEL_HINT_RE has no
 * fable alternative, and pickModel() itself throws on a forbidden tier — only
 * an explicit --model fable flag (layer 1) can select it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pickModel } = require('./autonomous-budget.js');
const { DISPATCH_SONNET, DISPATCH_OPUS } = require('./models.js');

const QUEUE_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'autonomous-queue.json');

// Anchored to the START of a line (not \b mid-sentence): a card whose prose
// happens to mention "the data model: Opus schema tier", or a card ABOUT this
// very feature quoting "Model: Opus" as an example, must not accidentally
// flip its own dispatch tier. A deliberate hint is its own line by
// convention; incidental prose isn't.
const MODEL_HINT_RE = /^\s*model\s*:\s*(opus|sonnet|haiku)\b/im;

// pickModel() returns claude CLI's full model ids; bsc-next launches with the
// short aliases it already used for its sonnet default. Fall back to the full
// id (still a valid --model value) rather than 'sonnet' for an id pickModel()
// might return in the future that isn't in this table yet — a stale table
// must not silently downgrade a card that was actually sized for Opus.
const SHORT_ALIAS = Object.freeze({
  [DISPATCH_OPUS]: 'opus',
  [DISPATCH_SONNET]: 'sonnet',
});

function explicitModelHint(task, card) {
  const text = `${(card && card.notes) || ''}\n${(task && task.description) || ''}`;
  const m = MODEL_HINT_RE.exec(text);
  return m ? m[1].toLowerCase() : null;
}

// Looks up the card's most recent triage verdict by Notion page id. No
// matching entry (never triaged, or the loop already claimed it and the next
// triage run skipped re-sizing it — see decide()/autonomous-triage.js) falls
// through to null → the sonnet floor. That's always the SAFE direction: the
// worst outcome is under-provisioning a hard card, never over-provisioning
// (Opus/fable) one that wasn't actually sized that way.
function triageSizeFor(notionId, queuePath = QUEUE_PATH) {
  if (!notionId) return null;
  let queue;
  try {
    queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  } catch (err) {
    // ENOENT is expected (fresh worktree, queue not yet written tonight) —
    // only warn when the file exists but is corrupt/unreadable, which is an
    // actual operational problem worth surfacing.
    if (err.code !== 'ENOENT') {
      console.error(`[bsc-next-model] could not read triage queue at ${queuePath}: ${err.message} — falling back to the sonnet floor`);
    }
    return null;
  }
  const entry = (queue.entries || []).find(e => e.card && e.card.id === notionId);
  return (entry && entry.triage && entry.triage.size) || null;
}

// S = the loop's attempt 1 (Sonnet). M/L = the loop's own attempt-2-on-
// content-failure case (Opus) — reusing pickModel's policy, not duplicating
// it, per the card's explicit "do NOT write a second policy" directive. L
// gets Opus here even though the unattended loop always SPLITS L cards
// rather than attempting them whole (autonomous-triage-core.js decide()) —
// that constraint is about unattended budget/time admission, not about which
// model an L card deserves. A human-supervised interactive bsc-next dispatch
// has no such admission gate, so routing L to the smartest available tier is
// the correct read of "hard enough to escalate" here.
// Expressed through pickModel's tier3Size hint (2026-07-25) rather than the
// old pickModel(2, 'content') stand-in. Same outputs — S/unknown → Sonnet,
// M/L → Opus — but it now says what it MEANS ("this card is big enough to
// deserve the better model") instead of impersonating a retry-after-content-
// failure. The old form would have silently drifted the moment the loop's
// attempt-2 policy changed for a reason that has nothing to do with sizing.
function modelForSize(size) {
  const full = pickModel(1, null, { tier3Size: (size === 'M' || size === 'L') ? size : null });
  return SHORT_ALIAS[full] || full;
}

/**
 * @param {object} opts
 * @param {string|null} opts.explicitFlag - the raw --model CLI value, or null/undefined
 * @param {object} opts.task - the task-mirror object ({ description, ... })
 * @param {object|null} [opts.card] - the fetched Notion card ({ notes, ... }), if any
 * @param {string|null} [opts.notionId] - the card's Notion page id, for the triage lookup
 * @param {string} [opts.queuePath] - override for tests
 */
function resolveModel({ explicitFlag, task, card, notionId, queuePath = QUEUE_PATH }) {
  if (typeof explicitFlag === 'string') return explicitFlag;
  const hint = explicitModelHint(task, card);
  if (hint) return hint;
  return modelForSize(triageSizeFor(notionId, queuePath));
}

// BRO-4523 (owner 2026-10-02, "are we using the right model for each
// card?"): Linear dispatches pass notionId:null, so layer 3 (the Notion
// triage size) never fires for them and every Linear card ran on Sonnet,
// however urgent or however many times a Sonnet worker had already failed
// it. This is the Linear stand-in for layer 3, applied only when no explicit
// flag or hint decided: a P0 card, or a card that already carries a
// "Dispatched ..." comment (a re-run after a prior worker failed to close
// it), gets Opus. Same retry rule digest-autofix.js already uses
// (`attempt >= 2 ? 'opus'`). A rolling 24h cap on Opus Linear launches
// keeps a backlog drain from spending the week's allowance on Opus; over
// the cap the card falls back to Sonnet rather than waiting.
const LINEAR_OPUS_DAILY_CAP_DEFAULT = 6;
const LINEAR_OPUS_WINDOW_MS = 24 * 60 * 60 * 1000;
const PRIOR_DISPATCH_RE = /^Dispatched\b/;

function linearOpusDailyCap(env = process.env) {
  const raw = env.LINEAR_OPUS_DAILY_CAP;
  if (raw === undefined || raw === '') return LINEAR_OPUS_DAILY_CAP_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : LINEAR_OPUS_DAILY_CAP_DEFAULT;
}

function countRecentLinearOpusLaunches(entries, nowMs, windowMs = LINEAR_OPUS_WINDOW_MS) {
  let n = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.event !== 'launch' || e.model !== 'opus') continue;
    if (!String(e.taskId || '').startsWith('linear:')) continue;
    const ts = Date.parse(e.ts);
    if (Number.isFinite(ts) && ts <= nowMs && nowMs - ts < windowMs) n++;
  }
  return n;
}

/**
 * @param {object} opts
 * @param {object} opts.issue - Linear issue ({ priority, comments: { nodes } })
 * @param {number} opts.recentOpusLaunches - from countRecentLinearOpusLaunches
 * @param {number} opts.cap - from linearOpusDailyCap
 * @returns {{ model: 'opus'|'sonnet', reason: string }}
 */
function linearEscalationModel({ issue, recentOpusLaunches, cap }) {
  const comments = (issue && issue.comments && issue.comments.nodes) || [];
  const priorDispatches = comments.filter((c) => c && PRIOR_DISPATCH_RE.test(String(c.body || '').trim())).length;
  const isP0 = !!issue && issue.priority === 1;
  if (!isP0 && priorDispatches === 0) return { model: 'sonnet', reason: 'first attempt, not P0' };
  const why = isP0 ? 'P0' : `retry after ${priorDispatches} prior dispatch(es)`;
  if (recentOpusLaunches >= cap) return { model: 'sonnet', reason: `${why}, but Opus cap reached (${recentOpusLaunches}/${cap} in 24h)` };
  return { model: 'opus', reason: why };
}

module.exports = {
  QUEUE_PATH, MODEL_HINT_RE, SHORT_ALIAS, explicitModelHint, triageSizeFor, modelForSize, resolveModel,
  LINEAR_OPUS_DAILY_CAP_DEFAULT, linearOpusDailyCap, countRecentLinearOpusLaunches, linearEscalationModel,
};
