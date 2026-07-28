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
 *   - 'human':  sends an immediate email via the existing sendAlert() path —
 *               BUT only if conditionKey is on the page-worthy allowlist in
 *               ./page-worthy-alerts.js (owner mandate 2026-07-28, card
 *               #611: "NO sender emails me directly anymore" except a tiny
 *               explicit list). Any other conditionKey requesting 'human' is
 *               transparently downgraded to 'digest' — the caller still gets
 *               back the disposition it asked for having been honored in
 *               spirit (the owner IS told), just not by immediate email.
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
const { isPageWorthy } = require('./page-worthy-alerts');

const REPO_ROOT = path.join(__dirname, '..', '..');
const LEDGER_PATH = path.join(REPO_ROOT, 'data', 'audit', 'alert-ledger.json');
const DIGEST_QUEUE_PATH = path.join(REPO_ROOT, 'data', 'audit', 'alert-digest-queue.json');
// Append-only attempt log for disposition='auto' dispatches — logs EVERY
// attempt (success or failure), unlike the ledger above which only ever
// records successes (a failed dispatch is deliberately not written there, so
// the next call retries). health-check.js's deadman check (#374) reads this
// to compare "attempts" vs "successes" over a trailing window — the ledger
// alone can't answer that question, because during the 2026-07-24 npm-ci
// incident every single dispatch failed, so the ledger would have shown ZERO
// activity all week even though the router was attempting (and silently
// failing) auto-dispatch on every run.
const ATTEMPTS_LOG_PATH = path.join(REPO_ROOT, 'data', 'audit', 'alert-router-attempts.jsonl');
const ATTEMPTS_LOG_RETENTION_DAYS = 30;

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

// Appends one attempt record (success or failure) to ATTEMPTS_LOG_PATH and
// prunes entries older than ATTEMPTS_LOG_RETENTION_DAYS. Never throws —
// logging the attempt must not itself become a new silent-failure vector.
function logDispatchAttempt({ conditionKey, title, ok, error }) {
  try {
    const cutoff = Date.now() - ATTEMPTS_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let lines = [];
    try {
      lines = fs.readFileSync(ATTEMPTS_LOG_PATH, 'utf8').split('\n').filter(Boolean);
    } catch { /* missing — first attempt */ }
    const kept = lines.filter(line => {
      try {
        return new Date(JSON.parse(line).ts).getTime() >= cutoff;
      } catch { return false; }
    });
    kept.push(JSON.stringify({
      ts: new Date().toISOString(),
      conditionKey,
      title,
      ok,
      error: error ? String(error).slice(0, 500) : null,
    }));
    fs.mkdirSync(path.dirname(ATTEMPTS_LOG_PATH), { recursive: true });
    fs.writeFileSync(ATTEMPTS_LOG_PATH, kept.join('\n') + '\n');
  } catch (err) {
    console.error(`[alert-router] failed to write attempt log (non-fatal): ${err.message}`);
  }
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
    logDispatchAttempt({ conditionKey, title, ok: true });
    return { ok: true, cardId: parsed.id || null };
  } catch (err) {
    // Log the REAL error verbatim — this is the exact spot the npm-ci incident
    // (2026-07-24) got misdiagnosed as a NOTION_API_KEY problem. err.message
    // from execFileSync includes stderr, so it carries whatever notion-brain.js
    // actually printed (e.g. "Cannot find module '@notionhq/client'").
    console.error(`[alert-router] card dispatch failed for "${title}": ${err.message.slice(0, 300)}`);
    logDispatchAttempt({ conditionKey, title, ok: false, error: err.message });
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

// Reads the digest queue WITHOUT clearing it. Prefer peek + clearDigestQueue()
// over drainDigestQueue() when the consumer does substantial work between
// reading and durably persisting the lines: a read-and-clear leaves a window
// where a throw loses the lines permanently. Permanently, not transiently —
// the ledger already recorded those conditions as notified, so routeAlert()
// will not re-queue them (cooldownHours, default 7 days), and a one-shot
// event like a regional show going live never fires again at all.
function peekDigestQueue() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DIGEST_QUEUE_PATH, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  } catch { /* missing/corrupt — nothing queued */ }
  return [];
}

// Clears the queue. Call only AFTER the peeked lines are durably persisted.
function clearDigestQueue() {
  fs.mkdirSync(path.dirname(DIGEST_QUEUE_PATH), { recursive: true });
  fs.writeFileSync(DIGEST_QUEUE_PATH, JSON.stringify([], null, 2) + '\n');
}

// Removes specific queued lines without touching the rest of the queue.
// For callers that queue optimistically and then discover the underlying action
// was rolled back — without this, the owner is told something shipped that
// didn't. Pair it with resolveCondition()/deleteCondition() so the ledger stops
// claiming the condition was already notified, otherwise the cooldown silences
// the NEXT (real) occurrence. Returns the number of lines removed.
function removeDigestLines(conditionKeys) {
  const keys = new Set(Array.isArray(conditionKeys) ? conditionKeys : [conditionKeys]);
  const queue = peekDigestQueue();
  const kept = queue.filter(q => !q || !keys.has(q.conditionKey));
  if (kept.length !== queue.length) {
    fs.mkdirSync(path.dirname(DIGEST_QUEUE_PATH), { recursive: true });
    fs.writeFileSync(DIGEST_QUEUE_PATH, JSON.stringify(kept, null, 2) + '\n');
  }
  return queue.length - kept.length;
}

// Reads and clears in one step — retained for callers whose read and use are
// adjacent. See peekDigestQueue() for why a wide read-to-persist gap should
// use the two-step form instead.
function drainDigestQueue() {
  const queue = peekDigestQueue();
  if (queue.length > 0) clearDigestQueue();
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

  // Page-worthy gate (card #611): 'human' only actually pages if conditionKey
  // is on the allowlist. Everything else requesting 'human' is transparently
  // downgraded to 'digest' — the caller's requested disposition is honored in
  // spirit (the owner is still told, just not by immediate email).
  const pageGated = disposition === 'human' && !isPageWorthy(conditionKey);
  const effectiveDisposition = pageGated ? 'digest' : disposition;
  if (pageGated) {
    console.log(`[alert-router] disposition 'human' requested for "${conditionKey}" ("${title}") is not on the page-worthy allowlist — routed to the morning digest instead. Add it to scripts/lib/page-worthy-alerts.js if this should page immediately.`);
  }

  // New incident: first time, or reoccurred after resolveCondition() /
  // cooldown expiry. Dispatch per effective disposition.
  const result = { action: effectiveDisposition, conditionKey };
  if (pageGated) result.requestedDisposition = disposition;
  let notifyOk = true;
  if (effectiveDisposition === 'auto') {
    const dispatch = dispatchCard({ title, description, hint, fields, severity, cardAction, priority, category, tags, conditionKey });
    result.cardId = dispatch.cardId || null;
    result.dispatchOk = dispatch.ok;
    // Propagate the real dispatch error (not just the ok/fail boolean) so
    // callers — the E2E canary, health-check.js's dispatchedCards mapping —
    // can surface the true underlying failure instead of re-guessing one.
    if (!dispatch.ok) result.dispatchError = dispatch.error;
    notifyOk = dispatch.ok;
  } else if (effectiveDisposition === 'digest') {
    queueDigestLine({ title, description, severity, conditionKey, url });
  } else if (effectiveDisposition === 'human') {
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
    disposition: effectiveDisposition,
    ...(pageGated ? { requestedDisposition: disposition } : {}),
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

// Hard-removes a condition from the ledger — for synthetic/test conditions
// only (e.g. the E2E canary's fixed conditionKeys). Real conditions should
// use resolveCondition() so history (firstSeen/notifyCount) is preserved;
// this exists so a canary run leaves zero residue and always re-dispatches
// fresh on its next run instead of going silent under the normal cooldown.
function deleteCondition(conditionKey) {
  const ledger = loadLedger();
  if (!(conditionKey in ledger.conditions)) return false;
  delete ledger.conditions[conditionKey];
  saveLedger(ledger);
  return true;
}

// Reads the trailing-N-day dispatch attempt log for disposition='auto'
// dispatches — used by health-check.js's deadman check to compare attempts
// vs successes independent of the ledger (see ATTEMPTS_LOG_PATH comment).
// Sorted oldest→newest by `ts` (ship-check finding): logDispatchAttempt()
// rewrites the file after filtering, and a rebase conflict resolution or
// manual edit could disturb append order, so callers that need "the most
// recent attempt" must not assume array order == chronological order.
function readDispatchAttempts({ days = 7 } = {}) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let lines = [];
  try {
    lines = fs.readFileSync(ATTEMPTS_LOG_PATH, 'utf8').split('\n').filter(Boolean);
  } catch { /* missing — no attempts logged yet */ }
  return lines
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .filter(entry => new Date(entry.ts).getTime() >= cutoff)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

module.exports = {
  routeAlert,
  isPageWorthy, // re-exported for callers/tests that want to check gating without calling routeAlert
  resolveCondition,
  deleteCondition,
  loadLedger,
  drainDigestQueue,
  peekDigestQueue,
  clearDigestQueue,
  removeDigestLines,
  readDispatchAttempts,
  DEFAULT_COOLDOWN_HOURS,
  DISPOSITIONS,
  // exported for tests only
  _LEDGER_PATH: LEDGER_PATH,
  _DIGEST_QUEUE_PATH: DIGEST_QUEUE_PATH,
  _ATTEMPTS_LOG_PATH: ATTEMPTS_LOG_PATH,
};
