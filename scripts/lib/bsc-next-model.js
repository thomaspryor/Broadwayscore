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

const QUEUE_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'autonomous-queue.json');

const MODEL_HINT_RE = /\bmodel\s*:\s*(opus|sonnet|haiku)\b/i;

// pickModel() returns claude CLI's full model ids; bsc-next launches with the
// short aliases it already used for its sonnet default.
const SHORT_ALIAS = Object.freeze({
  'claude-opus-4-8': 'opus',
  'claude-sonnet-5': 'sonnet',
});

function explicitModelHint(task, card) {
  const text = `${(card && card.notes) || ''}\n${(task && task.description) || ''}`;
  const m = MODEL_HINT_RE.exec(text);
  return m ? m[1].toLowerCase() : null;
}

// Looks up the card's most recent triage verdict by Notion page id. Missing
// queue file / entry / triage → null (falls through to the sonnet floor).
function triageSizeFor(notionId, queuePath = QUEUE_PATH) {
  if (!notionId) return null;
  let queue;
  try { queue = JSON.parse(fs.readFileSync(queuePath, 'utf8')); } catch { return null; }
  const entry = (queue.entries || []).find(e => e.card && e.card.id === notionId);
  return (entry && entry.triage && entry.triage.size) || null;
}

// S = the loop's attempt 1 (Sonnet). M/L = the loop's own attempt-2-on-
// content-failure case (Opus) — reusing pickModel's policy, not duplicating it.
function modelForSize(size) {
  const full = (size === 'M' || size === 'L') ? pickModel(2, 'content') : pickModel(1, null);
  return SHORT_ALIAS[full] || 'sonnet';
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

module.exports = { QUEUE_PATH, MODEL_HINT_RE, SHORT_ALIAS, explicitModelHint, triageSizeFor, modelForSize, resolveModel };
