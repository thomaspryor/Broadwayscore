/**
 * digest-autofix — the morning digest FIXES issues instead of asking the owner.
 *
 * Owner mandate 2026-08-02 (fifth escalation on this email, verbatim): "Why do
 * I need to hit 'Fix this'. I'm obvi going to hit it for everything here. So
 * why EVEN ASK ME? … Just have a Claude session fix them."
 *
 * The Fix-this button (card #634) was a human finger in front of an already
 * automated pipeline: the button's endpoint files a "BSC Daily: <name>" card
 * and the backlog drain / bsc-next --headless dispatches cards as fix
 * sessions. This module removes the finger: at digest-build time every named
 * health issue gets its card filed (deduped against the shared task list) and
 * the oldest few are dispatched through the EXACT same detached
 * `bsc-next.js --id N --headless` spawn the backlog drain uses
 * (scripts/backlog-drain.js) — one code path, same guards (duplicate lease,
 * dead-dispatch, verify gate), no new dispatch machinery.
 *
 * Safety rails:
 *  - DISPATCH_CAP per digest run (a 14-warning morning queues, never fans out
 *    14 sessions; the drain's own 3 ticks/day keep draining the rest).
 *  - Dedup: an open task whose subject contains "BSC Daily: <name>" (or the
 *    email-worker's "Fix: BSC Daily: <name>" variant) is NEVER re-filed —
 *    same conditionKey idea as api/autonomous-action handleDispatch.
 *  - bsc-next's own refusal guards still apply to every dispatch (this module
 *    deliberately spawns the CLI, never re-implements its checks — the same
 *    reasoning as backlog-drain.js's header comment).
 *  - Everything is fail-soft: a broken create/dispatch degrades that ONE row
 *    to 'card-failed'/'dispatch-attempted', never blocks the email.
 *
 * Digest v3.1 (task #843, owner escalation 2026-08-02, verbatim: "why do I
 * need to hit 'Fix this'... I'm obvi going to hit it for everything here"):
 * the "Needs your attention" bucket (owner-alert-router's disposition:'digest'
 * queue — scripts/lib/owner-alert-router.js's queueDigestLine) got ZERO
 * autofix coverage — every row rendered as a bare Dispatch-a-fix button,
 * forever, because planAutofix only ever read health.errors/warns/
 * extraIssues. planAutofix now also accepts `queued` (health.queued, same
 * {conditionKey,title,description,severity,url} shape) and folds each row
 * into the SAME plan/dispatch pipeline as a health row — UNLESS the caller
 * marked it `decision: true` (a genuine judgment call, e.g. "raise the
 * budget vs cut spend"), which renders a button and NEVER auto-dispatches.
 * Default (no `decision` flag) is auto-dispatch — matches the owner's own
 * read that both examples that prompted this card (scraping spend over
 * budget, main test.yml still red) are technical investigations, not
 * decisions.
 *
 * Attempt-memory (reusing #635's scripts/lib/attempt-memory.js, same
 * pattern as scripts/lib/backlog-drain.js's header comment: attempt-memory
 * was built for the paused nightly loop's own ledger, so THIS module feeds
 * it entries from its OWN ledger, data/audit/digest-autofix-ledger.jsonl,
 * shape-compatible: {cardId, contentHash, event: 'card-pass'|'card-fail'}).
 * A row that fails twice unchanged is 'parked', never redispatched blind.
 * A row's SECOND dispatch attempt (same content, first attempt failed)
 * escalates to --model opus — the loop's own "hard enough to escalate"
 * policy (scripts/lib/bsc-next-model.js), applied here explicitly since
 * these headless dispatches carry no triage-queue entry for bsc-next's own
 * model resolution to key off.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const dispatchLedger = require('./dispatch-ledger.js');
const { checkPark, computeContentHash } = require('./attempt-memory.js');

const REPO = path.join(__dirname, '..', '..');
const LOG_DIR = path.join(REPO, 'data', 'audit', 'digest-autofix-logs');
const DIGEST_LEDGER_PATH = path.join(REPO, 'data', 'audit', 'digest-autofix-ledger.jsonl');
const DISPATCH_CAP = 3;
// A dispatched row's bsc-runner job-spawned event never arrives (refused
// before it ever reached bsc-runner — same failure modes backlog-drain.js
// documents: runner disabled, live cmux duplicate, lease already held).
// Without a timeout the row would sit unresolved forever, permanently
// occupying attempt-memory's "in flight" slot.
const ORPHAN_TIMEOUT_H = 3;
const VALID_MODELS = new Set(['opus', 'sonnet', 'haiku']);

// Canonical row-family key (BRO-232 S4): different checks sometimes name the
// SAME underlying condition two different ways — health-check.js's own
// last-run-failure scan emits "Cron failed: X" while its repeat-failure scan
// emits "Workflow repeat-failure: X" for the identical workflow. Without a
// shared key, card filing / matchOpenTask / ledger grouping treated them as
// two unrelated rows, splitting attempt-memory across two cards that could
// never individually resolve (fixing the workflow clears BOTH names at once).
const ROW_FAMILY_PREFIXES = [
  /^Cron failed:\s*/i,
  /^Workflow repeat-failure:\s*/i,
];

// Strips ONE matching family prefix, leaving the rest as the display form.
// Returns the name unchanged when no prefix matches — the common case, byte-
// identical to today's behavior for the vast majority of rows.
function familyDisplayName(name) {
  const s = String(name || '').trim();
  for (const re of ROW_FAMILY_PREFIXES) {
    const stripped = s.replace(re, '');
    if (stripped !== s) return stripped.trim();
  }
  return s;
}

// Match key: family display name, case/whitespace-normalized.
function rowFamilyKey(name) {
  return familyDisplayName(name).toLowerCase().replace(/\s+/g, ' ');
}

const OPEN_TASK_SUBJECT_RE = /^(?:Fix: )?BSC Daily: (.+)$/;

// Which open task (pending/in_progress) already covers this health issue?
// Family-key compared (BRO-232 S4), not literal substring: a task filed
// under one prefix variant ("BSC Daily: Cron failed: X") now also covers a
// row that arrives under the sibling variant ("Workflow repeat-failure: X")
// once both compute the same canonical title (see planAutofix below) — this
// keeps matchOpenTask consistent with fileCard's own title collapse instead
// of a second row-family-blind copy of the same "already tracked?" check.
function matchOpenTask(tasks, name) {
  const wantFamily = rowFamilyKey(name);
  return (tasks || []).find(t => {
    if (!t || (t.status !== 'pending' && t.status !== 'in_progress')) return false;
    const m = OPEN_TASK_SUBJECT_RE.exec(String(t.subject || ''));
    if (!m) return false;
    return rowFamilyKey(m[1]) === wantFamily;
  }) || null;
}

// Some health rows self-document that they're already tracked, owner-accepted,
// and expected to clear on their own by a known date — the shared suffix shape
// emitted by scripts/lib/scrapingbee-ack.js / scrapingdog-ack.js:
// " — acknowledged: <reason> [expires YYYY-MM-DD]". Those rows stay 'warn'
// (by design — see task #367/#353) until the stamped date, so a P1 "fix this"
// card filed against them can never mechanically resolve before then; it's
// pure noise on top of the acknowledgment that already exists (task #804
// duplicated the already-closed #224 this exact way; #803 is the ScrapingDog
// cousin). Skip card-filing for these while the ack is still live.
const ACKNOWLEDGED_ROW_RE = /acknowledged:.*\[expires\s+(\d{4}-\d{2}-\d{2})\]/i;

function isRowAcknowledged(message, today) {
  const m = ACKNOWLEDGED_ROW_RE.exec(String(message || ''));
  if (!m) return false;
  const todayDate = today || new Date().toISOString().slice(0, 10);
  return m[1] > todayDate;
}

// Normalizes health.errors/warns/extraIssues rows and health.queued (digest-
// queue) rows into ONE shape planAutofix can iterate uniformly. Queued rows
// carry conditionKey/decision/decisionPrompt/model — health rows don't, so
// those come back null/false for them (harmless: nothing reads them there).
function normalizeQueuedRows(queued) {
  return (Array.isArray(queued) ? queued : []).filter(q => q && q.title).map(q => ({
    name: q.title,
    message: q.description || q.title,
    decision: !!q.decision,
    decisionPrompt: q.decisionPrompt || null,
    model: q.model && VALID_MODELS.has(q.model) ? q.model : null,
    conditionKey: q.conditionKey || null,
  }));
}

/**
 * Pure planner (CLAUDE.md §15): health rows + extra issues + queued
 * "Needs your attention" rows + current tasks → per-issue action plan. No
 * I/O so the digest tests can exercise the real decision table.
 * @returns {Array<{name, message, title, state, taskId, conditionKey, model}>}
 *   state: 'in-progress' | 'queued' | 'needs-card' | 'acknowledged' | 'decision' | 'parked'
 *   ('parked' is only ever set by runAutofix, never by planAutofix.)
 */
function planAutofix({ health, extraIssues = [], tasks = [], today, queued } = {}) {
  const rows = [
    ...(Array.isArray(health?.errors) ? health.errors : []),
    ...(Array.isArray(health?.warns) ? health.warns : []),
    ...extraIssues,
    ...normalizeQueuedRows(queued),
  ].filter(r => r && r.name);
  return rows.map(r => {
    const rawMessage = String(r.message || '');
    const message = rawMessage.slice(0, 400);
    // Family-collapsed (BRO-232 S4): two rows naming the SAME condition two
    // ways ("Cron failed: X" / "Workflow repeat-failure: X") now compute the
    // identical title, so fileCard's exact-title Linear dedup — and, for any
    // residual Notion-mirror task, matchOpenTask below — converge them onto
    // ONE card instead of filing/tracking a duplicate per name variant. The
    // raw r.name (never family-collapsed) still drives buildCardNotes' prose
    // and its check-health-row-absent.js verify command, which must keep
    // checking the SPECIFIC health-check row that was actually seen.
    const title = `BSC Daily: ${familyDisplayName(r.name)}`;
    const conditionKey = r.conditionKey || null;

    // Decision items (owner-alert-router callers that opted in via
    // `decision: true`) are a genuine judgment call, not a fix — they never
    // get a card filed or a session dispatched by this module. The digest
    // renders these with a button instead (send-morning-digest.js keeps
    // them in sections.health.queued by matching on conditionKey).
    if (r.decision) {
      return { name: r.name, message, title, state: 'decision', taskId: null, conditionKey, model: null, decisionPrompt: r.decisionPrompt || null };
    }

    const existing = matchOpenTask(tasks, r.name);
    // Check the ack marker against the FULL text first — 400-char truncation
    // could otherwise sever a long reason's trailing "[expires ...]" token
    // and silently revert an acknowledged row to needs-card (ship-check P2).
    const acknowledged = !existing && isRowAcknowledged(rawMessage, today);
    if (acknowledged) {
      return { name: r.name, message, title, state: 'acknowledged', taskId: null, conditionKey, model: null, wasNew: false };
    }
    const state = existing ? (existing.status === 'in_progress' ? 'in-progress' : 'queued') : 'needs-card';
    return {
      name: r.name,
      message,
      title,
      state,
      taskId: existing ? existing.id : null,
      conditionKey,
      model: r.model || null,
      // Plan-time guess (BRO-232 S4 digest-subject split, send-morning-
      // digest.js's buildSubject): true only when NOTHING already tracked
      // this row's family. runAutofix overrides this for 'needs-card' rows
      // once it knows the REAL answer from fileCard's live Linear lookup —
      // matchOpenTask only sees the Notion-mirror task list, which
      // digest-autofix's own Linear-filed cards never populate post-BRO-286
      // (no mirror-sync path exists for them), so this default is a fallback
      // for dry-run/degraded runs where fileCard never executes, not the
      // final answer for a real send.
      wasNew: state === 'needs-card',
    };
  });
}

// Row text comes from health-check output (semi-trusted: workflow names and
// scraped strings can leak in). extractVerifyCmd treats the FIRST
// "## Acceptance criteria" section / any "VERIFY:" line / backticked span in
// the notes as the card's executable proof, so hostile row text could inject
// its own safe-but-unrelated command (Codex finding, 2026-08-02). Neutralize
// the three carriers before interpolating.
function sanitizeRowText(s) {
  return String(s || '')
    .replace(/`/g, "'")
    .replace(/^#+\s/gm, '')
    .replace(/VERIFY\s*:/gi, 'VERIFY -');
}

// The b64url token must fit SAFE_CHECK_FORMS' 200-char cap AND decode back to
// exactly what check-health-row-absent.js compares — so BOTH sides slice the
// row name to the same bound (120 chars ≈ ≤160 b64 chars even for multi-byte).
const ROW_NAME_MATCH_LIMIT = 120;

// Card notes must pass notion-brain's card-quality gate for "Not started"
// cards: ## Problem + ## Suggested approach + ## Acceptance criteria sections
// and >=300 chars (the gate rejected the first live send's shorter format).
function buildCardNotes(row) {
  const name = sanitizeRowText(row.name);
  const message = sanitizeRowText(row.message);
  return [
    '## Problem',
    `The daily health check (\`node scripts/health-check.js\`) reports an issue named "${name}": ${message || '(no detail message — reproduce locally for specifics)'}`,
    '',
    '## Evidence',
    `Auto-filed by the morning digest (Digest v3, owner mandate 2026-08-02: fix automatically, never ask). The row appeared in today's health-check errors/warnings; the message above is the check's own output.`,
    '',
    '## Suggested approach',
    `Run \`node scripts/health-check.js\` to reproduce, then grep scripts/health-check.js for the check that emits "${row.name}" to find the underlying data source or workflow. Fix the root cause (not the check), and include prevention per CLAUDE.md.`,
    '',
    '## Acceptance criteria',
    // The backticked command is the machine-checkable proof bsc-next's verify
    // gate arms and the nightly acceptance recheck re-runs. base64url keeps
    // the row name a single token (SAFE_CHECK_FORMS + quote-free argv split).
    // Encode the RAW name (the checker compares against raw snapshot names);
    // only prose gets sanitized. Slice matches the checker's own bound.
    `\`node scripts/check-health-row-absent.js --row-b64 ${Buffer.from(String(row.name).trim().slice(0, ROW_NAME_MATCH_LIMIT), 'utf8').toString('base64url')}\` passes — i.e. the daily health check no longer lists "${name}" among errors or warnings.`,
  ].join('\n');
}

// File one Notion card. Extracted (task #1225) so the digest-autofix canary
// (scripts/lib/autofix-canary.js) reuses the EXACT same create call instead
// of a second copy that would drift the next time this one is fixed
// (CLAUDE.md §15). Callers that file several cards in one pass (runAutofix
// below) call this per-row, then ONE syncTasks() at the end — deliberately
// NOT folded into a single fileCardAndSync helper, since batching the sync
// after N creates (not N syncs) is the whole point of that shape.
//
// Phase 0 rail 2 (plan 2026-08-12, task #1341) deliberately does NOT wire the
// owner-alert-router.js Linear dedupe (findLinearDuplicate) in here. It would
// need to `await` before this call, and runAutofix()/fileCard() are
// synchronous top to bottom — 1 production call site (send-morning-digest.js)
// but 9 synchronous call sites in this file's own test suite
// (digest-autofix.test.mjs) would all need converting to async alongside it.
// That's a real refactor of a critical-tier dispatch file, not the "cheap to
// reach" case the rail's plan explicitly carved out — left for a follow-up
// rather than rushed in here. Health-check-sourced rows rarely share a
// conditionKey with a hand-filed Linear issue in practice (they're filed by
// name, not conditionKey, prior to this rail), so the exposure this leaves
// open is narrow.
// BRO-286 Phase 2 intake repoint (2026-08-12): files a LINEAR issue via the
// linear-brain.js CLI (single createLinearIssue() chokepoint underneath,
// CI-gated) instead of a Notion card. Returns { ok, identifier } — identifier
// is the human id ("BRO-287") the caller threads straight onto its row as
// `linear:BRO-287`, REPLACING the old file→syncTasks→matchOpenTask numeric-
// task resolution dance (there is no Notion mirror card to resolve anymore).
function fileCard(title, notes, { log = () => {} } = {}) {
  // Dedup BEFORE filing (BRO-286 merge-review P0): a persistent health row
  // hits this every morning, and the Notion-mirror dedup (matchOpenTask in
  // planAutofix) can't see Linear issues — without this check the same row
  // mints one duplicate issue per day, each fresh identifier resetting
  // attempt-memory (park/opus-escalation never trigger) and pressuring the
  // 250-issue cap. Matching the existing OPEN issue by exact title keeps the
  // row's taskId stable across days, so checkPark/priorAttempts keep
  // working. Fail-open: a find error just means we file (worst case one
  // duplicate, same as a transient Linear outage).
  try {
    const found = execFileSync('node', [path.join(REPO, 'scripts', 'linear-brain.js'), 'find', title, '--exact-title'],
      { cwd: REPO, encoding: 'utf8', timeout: 30000 });
    const fm = found.match(/"identifier":\s*"([A-Z]+-\d+)"/);
    if (fm) {
      log(`[digest-autofix] row already tracked as ${fm[1]} — reattaching instead of filing a duplicate`);
      return { ok: true, identifier: fm[1], existing: true };
    }
  } catch (err) {
    log(`[digest-autofix] WARN Linear dedup lookup failed (filing anyway): ${String(err.message).slice(0, 120)}`);
  }
  try {
    const out = execFileSync('node', [path.join(REPO, 'scripts', 'linear-brain.js'), 'create', title,
      // Linear priority 2 = High (scale: 1 Urgent / 2 High / 3 Medium / 4
      // Low) — same intent as the old 'P1' Notion priority: auto-fix rows
      // are dispatch-eligible immediately.
      '--priority', '2',
      '--notes', notes,
      // task #1310: filing and dispatching are deliberately separate steps
      // here (see header comment above) — this call only ever files; the
      // caller's own dispatchDetached() (below) is the real dispatch.
      '--park', 'Auto-filed by digest-autofix; runAutofix dispatches via linear-next separately in the same pass.',
    ], { cwd: REPO, encoding: 'utf8', timeout: 60000 });
    // linear-brain prints the issue JSON then a PARKED: line — the field is
    // `.identifier` (NOT `.id`, which is the opaque UUID).
    const m = out.match(/"identifier":\s*"([A-Z]+-\d+)"/);
    if (!m) {
      log(`[digest-autofix] WARN issue created but identifier not found in output for "${title}"`);
      return { ok: false, identifier: null };
    }
    log(`[digest-autofix] filed issue ${m[1]}: ${title}`);
    return { ok: true, identifier: m[1] };
  } catch (err) {
    log(`[digest-autofix] WARN issue create failed for "${title}": ${String(err.message).slice(0, 120)}`);
    return { ok: false, identifier: null };
  }
}

// Pull newly filed cards into the shared task list so they get task numbers.
function syncTasks({ log = () => {} } = {}) {
  try {
    execFileSync('node', [path.join(REPO, 'scripts', 'notion-tasks-sync.js'), 'pull'],
      { cwd: REPO, encoding: 'utf8', timeout: 120000 });
    return true;
  } catch (err) {
    log(`[digest-autofix] WARN tasks-sync pull failed (cards stay queued for the drain): ${String(err.message).slice(0, 120)}`);
    return false;
  }
}

// Detached headless dispatch — byte-for-byte the backlog drain's pattern
// (stdio to a log file so a refusal is debuggable, unref so the digest exits).
// `model`, when set, escalates the dispatch past bsc-next's own resolution
// (these headless dispatches carry no triage-queue entry to key off) — used
// for a row's 2nd+ attempt on unchanged content, or a caller-supplied hint
// (e.g. test.yml's streak escalation, which wants opus on its first try here
// since it's already the SECOND machine attempt at the underlying failure).
function dispatchDetached(taskId, log, delaySec = 0, model = null) {
  // Validate BEFORE opening the log fd — throwing after openSync leaked a
  // file descriptor per rejected dispatch (Codex review, 2026-08-02).
  //
  // Two id shapes (BRO-286): 'linear:BRO-287' rows (the repointed fileCard
  // path) spawn linear-next.js with the bare Linear identifier; legacy
  // numeric ids keep the bsc-next.js path (rows resolved against the old
  // Notion mirror during the parallel run). Both regexes make the sh -c
  // interpolation injection-safe — anything else throws.
  const linearMatch = /^linear:([A-Z]+-\d+)$/.exec(String(taskId));
  const idNumEarly = Number(taskId);
  if (!linearMatch && (!Number.isSafeInteger(idNumEarly) || idNumEarly <= 0)) {
    throw new Error(`invalid taskId for dispatch: ${String(taskId).slice(0, 40)}`);
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${String(taskId).replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}.log`);
  const logFd = fs.openSync(logPath, 'a');
  // Staggered start: simultaneous detached spawns race on the main repo's
  // `git worktree add` lock and all but one die 'worktree-error' (live-run
  // finding 2026-08-02: 3 same-instant dispatches → 2 failed). Both id forms
  // are regex-validated above and delaySec is internal, so the sh -c line is
  // injection-safe. Codex hardening (2026-08-02): pass the script path as a
  // positional shell arg instead of interpolating it (JSON.stringify is NOT
  // shell quoting — $() would survive inside double quotes).
  const id = linearMatch ? linearMatch[1] : String(idNumEarly);
  const scriptPath = linearMatch
    ? path.join(REPO, 'scripts', 'linear-next.js')
    : path.join(REPO, 'scripts', 'bsc-next.js');
  const safeModel = model && VALID_MODELS.has(model) ? model : null;
  const modelArg = safeModel ? ` --model ${safeModel}` : '';
  const cmd = `sleep ${Math.max(0, Math.floor(delaySec))} && exec node "$1" --id ${id} --headless${modelArg}`;
  const child = spawn('sh', ['-c', cmd, 'sh', scriptPath],
    { cwd: REPO, detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  fs.closeSync(logFd);
  log(`[digest-autofix] dispatch attempted for ${linearMatch ? id : `#${id}`} (${linearMatch ? 'linear-next' : 'bsc-next'} headless, detached${safeModel ? `, model ${safeModel}` : ''}, +${delaySec}s stagger; log: ${logPath})`);
}

// ── attempt-memory plumbing (own ledger, shared dispatch-ledger for job outcomes) ──

function readJsonlLedger(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

function appendJsonlLedger(p, entry) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

// Same correlation logic as scripts/lib/backlog-drain.js's findMyJob (see
// its header comment for why "latest ts for this taskId" is unsafe): scan
// the raw shared dispatch-ledger for the job-spawned event THIS dispatch's
// child process caused (earliest spawn at/after our own dispatch timestamp),
// then fold only that jobId's entries to read its current terminal state.
function findMyJob(dispatchLedgerEntries, taskId, sinceTs) {
  const sinceMs = new Date(sinceTs).getTime() - 5000;
  const spawns = (dispatchLedgerEntries || [])
    .filter(e => e && e.event === dispatchLedger.JOB_EVENTS.SPAWNED && String(e.taskId) === String(taskId) && new Date(e.ts).getTime() >= sinceMs)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  if (!spawns.length) return null;
  // Task #1184 S1: follow job-retried chains (shared, causal implementation —
  // see dispatch-ledger.followRetryChain's header) so a live resume is never
  // scored card-fail. A chain ending at RETRIED (successor not spawned yet)
  // is handled by the caller as still-in-flight, with its own orphan bound.
  return dispatchLedger.followRetryChain(dispatchLedgerEntries, taskId, spawns[0].jobId);
}

// Resolves prior 'auto-dispatch' breadcrumbs (this module's own ledger) into
// card-pass/card-fail by cross-referencing the SHARED dispatch-ledger's job
// lifecycle — same reconciliation shape as scripts/lib/backlog-drain.js's
// reconcileOutcomes, applied to this module's own ledger file instead.
function reconcileDigestOutcomes(digestLedgerEntries, tasksById, dispatchLedgerEntries, now = new Date()) {
  const resolvedKeys = new Set(
    digestLedgerEntries.filter(e => e.event === 'card-pass' || e.event === 'card-fail')
      .map(e => `${e.cardId}:${e.contentHash}`));
  const dispatches = digestLedgerEntries.filter(e => e.event === 'auto-dispatch');
  const newEntries = [];
  for (const d of dispatches) {
    const key = `${d.taskId}:${d.contentHash}`;
    if (resolvedKeys.has(key)) continue;
    const job = findMyJob(dispatchLedgerEntries, d.taskId, d.ts);
    if (!job) {
      const ageH = (now.getTime() - new Date(d.ts).getTime()) / 3600e3;
      if (ageH < ORPHAN_TIMEOUT_H) continue; // may still spawn — recheck next run
      newEntries.push({
        event: 'card-fail', cardId: String(d.taskId), contentHash: d.contentHash,
        note: `spawn never observed within ${ORPHAN_TIMEOUT_H}h of dispatch (likely refused: runner disabled, live cmux duplicate, or lease already held)`,
      });
      resolvedKeys.add(key);
      continue;
    }
    if (job.event === dispatchLedger.JOB_EVENTS.RETRIED) {
      // Chain ends at a retry whose successor hasn't spawned yet: treat as
      // still running inside the same orphan bound the no-spawn case uses —
      // past it, the resume child died before spawning and the attempt fails.
      const ageH = (now.getTime() - new Date(job.ts || 0).getTime()) / 3600e3;
      if (ageH < ORPHAN_TIMEOUT_H) continue;
      newEntries.push({
        event: 'card-fail', cardId: String(d.taskId), contentHash: d.contentHash,
        note: `resume recorded (job ${job.jobId}) but no successor session spawned within ${ORPHAN_TIMEOUT_H}h`,
      });
      resolvedKeys.add(key);
      continue;
    }
    if (!dispatchLedger.TERMINAL_JOB_EVENTS.has(job.event)) continue; // still running
    const sessionOk = job.event === dispatchLedger.JOB_EVENTS.DONE;
    const isLinear = /^linear:/.test(String(d.taskId));
    // Completion criterion differs by tracker (BRO-286): Notion-mirror rows
    // check the mirror task's status; Linear rows have no mirror — session
    // DONE is the pass signal here, and the board-level Done audit (Phase 3
    // teeth) is the independent check that the issue actually closed.
    const task = isLinear ? null : tasksById.get(String(d.taskId));
    const completed = isLinear ? sessionOk : !!(task && task.status === 'completed');
    const outcome = (sessionOk && completed) ? 'card-pass' : 'card-fail';
    newEntries.push({
      event: outcome,
      cardId: String(d.taskId),
      contentHash: d.contentHash,
      note: outcome === 'card-pass'
        ? (isLinear ? 'session finished (Linear-tracked; board Done-audit verifies closure separately)' : 'session finished, task marked completed')
        : (sessionOk ? 'session finished but task still not completed' : `job ${job.event}${job.stage ? `: ${job.stage}` : ''}`),
    });
    resolvedKeys.add(key);
  }
  return newEntries;
}

/**
 * File missing cards, refresh the task list, dispatch up to `cap`.
 * Mutates each plan row's state to one of:
 *   'in-progress' | 'dispatched' | 'queued' | 'card-filed' | 'card-failed'
 *   | 'acknowledged' | 'decision' (left untouched — no card, no dispatch)
 *   | 'parked' (dispatch skipped — failed twice unchanged, see attempt-memory)
 * and returns the same array (annotated) for the email renderer.
 */
function runAutofix({
  plan, cap = DISPATCH_CAP, dryRun = false, log = () => {}, loadTasksFn = null,
  ledgerPath = DIGEST_LEDGER_PATH, dispatchLedgerEntriesFn = null, now = new Date(),
  dispatchFn = dispatchDetached,
} = {}) {
  if (!Array.isArray(plan) || !plan.length) return [];
  if (dryRun) {
    // Never file cards or spawn sessions on --dry-run — but show what WOULD
    // happen so the preview is honest about the new behavior.
    for (const row of plan) if (row.state === 'needs-card') row.state = 'card-filed';
    let budget = cap;
    for (const row of plan) if (row.state === 'queued' && budget > 0) { row.state = 'dispatched'; budget--; }
    return plan;
  }

  // 1. File missing trackers (dedup already done in planAutofix). BRO-286:
  //    fileCard files a LINEAR issue and returns its identifier, which is
  //    threaded straight onto the row as `linear:BRO-N` — no task-mirror
  //    sync/resolution step exists for these rows (the old notion-brain →
  //    syncTasks → matchOpenTask dance applied only to Notion cards). The
  //    "## Acceptance criteria" backticked command in buildCardNotes keeps
  //    the issue dispatchable through linear-next's verify gate, same
  //    contract the Notion verify gate had (#480).
  for (const row of plan) {
    if (row.state !== 'needs-card') continue;
    const filed = fileCard(row.title, buildCardNotes(row), { log });
    if (filed.ok) {
      row.state = 'card-filed';
      row.taskId = `linear:${filed.identifier}`;
      row.linearIdentifier = filed.identifier;
      // Overrides planAutofix's plan-time guess with the REAL answer (BRO-232
      // S4): fileCard's live exact-title Linear lookup is the only place that
      // actually knows whether this row's family was already tracked —
      // including a sibling-prefix row from THIS SAME run that filed a fresh
      // issue a moment earlier (e.g. "Cron failed: X" then "Workflow
      // repeat-failure: X" both reattaching to one issue). `existing` is only
      // set true on a dedup hit, so a brand-new issue correctly stays "new".
      row.wasNew = !filed.existing;
    } else {
      row.state = 'card-failed';
      row.wasNew = true;
    }
  }

  // 3. Re-resolve task ids. Rows whose card just got filed pick up their
  //    fresh task id here.
  let tasks = [];
  try {
    if (loadTasksFn) tasks = loadTasksFn();
    else {
      // loadTasks REQUIRES the shared task directory — calling it bare returns
      // [] silently (readdirSync(undefined) is swallowed), which killed both
      // dedup and dispatch on the first live run (Codex finding, 2026-08-02).
      const bn = require('../bsc-next.js');
      tasks = bn.loadTasks(bn.TASKS_DIR);
    }
  } catch { /* dispatch skipped below */ }
  const tasksById = new Map(tasks.map(t => [String(t.id), t]));

  // 4. Attempt-memory: reconcile prior dispatches from THIS module's own
  //    ledger, then compute a park check per row before spending dispatch
  //    budget on it. Fail-soft throughout — a broken ledger degrades to "no
  //    park state known", never blocks the digest.
  let digestLedgerEntries = [];
  try {
    digestLedgerEntries = readJsonlLedger(ledgerPath);
    const dispatchEntries = dispatchLedgerEntriesFn ? dispatchLedgerEntriesFn() : dispatchLedger.readEntries();
    const newOutcomes = reconcileDigestOutcomes(digestLedgerEntries, tasksById, dispatchEntries, now);
    for (const o of newOutcomes) {
      appendJsonlLedger(ledgerPath, o);
      log(`[digest-autofix] attempt-memory: #${o.cardId} ${o.event} (${o.note})`);
    }
    if (newOutcomes.length) digestLedgerEntries = digestLedgerEntries.concat(newOutcomes);
  } catch (err) {
    log(`[digest-autofix] WARN attempt-memory reconcile failed (park checks skipped this run): ${String(err.message).slice(0, 120)}`);
  }

  // 5. Dispatch the first `cap` queued rows.
  let budget = cap;
  for (const row of plan) {
    if (row.state === 'in-progress' || row.state === 'card-failed' || row.state === 'acknowledged' || row.state === 'decision') continue;
    if (!row.taskId) {
      const t = matchOpenTask(tasks, row.name);
      if (t) row.taskId = t.id;
    }
    if (!row.taskId) continue; // sync lag — the drain picks it up on its next tick

    // Hash the canonical family title ALONE (BRO-232 S4) — row.message stays
    // per-variant raw text (different prefixes describing the same condition
    // carry different detail text), so folding it in here would defeat the
    // whole point of collapsing family variants onto one taskId: two
    // variants would still diverge in contentHash and reset each other's
    // attempt-memory/park state. title is already family-collapsed (see
    // planAutofix) and stable run over run for the same condition — the same
    // stability assumption fileCard's own exact-title dedup already relies on.
    const contentHash = computeContentHash({ name: row.title });
    const park = checkPark(digestLedgerEntries, String(row.taskId), contentHash);
    if (park.parked) {
      row.state = 'parked';
      row.parkReason = park.reason;
      continue;
    }

    if (budget <= 0) { row.state = 'queued'; continue; }
    // Attempt N = how many times this exact content has already been
    // dispatched by this module (regardless of outcome) + this attempt.
    const priorAttempts = digestLedgerEntries.filter(e =>
      e.event === 'auto-dispatch' && String(e.taskId) === String(row.taskId) && e.contentHash === contentHash).length;
    const attempt = priorAttempts + 1;
    const model = row.model || (attempt >= 2 ? 'opus' : null);
    try {
      dispatchFn(row.taskId, log, (cap - budget) * 45, model);
      row.state = 'dispatched';
      row.attempt = attempt;
      if (model) row.model = model;
      budget--;
      try {
        appendJsonlLedger(ledgerPath, { event: 'auto-dispatch', taskId: String(row.taskId), contentHash });
      } catch (err) {
        log(`[digest-autofix] WARN attempt-memory ledger write failed for #${row.taskId} (park tracking degraded): ${String(err.message).slice(0, 120)}`);
      }
    } catch (err) {
      row.state = 'queued';
      log(`[digest-autofix] WARN dispatch spawn failed for #${row.taskId}: ${String(err.message).slice(0, 120)}`);
    }
  }
  return plan;
}

module.exports = {
  planAutofix, runAutofix, matchOpenTask, buildCardNotes, isRowAcknowledged, DISPATCH_CAP,
  DIGEST_LEDGER_PATH, reconcileDigestOutcomes, findMyJob, readJsonlLedger, appendJsonlLedger,
  fileCard, syncTasks, dispatchDetached, familyDisplayName, rowFamilyKey,
};
