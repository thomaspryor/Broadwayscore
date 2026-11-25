// BRO-8282: find the Claude session that asked a decision, so the email can link the owner to it.
// Only claude.ai/code/session_* URLs count (host-name fallbacks are shared by every session on a
// machine); comments written by batch/routine senders (the emailer, drains, wake, dispatch) are skipped.
const SESSION_URL_RE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/;
const BATCH_COMMENT_RE = /^(?:Emailed the owner|Listed in the owner|Headless worker ended|Dispatched\b|Owner answered|Owner reply|Woken|Wake\b|Reminder)/i;
const BATCH_MARKER_RE = /<!--\s*(?:owner-decision|decision-email|decision-reply|board-worker-wake|drain)[^>]*-->/i;

// Returns { url, isReport } so a session-report marker can outrank a later session's bare claim.
function sessionUrlOf(body, withKind = false) {
  const text = String(body || '');
  if (BATCH_COMMENT_RE.test(text.trim()) || BATCH_MARKER_RE.test(text)) return null;
  const marker = text.match(/<!-- session: (.+?) -->/);
  const m = (marker ? marker[1] : text.match(/^Claimed by (\S+)/m)?.[1] || '').match(SESSION_URL_RE);
  if (!m) return null;
  return withKind ? { url: m[0], isReport: Boolean(marker) } : m[0];
}

/** URL of the session that asked, or null. Prefers the latest session comment that itself carries the DECISION NEEDED block, else the latest session comment. */
function findAskingSessionUrl(comments = []) {
  const sorted = [...comments].filter((c) => c && c.body).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  let latest = null;
  let latestReport = null;
  let withBlock = null;
  for (const c of sorted) {
    const hit = sessionUrlOf(c.body, true);
    if (!hit) continue;
    latest = hit.url;
    if (hit.isReport) latestReport = hit.url;
    if (/^\s*(?:\*\*)?DECISION NEEDED:/im.test(c.body)) withBlock = hit.url;
  }
  // A report comment (the asker's own words) outranks a later session's bare claim.
  return withBlock || latestReport || latest;
}

module.exports = { findAskingSessionUrl, sessionUrlOf };
