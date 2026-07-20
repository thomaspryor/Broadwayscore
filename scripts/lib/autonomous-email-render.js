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
  if (entry.decision === 'split') return 'too large — split proposed';
  const r = (entry.preFilter && entry.preFilter.reason) || '';
  if (/human territory/i.test(r)) return 'human territory (marketing/partnerships)';
  if (/human action/i.test(r)) return 'human-action title (emailing, posting, meeting)';
  if (/deny-tag/i.test(r)) return 'deny-tagged domain (email/commercial/scoring/ios)';
  if (/already in Auto/i.test(r)) return 'already processed by the loop';
  if (/fetch failed/i.test(r)) return 'card fetch failed (transient)';
  if (entry.triage && entry.triage.eligible === false) return 'out of Tier-1 scope (needs src/, data/, or CI changes)';
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
  const workable = buckets.some(b => /Tier-1 scope|human/i.test(b.reason));
  return {
    generatedAt: queue.generatedAt || null,
    total: queue.counts.total || queue.entries.length,
    fetched: queue.counts.fetched ?? null,
    candidates: queue.counts.candidates ?? null,
    buckets,
    unlock: workable
      ? 'What would unlock work: backlog cards whose fix lives in Tier-1 paths (tests/, docs/, memory/, leaf tooling scripts). Tonight every triaged card needed human action or out-of-tier changes.'
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
    <div style="font-size:13px;font-weight:700;margin-bottom:6px;">Why nothing was planned — ${esc(scanned)}, 0 workable${when}</div>
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
  const { configWarnings = [], failedCards = [], parkedItems = [] } = attention || {};
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
      action: 'too big for the loop — needs an interactive session, or split the card',
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
    <div style="font-size:13px;font-weight:700;margin-bottom:8px;color:#b45309;">Needs your attention — ${lines.length} item${lines.length > 1 ? 's' : ''} stalling the loop</div>
    ${rows}
  </div>`;
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
    ? `<div style="font-size:14px;color:#111;margin-bottom:8px;">${esc(item.plainText)}</div>
    <div style="font-size:11px;color:#999;margin-bottom:10px;">${item.why ? `Why: ${esc(item.why)}<br>` : ''}Done: ${esc(item.summary || 'change implemented and verified')}<br>Branch: ${esc(item.branch)}</div>`
    : `${item.why ? `<div style="font-size:13px;color:#666;margin-bottom:4px;"><b>Why:</b> ${esc(item.why)}</div>` : ''}
    <div style="font-size:13px;color:#333;margin-bottom:6px;"><b>Done:</b> ${esc(item.summary || 'change implemented and verified')} <span style="color:#999;">(${esc(item.branch)})</span></div>`;
  return `<div style="border:1px solid #e5e5e5;border-radius:10px;padding:16px;margin:0 0 14px;">
    <div style="font-size:15px;font-weight:700;margin-bottom:6px;">${esc(item.name)} ${badge}${cost}</div>
    ${body}
    ${checks ? `<div style="font-size:12px;color:#16a34a;margin-bottom:10px;">${checks}</div>` : ''}
    <div>${btn('Approve', item.approveUrl, '#16a34a')}${btn('Reject', item.rejectUrl, '#6b7280')}</div>
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

/**
 * @param {object} data
 *   items: [{ name, why, summary, branch, usd, checks[], approveUrl, rejectUrl }]
 *   moreAwaiting: number (needs-approval beyond the ≤3 shown)
 *   failedCount: number, skippedCount: number, throttled: string|null
 *   runSkipped: string|null (run-skip ledger note — auth expiry etc.)
 *   queueSummary: summarizeQueue() result|null (0-planned skip breakdown)
 *   stats: usageStats() result · admin: fetchAdminUsage() result|null
 *   config: { weeklyUSD } · lastRunNote: string|null · awaitingTotal: number
 */
function renderEmail(data) {
  const { items = [], moreAwaiting = 0, failedCount = 0, throttled = null, runSkipped = null, queueSummary = null, attention = null, stats, admin = null, config = {}, lastRunNote = null, awaitingTotal = 0 } = data;

  const parts = [];
  parts.push(`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:18px 14px;color:#111;">`);
  parts.push(`<h2 style="font-size:18px;margin:0 0 14px;">Overnight work — ${items.length ? `${items.length} item${items.length > 1 ? 's' : ''} awaiting your tap` : 'nothing to approve'}</h2>`);

  if (runSkipped) {
    // Never a silent no-op night: an auth-expired or broken preflight is the
    // first thing the owner reads, in red, with what to do about it.
    parts.push(`<p style="font-size:14px;font-weight:700;color:#dc2626;margin:0 0 12px;">⛔ ${esc(runSkipped)}</p>`);
  }
  if (throttled) {
    // `throttled` is a generic banner string — it may carry an actual
    // throttle, a Notion listing failure, or a missing-evidence notice, each
    // self-describing, so use a neutral marker not a hardcoded "Throttled:".
    parts.push(`<p style="font-size:13px;color:#b45309;margin:0 0 12px;">⚠️ ${esc(throttled)}</p>`);
  }
  // Attention block sits ABOVE approvals: a stalled loop outranks routine
  // taps — three silent-zero nights (07-17..19) is the incident this fixes.
  const attentionHtml = renderAttentionBlock(attention);
  if (attentionHtml) parts.push(attentionHtml);
  for (const item of items) parts.push(renderItem(item));
  // 0-planned night: say WHY (night-1 fix — the bare "nothing to approve"
  // read as a malfunction and the owner immediately distrusted it).
  if (!items.length && queueSummary) parts.push(renderQueueSummary(queueSummary));
  if (moreAwaiting > 0) {
    parts.push(`<p style="font-size:13px;color:#666;">+${moreAwaiting} more item${moreAwaiting > 1 ? 's' : ''} awaiting approval (shown over the next mornings).</p>`);
  }
  if (failedCount > 0) {
    parts.push(`<p style="font-size:13px;color:#666;margin:6px 0;">${failedCount} card${failedCount > 1 ? 's' : ''} failed overnight (details on the cards; nothing was pushed for them).</p>`);
  }

  parts.push(renderUsageBlock(stats, admin, config));

  const footerBits = [];
  if (lastRunNote) footerBits.push(esc(lastRunNote));
  footerBits.push(`${awaitingTotal} awaiting approval`);
  parts.push(`<p style="color:#999;font-size:11px;margin-top:18px;text-align:center;">${footerBits.join(' · ')} · Broadway Scorecard autonomous loop</p>`);
  parts.push(`</div>`);
  return parts.join('\n');
}

module.exports = {
  renderEmail, renderItem, renderUsageBlock, renderQueueSummary, renderAttentionBlock, summarizeQueue, skipBucket, extractWhy, esc,
  buildPlainLanguageItemPrompt, sanitizePlainLanguageText,
};
