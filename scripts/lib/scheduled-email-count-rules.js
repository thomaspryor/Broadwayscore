/**
 * scheduled-email-count-rules.js — pure classification/decision logic for
 * the scheduled-email-count monitor (card #510, scripts/monitor-scheduled-email-count.js).
 * No I/O here (CLAUDE.md §15 test-extraction pattern).
 *
 * Cards #364 and #497 both aimed to fold every scheduled digest onto
 * autonomous-email.js's single morning send ("exactly 1 scheduled owner
 * email/day"). Nothing verified that goal kept holding — this module is the
 * classifier half of that check.
 *
 * SCHEDULED_SENDERS is cross-referenced against DIGEST_OR_REVIEWED in
 * scripts/audit-alert-senders.js:43-53 (the definitive list of scheduled
 * digest scripts), narrowed to the ones that were confirmed via direct grep
 * on 2026-07-26 to still POST straight to Resend's send endpoint on their
 * own cron — discord-notify.js and owner-alert-router.js are excluded even though
 * audit-alert-senders.js lists them, because they're event-driven alert
 * plumbing (variable subjects, no fixed cron), not a standalone scheduled
 * digest. generate-remediation-plan.js is excluded too — it only fires on
 * `issues: opened` (auto-fix-feedback-bug.yml), not a schedule.
 *
 * Each pattern is sourced directly from the sender script's own subject-
 * building code, not guessed:
 *   - autonomous-email.js:502-526      → subject always starts "Overnight:"
 *   - send-daily-digest.js:266-270     → "(⚠️ )?Daily Digest: N change(s)..."
 *   - send-opening-digest.js:636-696   → buildSubject() joins phrases like
 *                                         "N needs help", "N broadcast-ready",
 *                                         "N upcoming this week", or "Quiet week"
 *   - reddit-engagement-digest.js:571  → "r/Broadway — N thread(s) for you"
 *   - fantasy-weekly-email.js:274      → "[Action Required] Fantasy weekly draft ready — <week>"
 *   - health-check.js:1867-1889        → "BSC Daily: ..." / "BSC URGENT (day N): ..."
 *     (card #364 removed this send path on 2026-07-26 17:29 UTC — kept here
 *     so a regression or an un-migrated older run still gets classified
 *     correctly instead of falling into "other").
 */
'use strict';

const SCHEDULED_SENDERS = [
  { key: 'autonomous-email', label: 'Overnight morning email', script: 'scripts/autonomous-email.js', pattern: /^Overnight:/ },
  { key: 'daily-digest', label: 'Daily Digest (score-drift)', script: 'scripts/send-daily-digest.js', pattern: /Daily Digest:/ },
  { key: 'opening-digest', label: 'Opening-night admin digest', script: 'scripts/send-opening-digest.js', pattern: /needs help|broadcast-ready|upcoming this week|^Quiet week/ },
  { key: 'reddit-engagement-digest', label: 'Reddit engagement digest', script: 'scripts/reddit-engagement-digest.js', pattern: /^r\/Broadway —/ },
  { key: 'fantasy-weekly', label: 'Fantasy weekly draft notice', script: 'scripts/fantasy-weekly-email.js', pattern: /^\[Action Required\] Fantasy weekly draft ready/ },
  { key: 'health-check-digest', label: 'Health check digest (legacy path)', script: 'scripts/health-check.js', pattern: /^BSC (Daily|URGENT)/ },
];

function classifySubject(subject) {
  const s = String(subject || '');
  for (const sender of SCHEDULED_SENDERS) {
    if (sender.pattern.test(s)) return sender;
  }
  return null;
}

// Resend `created_at` is always UTC, formatted "YYYY-MM-DD HH:MM:SS[.ffffff]+00".
function toDate(createdAt) {
  return new Date(String(createdAt).trim().replace(' ', 'T').replace(/\+00$/, 'Z'));
}

// America/New_York calendar-date key — the owner is US-based, so "one email
// today" should mean one email in the day the owner actually experiences,
// not a UTC day that splits around 8pm ET.
function dayKeyET(createdAt) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(toDate(createdAt));
}

/**
 * Filters `emails` (Resend GET /emails `data` rows) to ones addressed to
 * ownerEmail, classifies each against SCHEDULED_SENDERS, and buckets by ET
 * calendar day.
 * @returns {Map<string, {senders: Map<string,{label:string,subjects:string[]}>, other: Array<{subject,created_at}>}>}
 */
function buildDailyReport(emails, ownerEmail) {
  const owner = String(ownerEmail || '').toLowerCase();
  const days = new Map();
  for (const e of emails || []) {
    const to = Array.isArray(e.to) ? e.to : [e.to];
    if (!to.some((t) => String(t || '').toLowerCase() === owner)) continue;

    const dayKey = dayKeyET(e.created_at);
    if (!days.has(dayKey)) days.set(dayKey, { senders: new Map(), other: [] });
    const day = days.get(dayKey);

    const match = classifySubject(e.subject);
    if (match) {
      if (!day.senders.has(match.key)) day.senders.set(match.key, { label: match.label, subjects: [] });
      day.senders.get(match.key).subjects.push(e.subject);
    } else {
      day.other.push({ subject: e.subject, created_at: e.created_at });
    }
  }
  return days;
}

// Pure decision for one day's bucket: violates "exactly 1 scheduled digest
// sender/day" iff 2+ distinct SCHEDULED_SENDERS fired. Unclassified ("other")
// owner emails (one-off CRITICAL/ACTION alerts routed via owner-alert-router)
// are reported for visibility but never count toward this verdict — they're
// a separate, already-monitored noise class (alert-ledger dedup, E2E canary #374).
function decideDayViolation(dayBucket) {
  const senderKeys = [...dayBucket.senders.keys()];
  return {
    violation: senderKeys.length > 1,
    senderCount: senderKeys.length,
    senders: senderKeys.map((k) => ({ key: k, ...dayBucket.senders.get(k) })),
  };
}

module.exports = { SCHEDULED_SENDERS, classifySubject, dayKeyET, buildDailyReport, decideDayViolation };
