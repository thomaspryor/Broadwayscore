// Pre-send soft-issue banner — single source of truth for BOTH sides:
// pre-send-check.mjs injects it into the generated newsletter HTML so the
// owner sees soft issues in the preview email; create-broadcast-draft.mjs
// strips it before PATCHing the real audience draft so subscribers never see
// it (task #746 — on 2026-08-02 the operator hand-stripped it twice on a live
// send night). Builder and stripper live together so the marker can never
// drift apart: if the banner's look changes here, the strip regex changes
// with it. Do NOT redefine the banner markup or the marker color anywhere
// else — the 2026-08-03 second-opinion review flagged exactly that
// duplication as a silent-regression path.

// Unique marker: this background color appears nowhere in the real newsletter
// templates (verified across generate.mjs 2026-08-03), so it doubles as the
// strip anchor.
const BANNER_MARKER = 'background:#7c2d12';

// The banner deliberately contains no nested <div> — the non-greedy strip
// regex below terminates at the banner's own closing tag. Keep it that way;
// the colocated test enforces the round-trip.
function buildPreSendBanner(issues) {
  const issueList = issues.map(i => `<li style="margin:2px 0;">${i}</li>`).join('');
  return `
<div style="${BANNER_MARKER};color:#fef2f2;font-family:monospace;font-size:12px;padding:12px 16px;margin:0 0 0 0;border-bottom:2px solid #dc2626;">
  <strong>⚠️ PRE-SEND ISSUES — fix before broadcasting to subscribers:</strong>
  <ul style="margin:6px 0 0 0;padding-left:20px;">${issueList}</ul>
</div>`;
}

// Leading \s* consumes the newline buildPreSendBanner's template literal
// starts with, so a strip restores the pre-injection HTML byte-for-byte.
const BANNER_RE = new RegExp(`\\s*<div style="${BANNER_MARKER};[\\s\\S]*?</div>`);

// Returns { html, stripped } — callers decide how loudly to report a strip.
function stripPreSendBanner(html) {
  if (!BANNER_RE.test(html)) return { html, stripped: false };
  return { html: html.replace(BANNER_RE, ''), stripped: true };
}

module.exports = { buildPreSendBanner, stripPreSendBanner, BANNER_MARKER };
