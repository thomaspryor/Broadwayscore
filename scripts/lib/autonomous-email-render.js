/**
 * autonomous-email-render.js — pure HTML rendering for the autonomous loop's
 * morning email (S2-T6). No network, no filesystem: the sender script
 * (scripts/autonomous-email.js) gathers data, this renders it, tests assert
 * on the output.
 *
 * Layout (owner UX verdicts, 2026-07-12 mock tests):
 *   - ≤3 approve items. Each: card name + PASS badge + small grey cost tag,
 *     a "why this card existed" line ABOVE the what-was-done line,
 *     check results, Approve/Reject buttons.
 *   - one-line failed count (only when nonzero)
 *   - usage block: mini 3-row table (Tonight / This week / Monthly pace),
 *     model split demoted to one small grey line. NO invented budget:
 *     % appears only when weeklyUSD is configured or the Admin API exposes
 *     a real spend limit. Admin-API actuals replace ledger estimates when
 *     available, with a separate line isolating the loop's own share.
 *   - footer (moved OUT of the usage box): last run + awaiting count.
 */

'use strict';

const { CHECK_NAME: AUTOFIX_EFFECTIVENESS_CHECK_NAME } = require('./autofix-effectiveness.js');

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function money(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

// First sentence-ish of the card's ## Problem section — the "why this card
// existed" line the owner asked for above the what-was-done line.
function extractWhy(notes) {
  const m = /##\s*Problem\s*\n+([\s\S]*?)(?=\n##|$)/i.exec(String(notes || ''));
  const text = (m ? m[1] : String(notes || '')).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const sentence = text.split(/(?<=[.!?])\s+/)[0] || text;
  return sentence.length > 220 ? `${sentence.slice(0, 217)}…` : sentence;
}

// ── Plain-language item copy (owner scope-add, 2026-07-14) ─────────────────
// Night-2 follow-up: the first real morning email shipped Why/Done text
// lifted straight from the card and the implementer's own summary — function
// names, file paths, test commands. Owner: "I don't follow this at all."
// autonomous-email.js calls a cheap LLM (haiku/sonnet) with this prompt to
// generate the item's PRIMARY text; the technical Why/Done/branch demotes to
// small grey text underneath (see renderItem below). Pure/testable — no
// network here, that's the caller's job.
function buildPlainLanguageItemPrompt(item) {
  return `You are writing ONE short item in an internal "overnight work" approval email for a non-technical site owner (Broadway Scorecard, a theater review aggregator). Explain a single automated fix in plain language so the owner can decide approve or reject from your text ALONE.

Card title: ${item.name || '(untitled)'}
Why this was flagged (technical, for your context only): ${item.why || '(none given)'}
What the automated engineer did (technical, for your context only): ${item.summary || '(none given)'}

Write EXACTLY 2 short sentences for a non-technical reader:
1. What was wrong, in terms of what a user or the site itself would experience or show — never function names, file paths, code terms, or test names.
2. What was done, and whether anything actually changes on the live site right now (many of these fixes are test-only and change nothing live today — say so plainly if that's the case).

Rules: no em dashes, no "not X, it's Y" constructions, no hedging phrases ("I'd love to", "just wanted to", "happy to"), no jargon (delve, leverage, robust, tapestry). Plain, direct, concrete words a theater fan would use. Output ONLY the 2 sentences — no preamble, no quotes, no markdown, no bullet points.`;
}

// Defense-in-depth strip of the most common anti-slop violations, in case
// the model output drifts from the prompt's rules — never trust free-text
// LLM output to self-enforce house style. Em dash → comma (keeps the
// sentence grammatical rather than concatenating clauses with no separator).
function sanitizePlainLanguageText(text) {
  return String(text || '')
    .trim()
    .replace(/[—–]/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,])/g, '$1');
}

// ── Queue skip summary (night-1 fix #2) ─────────────────────────────────────

// Bucket a triage-queue entry's skip into an owner-readable reason. Order
// matters: prefilter reasons are authoritative when present.
function skipBucket(entry) {
  if (entry.decision === 'failed') return 'triage failed (retried tomorrow)';
  if (entry.decision === 'split') return 'too large, split proposed';
  const r = (entry.preFilter && entry.preFilter.reason) || '';
  if (/human territory/i.test(r)) return 'human territory (marketing/partnerships)';
  if (/human action/i.test(r)) return 'human-action title (emailing, posting, meeting)';
  if (/deny-tag/i.test(r)) return 'deny-tagged domain (email/commercial/scoring/ios)';
  if (/already in Auto/i.test(r)) return 'already processed by the loop';
  if (/fetch failed/i.test(r)) return 'card fetch failed (transient)';
  if (entry.triage && entry.triage.eligible === false) return 'outside the loop\'s write scope (needs excluded paths or human judgment)';
  return 'other';
}

/**
 * Summarize a triage queue (data/audit/autonomous-queue.json) for the email's
 * "why was nothing planned" section. Returns null when there's nothing useful
 * to say (no queue, or the queue actually planned work).
 */
function summarizeQueue(queue) {
  if (!queue || !Array.isArray(queue.entries) || !queue.counts) return null;
  if ((queue.counts.attempt || 0) > 0) return null; // work was planned — items section covers it
  const tally = new Map();
  for (const e of queue.entries) {
    if (e.decision === 'attempt') continue;
    const b = skipBucket(e);
    tally.set(b, (tally.get(b) || 0) + 1);
  }
  const buckets = [...tally.entries()]
    .map(([reason, n]) => ({ reason, n }))
    .sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason));
  const workable = buckets.some(b => /write scope|human/i.test(b.reason));
  return {
    generatedAt: queue.generatedAt || null,
    total: queue.counts.total || queue.entries.length,
    fetched: queue.counts.fetched ?? null,
    candidates: queue.counts.candidates ?? null,
    buckets,
    unlock: workable
      ? 'What would unlock work: backlog cards whose fix lives inside the loop\'s allowed paths. Tonight every triaged card needed human action or out-of-scope changes.'
      : null,
  };
}

function renderQueueSummary(qs) {
  if (!qs || !qs.buckets.length) return '';
  const rows = qs.buckets.map(b =>
    `<tr><td style="padding:2px 12px 2px 0;font-size:13px;font-weight:700;text-align:right;">${b.n}</td><td style="padding:2px 0;font-size:13px;color:#333;">${esc(b.reason)}</td></tr>`).join('');
  const scanned = qs.fetched != null && qs.fetched > qs.total
    ? `${qs.total} triaged (of ${qs.fetched} fetched)` : `${qs.total} triaged`;
  // Self-labeling: the breakdown states WHICH triage it describes, so a
  // manually re-run triage can never silently pose as last night's.
  const when = qs.generatedAt ? ` <span style="font-weight:400;color:#999;">(triage ${esc(String(qs.generatedAt).slice(0, 16).replace('T', ' '))} UTC)</span>` : '';
  return `<div style="border:1px solid #e5e5e5;border-radius:10px;padding:14px 16px;margin:0 0 14px;">
    <div style="font-size:13px;font-weight:700;margin-bottom:6px;">Why nothing was planned: ${esc(scanned)}, 0 workable${when}</div>
    <table style="border-collapse:collapse;">${rows}</table>
    ${qs.unlock ? `<div style="font-size:12px;color:#666;margin-top:8px;">${esc(qs.unlock)}</div>` : ''}
  </div>`;
}

// ── Needs-your-attention block (2026-07-19 wedge postmortem) ────────────────
// The loop wedged for 3 nights (auto=failed cards holding every plan slot)
// and the email showed only "0 items" — the owner had no way to see WHY or
// what to do. This block surfaces every state that silently stalls work,
// each with the concrete owner action.
function renderAttentionBlock(attention) {
  const { configWarnings = [], failedCards = [], parkedItems = [], attemptMemoryParked = [] } = attention || {};
  const lines = [];
  for (const w of configWarnings) {
    lines.push({ label: 'config', text: w, action: 'fix .claude/autonomous-config.json' });
  }
  for (const c of failedCards) {
    lines.push({
      label: 'failed', text: c.name,
      action: 'clear the Auto tag on the card to retry, or close the card if it no longer matters',
    });
  }
  for (const p of parkedItems) {
    lines.push({
      label: 'parked', text: `${p.name} (sized ${p.size})`,
      action: 'too big for the loop, needs an interactive session, or split the card',
    });
  }
  for (const p of attemptMemoryParked) {
    lines.push({
      label: 'parked', text: `${p.name} — ${p.reason}`,
      action: 'edit the card to re-enter the pool, or clear its park (task #635/#637)',
    });
  }
  if (!lines.length) return '';
  const rows = lines.map(l =>
    `<div style="margin:0 0 8px;">
      <span style="display:inline-block;background:#b45309;color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;vertical-align:middle;text-transform:uppercase;">${esc(l.label)}</span>
      <span style="font-size:13px;color:#333;margin-left:6px;">${esc(l.text)}</span>
      <div style="font-size:11px;color:#999;margin:2px 0 0 2px;">→ ${esc(l.action)}</div>
    </div>`).join('');
  return `<div style="border:1px solid #fbbf24;background:#fffbeb;border-radius:10px;padding:14px 16px;margin:0 0 14px;">
    <div style="font-size:13px;font-weight:700;margin-bottom:8px;color:#b45309;">Needs your attention: ${lines.length} item${lines.length > 1 ? 's' : ''} stalling the loop</div>
    ${rows}
  </div>`;
}

// ── Acceptance recheck (Sprint 3, S3-T4) ───────────────────────────────────
//
// What it answers for the owner: "the things that got marked finished — are
// they actually still finished?" Deliberately BELOW the divider and never
// counted in the top line's issue tally: the recheck runs in shadow mode, and
// a shadow signal that nags before it has earned trust is exactly how a good
// check gets ignored. It states its own status ("watching only") so the owner
// knows a red line here is an observation, not an alarm.
function renderRecheckBlock(recheck) {
  if (!recheck || !recheck.lines || !recheck.lines.length) return '';
  const c = recheck.counts || {};
  const bits = [];
  if (c.pass) bits.push(`${c.pass} still work`);
  if (c.fail) bits.push(`${c.fail} no longer pass their own check`);
  if (c.unverifiable) bits.push(`${c.unverifiable} can't be checked automatically`);
  if (c.skipped) bits.push(`${c.skipped} skipped (being worked on)`);
  const rows = recheck.lines.slice(0, 5).map(l =>
    `<div style="font-size:12px;color:#555;margin:0 0 3px;">${esc(l)}</div>`).join('');
  const more = recheck.lines.length > 5
    ? `<div style="font-size:11px;color:#999;margin-top:4px;">+${recheck.lines.length - 5} more</div>` : '';
  return `<div style="border:1px solid #e5e5e5;border-radius:10px;padding:14px 16px;margin:0 0 14px;">
    <div style="font-size:13px;font-weight:700;margin-bottom:6px;">Finished work re-checked: ${esc(bits.join(' · ') || 'nothing to check')}</div>
    ${rows}${more}
    <div style="font-size:11px;color:#999;margin-top:8px;">This is a new check that re-runs each finished job's own test a day later. It is still on trial, so nothing here was reopened, undone, or changed, and nothing on the live site is affected. You do not need to do anything. If a line looks wrong, say so and it gets looked at.</div>
  </div>`;
}

// ── Site health digest (card #364 — owner merge decision 2026-07-26) ───────
// health-check.js used to email its own "BSC Daily"/"BSC URGENT" digest
// separately from this morning email. The owner: "I don't like getting
// emails unless they're urgent. I want things to self handle." health-check.js
// now writes its results to data/audit/health-digest-snapshot.json instead of
// sending mail; autonomous-email.js reads that snapshot and folds it in here
// so there is exactly one scheduled morning email, not two.
// Plain-English translations for recurring health checks (owner mandate
// 2026-08-02: "I can't even tell from any of the descriptions what they are or
// mean"). Keyed by name prefix; unmapped names fall back to the raw name.
const PLAIN_HEALTH = [
  [/^Workflow repeat-failure: (.+)/, (m) => `The automated "${m[1]}" job keeps failing`],
  [/^Audience coverage/, () => 'Some shows have audience ratings that never linked up'],
  [/^Sync: baseline drift/, () => 'The site is showing fewer shows/reviews than yesterday'],
  [/^Sync: cast coverage/, () => 'Some shows are missing cast lists'],
  [/^Quality: star-vs-score mismatch/, () => 'A few review scores contradict the critic\u2019s own star rating'],
  [/^Quality: corpus drift/, () => 'Some data-quality checks are drifting from their baselines'],
  [/^Commercial model drift/, () => 'The commercial (recoupment) model\u2019s estimates shifted'],
  [/^Credits: (.+)/, (m) => `${m[1]} scraping credits are running low`],
  [/^Stuck work/, () => 'Some high-priority fix cards have sat paused too long'],
  [/^SEO/, () => 'Google page-speed/search health degraded'],
  [/^Secrets/, () => 'An API key or login may be expiring'],
  [/^Data freshness/, () => 'Some open shows are missing a poster, synopsis, or ticket link'],
  [/^Stuck pipeline/, () => 'A data pipeline looks stalled'],
];
function plainHealthLine(name) {
  for (const [re2, fn] of PLAIN_HEALTH) { const m = String(name).match(re2); if (m) return fn(m); }
  return String(name);
}

// Which health rows the email reports on. Kept pure + exported (CLAUDE.md §15)
// so digest-content-invariants asserts against the SAME selection the renderer
// uses. Since Digest v3 there is no row budget: every issue is listed because
// every issue is being auto-fixed — the list IS the fix report, not a to-do.
function selectHealthRows({ errors = [], warns = [] } = {}) {
  const errs = Array.isArray(errors) ? errors : [];
  const warnings = Array.isArray(warns) ? warns : [];
  return {
    rows: [...errs.map(e => ({ ...e, kind: 'error' })), ...warnings.map(w => ({ ...w, kind: 'warn' }))],
    hiddenWarns: 0,
  };
}

// Scoreboard table — the owner's "original format" (his Jul 22 email): one row
// per category, icon + pass state, zero prose. Categories derive from the
// check-name prefix before ":" ("Quality: corpus drift" → Quality).
function renderHealthScoreboard(health) {
  const { rows } = selectHealthRows({ errors: health.errors, warns: health.warns });
  const byCat = new Map();
  for (const r of rows) {
    if (!r || !r.name) continue;
    const cat = String(r.name).split(':')[0].trim() || 'Other';
    const cur = byCat.get(cat) || { errors: 0, warns: 0 };
    cur[r.kind === 'error' ? 'errors' : 'warns']++;
    byCat.set(cat, cur);
  }
  const tr = (icon, label, right, color) => `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;color:#333;">${icon} ${esc(label)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;text-align:right;color:${color};font-weight:700;">${esc(right)}</td>
  </tr>`;
  const rowsHtml = [...byCat.entries()].map(([cat, c]) =>
    c.errors ? tr('\u274c', cat, `${c.errors + c.warns} issue${c.errors + c.warns === 1 ? '' : 's'}`, '#dc2626')
             : tr('\u26a0\ufe0f', cat, `${c.warns} issue${c.warns === 1 ? '' : 's'}`, '#b45309')).join('');
  const passed = Number(health.passedCount);
  const passedRow = Number.isFinite(passed) && passed > 0
    ? tr('\u2705', 'Everything else', `${passed} checks passed`, '#16a34a') : '';
  return `<div style="border:1px solid #e5e5e5;border-radius:10px;overflow:hidden;margin:0 0 14px;">
    <table style="border-collapse:collapse;width:100%;">
      <tr><td style="padding:6px 10px;font-size:11px;color:#999;text-transform:uppercase;">Category</td><td style="padding:6px 10px;font-size:11px;color:#999;text-transform:uppercase;text-align:right;">Status</td></tr>
      ${rowsHtml}${passedRow}
    </table>
  </div>`;
}

// "Automation queue" block — one line per issue with its auto-fix status
// (renamed from "Being fixed automatically" by the BRO-286 honesty fix;
// scripts/lib/digest-content-invariants.js checks for this exact header
// text, so keep them in sync on any future rename). NO buttons, NO asks
// (owner, 2026-08-02: "Just have a Claude session fix them"). rows come from
// digest-autofix's annotated plan; health rows the plan didn't cover
// (shouldn't happen) degrade to a bare plain-English line.
const AUTOFIX_STATE_LABEL = {
  // BRO-286 honesty (settles the task #1311/#1220 class): 'dispatched' means
  // a launch was ATTEMPTED \u2014 the spawn is detached and its journal entry
  // lands after this email renders, so the truthful claim is "launched,
  // verified tomorrow", never "being fixed, nothing for you to do". The
  // next-day verification is real: attempt-memory folds the dispatch
  // ledger's job outcome into card-pass/card-fail, and the throughput +
  // canary rows surface a dead pipeline.
  'dispatched': ['\u{1f527}', 'fix session launched \u2014 tomorrow\u2019s digest verifies it actually ran'],
  'in-progress': ['\u{1f527}', 'a live fix session is on it (liveness-checked this run)'],
  'queued': ['\u23f3', 'tracker filed \u2014 dispatches on the next automated pass'],
  'card-filed': ['\u23f3', 'tracker filed \u2014 dispatches on the next automated pass'],
  'card-failed': ['\u26a0\ufe0f', 'tracker filing FAILED \u2014 nothing is working on this yet; retries tomorrow'],
  'acknowledged': ['\u2139\ufe0f', 'already tracked with a known resolve-by date \u2014 no new card needed'],
  // Attempt-memory (task #843): same fixed content failed twice unchanged —
  // never redispatched blind, needs a human look at the card itself.
  'parked': ['\u23f8\ufe0f', 'kept failing the same way \u2014 parked, needs a manual look'],
  // Liveness gate (task #940): the task list said in_progress but neither a
  // live cmux workspace nor an open headless job backs that claim right
  // now \u2014 the session that was working it may have died silently. Never
  // say "working on it" without proof; this is the honest downgrade.
  'no-live-session': ['\u23f8\ufe0f', 'marked in progress but no live session was found \u2014 worth a look'],
};
// Loop-wide dead-fleet honesty (task #1220/BRO-230). Every row-level label in
// AUTOFIX_STATE_LABEL is optimism ABOUT THAT ONE ROW: "dispatched" means a
// launch was attempted, "in-progress" (post-liveness-gate) means a live
// session was actually found. Neither says anything about whether launches
// are completing AT ALL across the fleet — a logged-out CLI dispatches every
// job "successfully" and every row still reads "fix session launched" while
// the real fix rate is zero (the 2026-08-10 incident: 13 near-identical
// digests under this exact banner). health-check.js's "Autofix: jobs
// actually succeeding" row (scripts/lib/autofix-effectiveness.js) is the one
// signal that reads OUTCOMES across the whole fleet instead of one row's
// dispatch attempt; when it lands in health.errors the loop itself is dead,
// and every per-row "launched"/"queued" claim below needs that context.
function autofixLoopDeadMessage(health) {
  const row = (health && Array.isArray(health.errors) ? health.errors : [])
    .find((e) => e && e.name === AUTOFIX_EFFECTIVENESS_CHECK_NAME);
  return row ? (row.message || 'Auto-fix loop is DEAD.') : null;
}

function renderAutofixBlock(autofixRows, loopDeadMessage = null) {
  // 'decision' rows are genuine judgment calls (task #843) — they belong ONLY
  // in the "Needs your attention" card with a button, never here (this block
  // would otherwise mislabel them as an in-flight auto-fix).
  let rows = (autofixRows || []).filter(r => r && r.name && r.state !== 'decision');
  if (!rows.length) return '';
  // Two checks can share a plain-English translation (e.g. two "Stuck work:"
  // variants) — collapse them so the owner never reads the same sentence twice.
  const seen = new Map();
  for (const r of rows) {
    const key = plainHealthLine(r.name);
    if (seen.has(key)) seen.get(key).dupCount = (seen.get(key).dupCount || 1) + 1;
    else seen.set(key, r);
  }
  rows = [...seen.values()];
  const lines = rows.map(r => {
    const [icon, label] = AUTOFIX_STATE_LABEL[r.state] || ['\u23f3', 'queued'];
    // Linear-tracked rows ('linear:BRO-287') render the board identifier the
    // owner can actually find ('BRO-287'); legacy numeric ids keep '#N'.
    const rawId = r.taskId ? String(r.taskId) : null;
    const displayId = rawId ? (rawId.startsWith('linear:') ? rawId.slice(7) : `#${rawId}`) : null;
    const ref = displayId ? ` <span style="color:#bbb;">(${esc(displayId)})</span>` : '';
    const attemptNote = r.state === 'dispatched' && r.attempt > 1 ? ` \u2014 attempt ${r.attempt}${r.model ? ` (${esc(r.model)})` : ''}` : '';
    return `<div style="margin:0 0 6px;">
      <div style="font-size:13px;color:#333;">${icon} ${esc(plainHealthLine(r.name))}${r.dupCount ? ` (\u00d7${r.dupCount})` : ''}${ref}</div>
      <div style="font-size:11px;color:#999;margin:1px 0 0 22px;">${esc(label)}${attemptNote}</div>
    </div>`;
  }).join('');
  // Header claims exactly what is proven: trackers exist (identifiers shown)
  // and launches were attempted; whether they RAN is verified by tomorrow's
  // throughput/canary rows \u2014 never "nothing for you to do" on faith (#1311).
  // Task #1220/BRO-230: that promise is only honest when the fleet-wide
  // effectiveness check hasn't already proven it false. When it has, say so
  // here instead of repeating "launched" for rows nothing will actually run.
  const header = loopDeadMessage
    ? `\u26a0\ufe0f Automation queue \u2014 the auto-fix loop looks DEAD, so these are FILED but likely NOT running: ${esc(loopDeadMessage)}`
    : 'Automation queue \u2014 filed and launched; tomorrow\u2019s digest verifies each one ran';
  return `<div style="border:1px solid ${loopDeadMessage ? '#fca5a5' : '#e5e5e5'};background:${loopDeadMessage ? '#fef2f2' : '#fff'};border-radius:10px;padding:14px 16px;margin:0 0 14px;">
    <div style="font-size:13px;font-weight:700;margin-bottom:8px;${loopDeadMessage ? 'color:#b91c1c;' : ''}">${header}</div>
    ${lines}
  </div>`;
}

// Queued owner-router lines that are pure internal telemetry never belong in
// the owner email (mandate 2026-08-02) — everything else renders as a
// "Needs your attention" card.
const QUEUED_TELEMETRY_BLOCKLIST = [/^T1 Coverage/i, /^Deployed coverage/i];

function renderHealthDigestBlock(health, autofixRows = null, loopDeadMessageOverride = null) {
  if (!health) return '';
  const errors = Array.isArray(health.errors) ? health.errors : [];
  const warns = Array.isArray(health.warns) ? health.warns : [];
  const queued = Array.isArray(health.queued) ? health.queued : [];
  const urgent = errors.length > 0;
  const autoFixedNote = health.autoFixedCount > 0
    ? `<div style="font-size:12px;color:#16a34a;margin-top:8px;">${health.autoFixedCount} auto-fixed overnight</div>` : '';
  const asOf = health.generatedAt
    ? `<div style="font-size:11px;color:#999;margin-top:6px;">as of ${esc(String(health.generatedAt).slice(0, 16).replace('T', ' '))} UTC</div>` : '';
  const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
  const clip = (s2, n) => { const t = String(s2); return t.length > n ? `${t.slice(0, n - 1)}\u2026` : t; };
  const validQueued = queued.filter(Boolean)
    .filter(q => !QUEUED_TELEMETRY_BLOCKLIST.some(re2 => re2.test(String(q.title || ''))));
  // Owner mandate 2026-08-02 (second half, stated twice): anything that still
  // needs the human MUST carry a one-click action — "If something TRULY needs
  // approval, give me a link to click Approve so I can move on with my life."
  // composeDigestEmail attaches q.actionUrl (signed dispatch link, same HMAC
  // machinery as the API's approve/dispatch flow); prose-only cards are a
  // regression the content invariant now catches.
  const queuedHtml = validQueued.length
    ? `<div style="border:1px solid #e5e5e5;border-radius:10px;padding:14px 16px;margin:0 0 14px;">
        <div style="font-size:13px;font-weight:700;margin-bottom:8px;">Needs your attention</div>
        ${validQueued.map(q => {
          const href = safeUrl(q.url);
          const action = safeUrl(q.actionUrl);
          // Every remaining queued row is a genuine decision (task #843):
          // technical rows are folded into renderAutofixBlock's "Being fixed
          // automatically" list before this ever runs — see
          // send-morning-digest.js. decisionPrompt names the actual choice
          // so a bare button never leaves the owner guessing what it does.
          return `<div style="margin:0 0 10px;">
            <div style="font-size:12px;color:#555;"><b>${esc(q.title || '(untitled)')}</b>${q.description ? ` \u2014 ${esc(clip(q.description, 200))}` : ''}${href ? ` <a href="${esc(href)}" style="color:#2563eb;">view</a>` : ''}</div>
            ${q.decisionPrompt ? `<div style="font-size:11px;color:#b45309;margin:2px 0 0;">Decision needed: ${esc(clip(q.decisionPrompt, 200))}</div>` : ''}
            ${action ? `<div style="margin:4px 0 0;"><a href="${esc(action)}" style="display:inline-block;font-size:11px;font-weight:700;color:#fff;background:#16a34a;text-decoration:none;padding:3px 12px;border-radius:8px;">Dispatch a fix \u2192</a></div>` : ''}
          </div>`;
        }).join('')}</div>`
    : '';

  const header = `<div style="border:1px solid ${urgent ? '#fca5a5' : '#e5e5e5'};background:${urgent ? '#fef2f2' : '#fff'};border-radius:10px;padding:14px 16px;margin:0 0 14px;">
    <div style="font-size:15px;font-weight:700;${urgent ? 'color:#dc2626;' : ''}">${errors.length} error${errors.length === 1 ? '' : 's'}, ${warns.length} warning${warns.length === 1 ? '' : 's'}${health.consecutiveErrorDays > 1 ? ` <span style="color:#999;font-weight:400;font-size:12px;">(day ${health.consecutiveErrorDays} of consecutive errors)</span>` : ''}</div>
    ${autoFixedNote}${asOf}
  </div>`;

  if (!errors.length && !warns.length) {
    return `${header}${queuedHtml}`;
  }
  const { rows } = selectHealthRows({ errors, warns });
  const plan = autofixRows || rows.map(r => ({ name: r.name, state: 'queued', taskId: null }));
  // Task #1220/BRO-230 (ship-check adversarial finding): a caller running on
  // the same machine as the dispatch ledger (send-morning-digest.js) knows
  // the loop's real state more reliably than this `health` object ever can
  // (health.errors only carries this signal when health-check.js itself ran
  // somewhere the ledger is visible, which in steady state is nowhere) — let
  // that caller's own assessment win so the top summary line and this block
  // can never contradict each other.
  const loopDeadMessage = loopDeadMessageOverride || autofixLoopDeadMessage(health);
  return `${header}${renderHealthScoreboard(health)}${renderAutofixBlock(plan, loopDeadMessage)}${queuedHtml}`;
}

// Count of health-digest errors+warnings — folded into renderSummaryLine's
// "N things to look at below" so the top line never says "nothing broken"
// while the merged site-health block below shows real issues.
function healthIssueCount(health) {
  const h = health || {};
  return (h.errors?.length || 0) + (h.warns?.length || 0);
}

// ── Named digest snapshots (card #497 — daily-digest.yml score-drift +
// opening-digest.yml — and card #511 — reddit-engagement-digest.js — folded
// in the same way #364 folded in site health) ──────────────────────────────
// All three scripts write { generatedAt, subject, bannerText, items: [{title,
// detail, url?}], moreCount } — routine FYI content, not errors/warnings, so
// unlike renderHealthDigestBlock this never bumps the "N things to look at"
// count; it's context, same tier as the overnight digest block below it.
function renderNamedDigestBlock(label, snapshot) {
  if (!snapshot) return '';
  // .filter(Boolean): a corrupted/partial snapshot write must not crash the
  // whole email render — same guard as renderHealthDigestBlock's queued items
  // (ship-check follow-up finding, card #497).
  const items = (Array.isArray(snapshot.items) ? snapshot.items : []).filter(Boolean);
  // http(s) only: same guard as renderHealthDigestBlock's safeUrl() above —
  // a malformed/malicious url must not become a live javascript:/data: link
  // in the owner's inbox (ship-check follow-up finding, card #497).
  const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
  const rows = items.map(it => {
    const href = safeUrl(it.url);
    return `<div style="margin:0 0 6px;">
      <span style="font-size:13px;color:#333;">${href ? `<a href="${esc(href)}" style="color:#333;text-decoration:none;">${esc(it.title)}</a>` : esc(it.title)}</span>
      ${it.detail ? `<div style="font-size:11px;color:#999;margin:2px 0 0 2px;">${esc(it.detail)}</div>` : ''}
    </div>`;
  }).join('');
  const more = snapshot.moreCount > 0
    ? `<div style="font-size:11px;color:#999;margin-top:4px;">+${snapshot.moreCount} more</div>` : '';
  const asOf = snapshot.generatedAt && !Number.isNaN(new Date(snapshot.generatedAt).getTime())
    ? `<div style="font-size:11px;color:#999;margin-top:6px;">as of ${esc(String(snapshot.generatedAt).slice(0, 16).replace('T', ' '))} UTC</div>` : '';
  return `<div style="border:1px solid #e5e5e5;border-radius:10px;padding:14px 16px;margin:0 0 14px;">
    <div style="font-size:13px;font-weight:700;margin-bottom:8px;">${esc(label)}: ${esc(snapshot.bannerText || '')}</div>
    ${rows}${more}${asOf}
  </div>`;
}

function renderDailyDigestBlock(snapshot) {
  return renderNamedDigestBlock('Score drift', snapshot);
}

function renderOpeningDigestBlock(snapshot) {
  return renderNamedDigestBlock('Opening radar', snapshot);
}

function renderRedditDigestBlock(snapshot) {
  return renderNamedDigestBlock('r/Broadway', snapshot);
}

// Parked cards (card #777): bsc-prune's tab-close park (#776) writes a
// 'vanished' ledger entry and pauses the Notion card, but nothing surfaced
// that anywhere — a card could sit parked indefinitely with no signal, the
// same write-only-signal class as #689/#690/#641/#692. `parkedCards` is the
// array shape autonomous-email.js builds from dispatchLedger.parkedTasks():
// [{taskId, subject, workspaceRef}].
function renderParkedCardsBlock(parkedCards, moreCount = 0) {
  if (!Array.isArray(parkedCards) || !parkedCards.length) return '';
  const total = parkedCards.length + (Number(moreCount) || 0);
  const names = parkedCards
    .map(p => `#${esc(p.taskId)}${p.subject ? ` "${esc(p.subject)}"` : ''}${p.workspaceRef ? ` (${esc(p.workspaceRef)})` : ''}`)
    .join(', ');
  const more = moreCount > 0 ? ` +${moreCount} more` : '';
  return `<p style="font-size:12px;color:#666;margin:0 0 10px;">Parked by you: ${total} card${total > 1 ? 's' : ''} — ${names}${more}. Resume with <code>bsc-next.js --id &lt;id&gt; --force</code>.</p>`;
}

function renderItem(item) {
  const badge = `<span style="display:inline-block;background:#16a34a;color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;vertical-align:middle;">PASS</span>`;
  const cost = `<span style="color:#999;font-size:12px;margin-left:6px;">~${money(item.usd)}</span>`;
  const checks = (item.checks || []).map(esc).join(' · ');
  const btn = (label, url, bg) =>
    `<a href="${esc(url)}" style="display:inline-block;background:${bg};color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 22px;border-radius:8px;margin-right:10px;">${label}</a>`;
  // item.plainText (owner scope-add 2026-07-14): the LLM-generated
  // non-technical explanation becomes the PRIMARY text; the card's own
  // Why/Done/branch demote to small grey text underneath. Falls back to the
  // old bold Why/Done layout when plainText is absent (LLM call failed, or a
  // caller — including older tests — never populated it).
  const body = item.plainText
    ? `<div style="font-size:15px;color:#111;line-height:1.45;margin-bottom:8px;">${esc(item.plainText)}</div>
    <div style="font-size:11px;color:#aaa;margin-bottom:10px;">${item.why ? `Why: ${esc(item.why)} · ` : ''}Done: ${esc(item.summary || 'change implemented and verified')} · ${esc(item.branch)}</div>`
    : `${item.why ? `<div style="font-size:13px;color:#666;margin-bottom:4px;"><b>Why:</b> ${esc(item.why)}</div>` : ''}
    <div style="font-size:13px;color:#333;margin-bottom:6px;"><b>Done:</b> ${esc(item.summary || 'change implemented and verified')} <span style="color:#999;">(${esc(item.branch)})</span></div>`;
  // UI evidence gate (S2-T6). A change to how the site LOOKS is not
  // approvable from green checks: tsc/lint/build all pass on a page that
  // renders wrong. With screenshots the owner can judge it from the email;
  // WITHOUT them there is no approve link at all — the tap is withheld, not
  // quietly downgraded to "checks passed". Reject stays available either way.
  const shots = Array.isArray(item.screenshots) ? item.screenshots : [];
  const uiUnseen = item.ui === true && shots.length === 0;
  const shotList = shots.length
    ? `<div style="font-size:11px;color:#999;margin-bottom:10px;">Screenshots attached to this email · ${shots.map(s => esc(String(s).split('/').pop())).join(' · ')}</div>`
    : '';
  const uiNotice = uiUnseen
    ? `<div style="border-left:3px solid #b45309;background:#fffbeb;padding:8px 10px;margin:0 0 10px;font-size:13px;color:#7c2d12;">
        <b>This one changes how a page looks, and the overnight run could not take pictures of it.</b>
        There is no approve button because you would be approving something nobody has seen.
        <div style="margin-top:6px;">Easiest option: tap Reject. It will try again tonight and send pictures next time.</div>
        <div style="margin-top:6px;">If you want it now, paste this into a terminal on the Mac and it will open the changed page for you:</div>
        <div style="margin-top:4px;font-family:ui-monospace,Menlo,monospace;font-size:12px;background:#fff;border:1px solid #fde68a;border-radius:6px;padding:6px 8px;word-break:break-all;">npm run preview-branch ${esc(item.branch)}</div>
      </div>`
    : '';
  const actions = uiUnseen
    ? `<div>${btn('Reject', item.rejectUrl, '#6b7280')}</div>`
    : `<div>${btn('Approve', item.approveUrl, '#16a34a')}${btn('Reject', item.rejectUrl, '#6b7280')}</div>`;
  return `<div style="border:1px solid #e5e5e5;border-radius:10px;padding:16px;margin:0 0 14px;">
    <div style="font-size:15px;font-weight:700;margin-bottom:6px;">${esc(item.name)} ${badge}${cost}</div>
    ${body}
    ${checks ? `<div style="font-size:12px;color:#16a34a;margin-bottom:10px;">${checks}</div>` : ''}
    ${shotList}
    ${uiNotice}
    ${actions}
  </div>`;
}

// stats = usageStats() from autonomous-ledger; admin = fetchAdminUsage()
// result or null; config = { weeklyUSD } (never defaulted).
function renderUsageBlock(stats, admin, config = {}) {
  const rows = [];
  const row = (label, value) =>
    `<tr><td style="padding:4px 24px 4px 0;color:#666;font-size:13px;">${label}</td><td style="padding:4px 0;font-size:14px;font-weight:700;">${value}</td></tr>`;

  const weekUSD = admin && admin.actualUSD7d != null ? admin.actualUSD7d : stats.week.usd;
  const weekSuffix = (() => {
    if (Number.isFinite(config.weeklyUSD) && config.weeklyUSD > 0) {
      return ` <span style="color:#999;font-weight:400;">(${Math.round((weekUSD / config.weeklyUSD) * 100)}% of $${config.weeklyUSD}/wk budget)</span>`;
    }
    if (admin && Number.isFinite(admin.spendLimitUSD) && admin.spendLimitUSD > 0) {
      return ` <span style="color:#999;font-weight:400;">(${Math.round((weekUSD / admin.spendLimitUSD) * 100)}% of $${admin.spendLimitUSD} account limit)</span>`;
    }
    return ''; // no configured budget → spend + pace only, never invented
  })();

  rows.push(row('Tonight', money(stats.tonight.usd)));
  rows.push(row(admin ? 'This week (account)' : 'This week', money(weekUSD) + weekSuffix));
  const pace = admin && admin.actualUSD7d != null ? Math.round((admin.actualUSD7d / 7) * 30 * 100) / 100 : stats.paceMonthlyUSD;
  rows.push(row('Monthly pace', pace == null ? '—' : `~${money(pace)}`));

  const modelBits = Object.entries(stats.tonight.byModel || {})
    .filter(([, v]) => v.usd > 0 || v.tokensIn > 0 || v.tokensOut > 0)
    .map(([m, v]) => `${m.replace(/^claude-/, '')} ${money(v.usd)} (${Math.round(v.tokensIn / 1000)}k in / ${Math.round(v.tokensOut / 1000)}k out)`);
  const loopShare = admin ? `<div style="font-size:11px;color:#999;margin-top:2px;">autonomous loop's share this week: ${money(stats.week.usd)} (ledger)</div>` : '';

  return `<div style="border:1px solid #e5e5e5;border-radius:10px;padding:14px 16px;margin:18px 0 6px;">
    <table style="border-collapse:collapse;">${rows.join('')}</table>
    ${modelBits.length ? `<div style="font-size:11px;color:#999;margin-top:6px;">${esc(modelBits.join(' · '))}</div>` : ''}
    ${loopShare}
  </div>`;
}

// ── One-line "read me first" summary (owner reformat, card #409) ────────────
// The owner reads text-heavy and can't tell at a glance whether anything
// needs them. This is the single line at the very top: what to do, what it
// cost, and one plain health word. Owner-facing copy — plain language, no
// em dashes, no jargon (anti-slop rules).

function attentionCountOf(attention) {
  const a = attention || {};
  return (a.configWarnings?.length || 0) + (a.failedCards?.length || 0) + (a.parkedItems?.length || 0) + (a.attemptMemoryParked?.length || 0);
}

// Subset of attentionCountOf that names an actual owner decision (clear a
// failed card's Auto tag, fix a config warning). parkedItems are a routine
// skip reason — "this card is bigger than the loop's enabled size tiers" —
// not new information the owner must act on tonight, so they're excluded
// here even though they still show in the attention block body. Card #475
// (2026-07-26): the subject line escalated to "needs your triage" purely off
// attentionCountOf (which counted parked items), while this function's
// sibling drove the body headline off items.length only — the two disagreed
// whenever parked items were the ONLY attention signal, producing "10 items
// stalling the loop — needs your triage" next to a body that opened with
// "Nothing needs you this morning". Both the subject and the headline must
// use THIS count for the "needs your triage" framing so they can't diverge.
function actionableAttentionCountOf(attention) {
  const a = attention || {};
  return (a.configWarnings?.length || 0) + (a.failedCards?.length || 0);
}

// Count the digest signals renderDigestBlock flags as "possibly stuck", so the
// top-line "nothing broken" is never contradicted by a ⚠️ shown below.
// Delegates to overnight-digest.js's countStuckSignals — the ONE definition of
// those thresholds — instead of re-implementing them here (card #409 review: a
// second copy silently drifts the next time renderDigestBlock is edited).
function digestStuckCount(digest) {
  return require('./overnight-digest.js').countStuckSignals(digest);
}

function renderSummaryLine(data) {
  const { items = [], failedCount = 0, throttled = null, runSkipped = null, attention = null, stats = null, digest = null, health = null } = data;
  // A partially-failed digest (a source it couldn't check) means health is
  // UNKNOWN, not clean — count it so the top line never says "nothing broken"
  // while the digest below shows a "Couldn't check: …" line.
  const digestUnknown = digest && Array.isArray(digest.errors) && digest.errors.length ? 1 : 0;
  const issues = failedCount + attentionCountOf(attention) + digestStuckCount(digest) + digestUnknown + healthIssueCount(health) + (throttled ? 1 : 0);
  const actionableAttention = actionableAttentionCountOf(attention);

  let headline;
  if (runSkipped) headline = 'The overnight run did not finish';
  else if (items.length) headline = `${items.length} fix${items.length > 1 ? 'es' : ''} waiting for your tap`;
  // Must agree with autonomous-email.js's subject line, which escalates to
  // "needs your triage" off this SAME actionable count — otherwise the
  // subject can say "needs your triage" while this headline says "Nothing
  // needs you this morning" (card #475 regression: parked-item-only nights
  // hit exactly this split).
  else if (actionableAttention) headline = `${actionableAttention} item${actionableAttention > 1 ? 's' : ''} need${actionableAttention > 1 ? '' : 's'} your triage`;
  else headline = 'Nothing needs you this morning';

  const bits = [];
  const spend = stats && stats.tonight ? stats.tonight.usd : null;
  if (spend != null) bits.push(`${money(spend)} overnight`);
  if (!runSkipped) bits.push(issues > 0 ? `${issues} thing${issues > 1 ? 's' : ''} to look at below` : 'nothing broken');

  return `<div style="font-size:20px;font-weight:800;line-height:1.3;margin:0 0 4px;color:#111;">${esc(headline)}</div>
    ${bits.length ? `<div style="font-size:13px;color:#666;margin:0 0 4px;">${esc(bits.join(' · '))}</div>` : ''}`;
}

/**
 * @param {object} data
 *   items: [{ name, why, summary, branch, usd, checks[], approveUrl, rejectUrl }]
 *   moreAwaiting: number (needs-approval beyond the ≤3 shown)
 *   failedCount: number, skippedCount: number, throttled: string|null
 *   runSkipped: string|null (run-skip ledger note — auth expiry etc.)
 *   executorSkipped: string|null (#476 — "executor skipped (monitor night): N deferred")
 *   queueSummary: summarizeQueue() result|null (0-planned skip breakdown)
 *   stats: usageStats() result · admin: fetchAdminUsage() result|null
 *   config: { weeklyUSD } · lastRunNote: string|null · awaitingTotal: number
 *
 * Layout (card #409 reformat): one-line summary → any urgent banner → items
 * that need a tap (the ONE action, visually dominant) → a divider → all the
 * informational context (what changed, cost, why nothing was planned) demoted
 * below in quieter type. The owner should be able to act, or close the email,
 * from everything ABOVE the divider alone.
 */
function renderEmail(data) {
  const { items = [], moreAwaiting = 0, failedCount = 0, throttled = null, runSkipped = null, executorSkipped = null, queueSummary = null, attention = null, stats, admin = null, config = {}, lastRunNote = null, awaitingTotal = 0 } = data;

  const parts = [];
  parts.push(`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:18px 14px;color:#111;">`);

  // 1. The read-me-first line: action + cost + health, in one glance.
  parts.push(renderSummaryLine(data));

  // 2. Urgent banners. A skipped run or a queue-read failure is the first
  //    real content after the summary — never a silent no-op night.
  if (runSkipped) {
    parts.push(`<p style="font-size:14px;font-weight:700;color:#dc2626;margin:12px 0 12px;">⛔ ${esc(runSkipped)}</p>`);
  }
  // #476: a deliberate, expected deferral (opening-night monitor holding the
  // git tree) — distinct from runSkipped's auth/preflight failures, so it
  // gets its own amber (not red) banner, but still ranks above the routine
  // "for your records" section. Without this, a monitor night looked
  // identical to a genuine do-nothing night.
  if (executorSkipped) {
    parts.push(`<p style="font-size:14px;font-weight:700;color:#b45309;margin:12px 0 12px;">⏸ ${esc(executorSkipped)}</p>`);
  }
  if (throttled) {
    // `throttled` is a generic banner string — it may carry an actual
    // throttle, a Notion listing failure, or a missing-evidence notice, each
    // self-describing, so use a neutral marker not a hardcoded "Throttled:".
    parts.push(`<p style="font-size:13px;color:#b45309;margin:0 0 12px;">⚠️ ${esc(throttled)}</p>`);
  }

  // 3. Anything stalling the loop outranks routine taps — three silent-zero
  //    nights (07-17..19) is the incident this block fixes.
  const attentionHtml = renderAttentionBlock(attention);
  if (attentionHtml) parts.push(attentionHtml);

  // 4. THE action: approval cards, visually dominant, right up top.
  if (items.length) {
    parts.push(`<div style="height:6px;"></div>`);
    for (const item of items) parts.push(renderItem(item));
  }
  if (moreAwaiting > 0) {
    parts.push(`<p style="font-size:13px;color:#666;">+${moreAwaiting} more item${moreAwaiting > 1 ? 's' : ''} awaiting approval (shown over the next mornings).</p>`);
  }
  if (failedCount > 0) {
    parts.push(`<p style="font-size:13px;color:#666;margin:6px 0;">${failedCount} card${failedCount > 1 ? 's' : ''} failed overnight (details on the cards; nothing was pushed for them).</p>`);
  }

  // 5. The divider. Everything below is context, not action: what changed
  //    overnight, cost, and (on a 0-planned night) why nothing was planned.
  const tail = [];
  // Acceptance recheck (S3-T4): shadow-mode observation about work already
  // marked finished. Context, never action — see renderRecheckBlock.
  if (data.recheck) tail.push(renderRecheckBlock(data.recheck));
  // 0-planned night: say WHY (night-1 fix — a bare "nothing to approve" read
  // as a malfunction and the owner immediately distrusted it).
  if (!items.length && queueSummary) tail.push(renderQueueSummary(queueSummary));
  // Owner's daily "what changed / did anything get stuck" digest — data is
  // gathered fail-soft by scripts/lib/overnight-digest.js; null renders nothing.
  if (data.digest) tail.push(require('./overnight-digest.js').renderDigestBlock(data.digest));
  // Site health (card #364 owner merge decision 2026-07-26): health-check.js's
  // former standalone "BSC Daily"/"BSC URGENT" email now lands here instead —
  // one scheduled morning email, not two. null when no fresh snapshot exists.
  if (data.health) tail.push(renderHealthDigestBlock(data.health));
  // Card #497: the two remaining routine scheduled digests (score-drift +
  // opening-night radar) fold in the same way. null when no fresh snapshot.
  if (data.dailyDigest) tail.push(renderDailyDigestBlock(data.dailyDigest));
  if (data.openingDigest) tail.push(renderOpeningDigestBlock(data.openingDigest));
  // Card #511: reddit-engagement-digest.js's twice-daily "worth replying to"
  // digest folds in the same way — one scheduled morning email, not three.
  // null when no fresh snapshot exists.
  if (data.redditDigest) tail.push(renderRedditDigestBlock(data.redditDigest));
  tail.push(renderUsageBlock(stats, admin, config));

  // "Closed N finished tabs" (S4-T3): the owner watches the workspace list
  // shrink overnight; without this line nothing says who did it.
  if (Number.isFinite(data.prunedCount) && data.prunedCount > 0) {
    tail.push(`<p style="font-size:12px;color:#666;margin:0 0 10px;">Closed ${data.prunedCount} finished tab${data.prunedCount > 1 ? 's' : ''} from earlier sessions.</p>`);
  }

  // Parked cards (card #777) — see renderParkedCardsBlock.
  if (Array.isArray(data.parkedCards) && data.parkedCards.length) {
    tail.push(renderParkedCardsBlock(data.parkedCards, data.parkedCardsMoreCount));
  }

  const footerBits = [];
  if (lastRunNote) footerBits.push(esc(lastRunNote));
  footerBits.push(`${awaitingTotal} awaiting approval`);
  tail.push(`<p style="color:#999;font-size:11px;margin-top:12px;text-align:center;">${footerBits.join(' · ')} · Broadway Scorecard autonomous loop</p>`);

  parts.push(`<div style="border-top:2px solid #e5e5e5;margin:24px 0 0;padding-top:8px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#bbb;margin:0 0 10px;">For your records</div>
    ${tail.join('\n')}
  </div>`);

  parts.push(`</div>`);
  return parts.join('\n');
}

module.exports = {
  renderEmail, renderItem, renderUsageBlock, renderQueueSummary, renderAttentionBlock, renderRecheckBlock, renderSummaryLine, summarizeQueue, skipBucket, extractWhy, esc,
  attentionCountOf, actionableAttentionCountOf, digestStuckCount,
  renderHealthDigestBlock, healthIssueCount, selectHealthRows,
  renderHealthScoreboard, renderAutofixBlock, plainHealthLine, autofixLoopDeadMessage,
  renderNamedDigestBlock, renderDailyDigestBlock, renderOpeningDigestBlock, renderRedditDigestBlock,
  buildPlainLanguageItemPrompt, sanitizePlainLanguageText,
  renderParkedCardsBlock,
};
