'use strict';

// btc-confirmation.js — pure logic for the BTC retroactive confirmation
// sender (BRO-1325). Extracted so scripts/send-btc-confirmation-emails.js
// can require() it and scripts/send-btc-confirmation-emails.test.mjs can
// exercise the decision logic without a network or filesystem dependency.

// Parses the submissions JSONL. The file also contains non-entrant rows
// (source: gold-derby-consensus, kalshi-market — market data with no email
// field, used elsewhere for critic-score comparisons) that must be skipped
// rather than crashing the parse.
function parseSubmissionsJsonl(text) {
  const records = [];
  let skippedNoEmail = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!row.email || typeof row.email !== 'string' || !row.email.trim()) {
      skippedNoEmail++;
      continue;
    }
    records.push(row);
  }
  return { records, skippedNoEmail };
}

// De-duplicates by lowercased email, latest submission wins. Falls back to
// last-in-file-wins when submittedAt is missing on one or both sides, so a
// malformed/undated row never loses to an earlier dated one by accident.
function dedupeLatestByEmail(records) {
  const byEmail = new Map();
  for (const record of records) {
    const key = record.email.trim().toLowerCase();
    const existing = byEmail.get(key);
    if (!existing) {
      byEmail.set(key, record);
      continue;
    }
    const existingDate = existing.submittedAt;
    const candidateDate = record.submittedAt;
    if (!candidateDate || !existingDate || candidateDate >= existingDate) {
      byEmail.set(key, record);
    }
  }
  return byEmail;
}

// Recipients not present (case-insensitively) in the sent-log set.
function filterUnsent(recipients, sentSet) {
  return recipients.filter(r => !sentSet.has(r.email.trim().toLowerCase()));
}

const CEREMONY_YEAR = 2026;

// Picks originate from a user-submitted POST body (send-picks/route.ts
// doesn't constrain values to the nominee list), so they're untrusted
// input rendered into an HTML email — escape before interpolating.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Builds the confirmation email. Deliberately NOT a byte-for-byte reuse of
// send-picks/route.ts's pre-ceremony copy ("we'll email you after the
// ceremony with your results") — the 2026-06-07 ceremony has already
// happened and results already went out (2026-06-12), so that wording would
// be false if sent now. Same visual template; copy corrected for a
// retroactive send.
function buildConfirmationEmail({ email, picks, ceremonyYear }) {
  const year = ceremonyYear ?? CEREMONY_YEAR;
  const picksHtml = Object.entries(picks || {})
    .map(([cat, pick]) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #1f1f1f;color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">${escapeHtml(cat.replace('Best ', ''))}</td>
          <td style="padding:8px 0;border-bottom:1px solid #1f1f1f;color:#ffffff;font-size:14px;font-weight:700;text-align:right;">${escapeHtml(pick)}</td>
        </tr>`)
    .join('');

  const pickCount = Object.keys(picks || {}).length;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:32px 16px;">
    <div style="background:#111111;border:1px solid #1f1f1f;border-radius:16px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,rgba(255,19,104,0.1),rgba(0,85,255,0.06));padding:28px 28px 20px;border-bottom:1px solid #1f1f1f;text-align:center;">
        <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Broadway Scorecard</div>
        <div style="font-size:24px;font-weight:900;color:#ffffff;letter-spacing:-0.03em;">My Tony Picks</div>
        <div style="font-size:13px;color:#6b7280;margin-top:4px;">Beat the Critics &middot; ${year}</div>
      </div>
      <div style="padding:20px 28px;">
        <table style="width:100%;border-collapse:collapse;">
          ${picksHtml}
        </table>
      </div>
      <div style="padding:16px 28px 24px;text-align:center;">
        <div style="font-size:13px;font-weight:700;color:#ff1368;margin-bottom:6px;">Sorry for the delay — here's the confirmation you should have gotten back in ${year === CEREMONY_YEAR ? 'June' : year}.</div>
        <div style="font-size:12px;color:#4b5563;margin-bottom:4px;">A delivery issue meant some entrants never got this email when they submitted their picks.</div>
        <div style="font-size:12px;color:#4b5563;margin-bottom:6px;">The ${year} Tony Awards have already taken place — see how your picks compared to the winners.</div>
        <div style="margin-top:16px;">
          <a href="https://broadwayscorecard.com/beat-the-critics" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#ff1368,#d4106a);color:#ffffff;text-decoration:none;border-radius:10px;font-size:13px;font-weight:700;">See Full Results &rarr;</a>
        </div>
      </div>
    </div>
    <div style="text-align:center;padding:20px 0 0;font-size:11px;color:#374151;">
      You picked ${pickCount} categor${pickCount === 1 ? 'y' : 'ies'} for the ${year} Tony Awards.<br>
      <a href="https://broadwayscorecard.com" style="color:#4b5563;text-decoration:none;">broadwayscorecard.com</a>
    </div>
  </div>
</body>
</html>`;

  return { subject: `Your ${year} Tony Award Picks (confirmed)`, html };
}

module.exports = {
  parseSubmissionsJsonl,
  dedupeLatestByEmail,
  filterUnsent,
  buildConfirmationEmail,
  CEREMONY_YEAR,
};
