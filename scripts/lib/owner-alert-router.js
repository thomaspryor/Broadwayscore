/**
 * Owner Alert Router — single funnel for owner-facing automated alerts.
 *
 * Problem this solves: 34 independent code paths email thomas.pryor@gmail.com
 * directly, most ending in a paste-into-Claude-Code prompt, and re-alert the
 * same known condition every run because nothing remembers what was already
 * reported. See ~/Documents/claude-outputs/email-consolidation-plan-2026-07-21.md.
 *
 * Every owner-facing alert should call routeAlert() instead of emailing (or
 * creating an ad-hoc GitHub issue / paste-prompt) directly. Each call declares
 * a stable `conditionKey` and a `disposition`:
 *   - 'auto':   files a Notion Action Queue card (Action property set) so
 *               notion-action-poll.js (the launchd action-dispatcher) picks it
 *               up and works it hands-free. Use for machine-fixable /
 *               machine-investigable conditions — no owner judgment required.
 *   - 'digest': queues a line for the next Daily Digest "Automation" section
 *               instead of sending its own email.
 *   - 'human':  sends an immediate email via the existing sendAlert() path.
 *               Reserved for conditions that genuinely need owner judgment or
 *               authorization (secret rotation, billing, "should I do X").
 *
 * Ledger (data/audit/alert-ledger.json) keys on conditionKey: a condition
 * notifies ONCE per open incident. Re-fires while the incident is still open
 * are silent (only lastSeen/notifyCount move) until either `cooldownHours`
 * elapses (default 7 days — matches the plan's "known-accepted condition"
 * snooze) or resolveCondition(conditionKey) is called, which the caller
 * should do the moment its own check goes back to green. A resolved
 * condition that reoccurs is treated as a NEW incident and notifies again
 * immediately, regardless of cooldown.
 *
 * Known limitation (accepted for Sprint 1): the ledger is a git-committed
 * JSON file, not a distributed lock. Two CI runs that both call routeAlert()
 * for the SAME conditionKey from a fresh checkout at nearly the same moment
 * can both read "no open incident" and both dispatch — the loser's commit
 * then gets overwritten by push-with-retry.sh's last-writer-wins conflict
 * resolution on data/audit/*.json, so that condition looks "new" again next
 * run too. Outcome is a duplicate card/email, not a crash or lost alert —
 * acceptable for a single-owner project; harden with a real lock (e.g. the
 * pattern in scripts/lib/send-lock.js) if duplicates become a real problem.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { sendAlert } = require('./discord-notify');

const REPO_ROOT = path.join(__dirname, '..', '..');
const LEDGER_PATH = path.join(REPO_ROOT, 'data', 'audit', 'alert-ledger.json');
const DIGEST_QUEUE_PATH = path.join(REPO_ROOT, 'data', 'audit', 'alert-digest-queue.json');

const DISPOSITIONS = ['auto', 'digest', 'human'];
const DEFAULT_COOLDOWN_HOURS = 168; // 7 days

function loadLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.conditions) return parsed;
  } catch { /* missing/corrupt — start fresh */ }
  return { conditions: {} };
}

function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  // Atomic write: a kill mid-write must not truncate the ledger and drop
  // every condition's open/silent state (same pattern as notion-action-poll.js).
  const tmp = `${LEDGER_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n');
  fs.renameSync(tmp, LEDGER_PATH);
}

function hoursSince(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / (1000 * 60 * 60);
}

// notion-brain.js rejects "Not started" cards whose Notes total <300 chars
// (feedback_notion_card_context.md). The template below clears that floor
// for realistic inputs, but a very short description + short conditionKey
// can land right on the edge — pad explicitly rather than relying on margin.
const MIN_NOTES_LENGTH = 320;

function buildCardNotes({ description, hint, fields, conditionKey }) {
  const fieldLines = (fields || []).map(f => `- **${f.name}:** ${f.value}`).join('\n');
  const parts = [
    '## Problem',
    description || '(no description provided)',
  ];
  if (fieldLines) parts.push(fieldLines);
  parts.push(`\n## Suggested approach\n${hint || 'Investigate the condition and fix the root cause.'}`);
  parts.push(`\n## Acceptance criteria\nCondition "${conditionKey}" no longer fires on the next check. If it recurs, this card (or a fresh one) will re-open automatically — do not close this as "won't fix" without noting why.`);
  let notes = parts.join('\n');
  if (notes.length < MIN_NOTES_LENGTH) {
    notes += `\n\nFiled automatically by owner-alert-router.js (conditionKey: ${conditionKey}).`;
  }
  return notes;
}

// Files a Notion Action Queue card via the CLI (never MCP — see CLAUDE.md).
// Returns { ok, cardId } — never throws; a dispatch failure degrades to a
// logged warning rather than crashing the caller's own check/pipeline.
function dispatchCard({ title, description, hint, fields, severity, cardAction, priority, category, tags, conditionKey }) {
  const notes = buildCardNotes({ description, hint, fields, conditionKey });
  const resolvedPriority = priority || (severity === 'critical' || severity === 'error' ? 'P1 Next' : 'P2 Later');
  const resolvedTags = ['alert-router', ...(tags || [])].join(',');
  const args = [
    path.join(__dirname, '..', 'notion-brain.js'),
    'create', title,
    '--status', 'Not started',
    '--action', cardAction || 'Investigate',
    '--priority', resolvedPriority,
    '--category', category || 'Infra',
    '--tags', resolvedTags,
    '--notes', notes,
  ];
  try {
    // 15s: a single Notion page-create call. Callers that dispatch many
    // conditions in a loop (e.g. health-check.js) cap total dispatches per
    // run separately — this timeout only bounds one call's worst case.
    const out = execFileSync('node', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 });
    const parsed = JSON.parse(out);
    return { ok: true, cardId: parsed.id || null };
  } catch (err) {
    console.error(`[alert-router] card dispatch failed for "${title}": ${err.message.slice(0, 300)}`);
    return { ok: false, error: err.message };
  }
}

function queueDigestLine({ title, description, severity, conditionKey, url }) {
  let queue = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(DIGEST_QUEUE_PATH, 'utf8'));
    if (Array.isArray(parsed)) queue = parsed;
  } catch { /* missing/corrupt — start fresh */ }
  // Replace any existing queued line for the same condition instead of
  // stacking duplicates if the digest hasn't been drained yet.
  queue = queue.filter(q => q.conditionKey !== conditionKey);
  queue.push({ conditionKey, title, description, severity, url: url || null, queuedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(DIGEST_QUEUE_PATH), { recursive: true });
  fs.writeFileSync(DIGEST_QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n');
}

// Reads and clears the digest queue — called by the Daily Digest composer
// once per send so queued lines appear exactly once.
function drainDigestQueue() {
  let queue = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(DIGEST_QUEUE_PATH, 'utf8'));
    if (Array.isArray(parsed)) queue = parsed;
  } catch { /* missing/corrupt — nothing to drain */ }
  if (queue.length > 0) {
    fs.mkdirSync(path.dirname(DIGEST_QUEUE_PATH), { recursive: true });
    fs.writeFileSync(DIGEST_QUEUE_PATH, JSON.stringify([], null, 2) + '\n');
  }
  return queue;
}

/**
 * routeAlert(opts) — the single entry point every owner-facing alert should call.
 *
 * Required: conditionKey (stable per-incident-type id, e.g. 'health-check:Cookies: expiration'),
 *           title, disposition ('auto'|'digest'|'human').
 * Optional: description, hint (suggested fix — becomes the card's "Suggested
 *           approach" or is folded into the email body), severity (default
 *           'error'), fields ([{name,value}]), url, cardAction (Notion Action
 *           value for disposition='auto', default 'Investigate'), priority,
 *           category, tags, cooldownHours (default 7 days).
 *
 * Returns { action: 'silent'|'auto'|'digest'|'human', conditionKey, cardId? }.
 */
async function routeAlert(opts) {
  const {
    conditionKey,
    title,
    description = '',
    hint = '',
    severity = 'error',
    disposition,
    fields = [],
    url,
    cardAction,
    priority,
    category,
    tags,
    cooldownHours = DEFAULT_COOLDOWN_HOURS,
  } = opts || {};

  if (!conditionKey) throw new Error('routeAlert requires a stable conditionKey');
  if (!title) throw new Error('routeAlert requires a title');
  if (!DISPOSITIONS.includes(disposition)) {
    throw new Error(`routeAlert: invalid disposition "${disposition}" (must be one of ${DISPOSITIONS.join('|')})`);
  }

  const ledger = loadLedger();
  const existing = ledger.conditions[conditionKey];
  const now = new Date().toISOString();

  if (existing && existing.status === 'open' && hoursSince(existing.lastNotifiedAt) < cooldownHours) {
    existing.lastSeen = now;
    existing.silentRefires = (existing.silentRefires || 0) + 1;
    saveLedger(ledger);
    return { action: 'silent', conditionKey, cardId: existing.cardId || null };
  }

  // New incident: first time, or reoccurred after resolveCondition() /
  // cooldown expiry. Dispatch per disposition.
  const result = { action: disposition, conditionKey };
  let notifyOk = true;
  if (disposition === 'auto') {
    const dispatch = dispatchCard({ title, description, hint, fields, severity, cardAction, priority, category, tags, conditionKey });
    result.cardId = dispatch.cardId || null;
    result.dispatchOk = dispatch.ok;
    notifyOk = dispatch.ok;
  } else if (disposition === 'digest') {
    queueDigestLine({ title, description, severity, conditionKey, url });
  } else if (disposition === 'human') {
    const delivered = await sendAlert({ title, description, severity, fields, url, email: true });
    result.delivered = delivered;
    notifyOk = delivered;
  }

  if (!notifyOk) {
    // Dispatch/delivery failed (Notion down, Resend down, etc). Do NOT record
    // this as a notified incident — if we did, the silent-refire branch above
    // would suppress the NEXT attempt too, for up to cooldownHours, even
    // though nobody was ever actually told. Leaving the ledger untouched
    // means the next call retries as if this one never happened.
    console.error(`[alert-router] notify failed for "${title}" (${conditionKey}) — not recording as notified, will retry next call`);
    return result;
  }

  ledger.conditions[conditionKey] = {
    status: 'open',
    disposition,
    title,
    firstSeen: existing?.firstSeen || now,
    lastSeen: now,
    lastNotifiedAt: now,
    notifyCount: (existing?.notifyCount || 0) + 1,
    cardId: result.cardId !== undefined ? result.cardId : (existing?.cardId || null),
  };
  saveLedger(ledger);
  return result;
}

// Call the moment the underlying check goes back to green — lets the next
// occurrence notify immediately instead of waiting out the cooldown.
// Returns true if an open incident was actually resolved (false = no-op).
function resolveCondition(conditionKey) {
  const ledger = loadLedger();
  const existing = ledger.conditions[conditionKey];
  if (!existing || existing.status !== 'open') return false;
  existing.status = 'resolved';
  existing.resolvedAt = new Date().toISOString();
  saveLedger(ledger);
  return true;
}

module.exports = {
  routeAlert,
  resolveCondition,
  loadLedger,
  drainDigestQueue,
  DEFAULT_COOLDOWN_HOURS,
  DISPOSITIONS,
  // exported for tests only
  _LEDGER_PATH: LEDGER_PATH,
  _DIGEST_QUEUE_PATH: DIGEST_QUEUE_PATH,
};
