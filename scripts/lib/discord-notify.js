/**
 * Notification Module (formerly Discord)
 *
 * Discord removed — all alerts route to email (Resend) for critical issues,
 * or log-only for everything else. BSC Daily email digest covers non-critical.
 *
 * Env vars: RESEND_API_KEY, OWNER_EMAIL (required for email alerts)
 *
 * audit-secret-scan-always-trace: required by 25+ scripts (well over
 * workflow-secret-scan.js's SHARED_MODULE_THRESHOLD), but RESEND_API_KEY/
 * OWNER_EMAIL above are hard, no-fallback dependencies for the email path —
 * not an optional provider in a degrade-gracefully chain. Without this
 * marker, scripts/audit-workflow-secret-gaps.js silently never traces these
 * for any caller (see linear-client.js's identical marker for the sibling
 * incident this was found alongside).
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Append-only log of every owner email actually delivered through this
// chokepoint (card #475: the alert-noise regression audit). This is the
// ONE place nearly every ad-hoc CRITICAL sender ends up (direct sendAlert()
// calls AND owner-alert-router's disposition='human' path both funnel
// through sendEmailAlert below) — logging here, rather than at each of the
// ~25 call sites, gives a single source for "how many owner emails fired
// this week and from what" without having to instrument every caller.
// Scheduled digests that hit api.resend.com directly (send-daily-digest.js,
// autonomous-email.js, etc. — see lint-resend-calls.js's ALLOWLIST) are
// intentionally NOT captured here: they're the one known-good daily email,
// not the noise class this log exists to surface.
const SEND_LOG_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'owner-email-log.jsonl');
const SEND_LOG_RETENTION_DAYS = 30;

function logOwnerEmailSent({ title, severity }) {
  try {
    const cutoff = Date.now() - SEND_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let lines = [];
    try {
      lines = fs.readFileSync(SEND_LOG_PATH, 'utf8').split('\n').filter(Boolean);
    } catch { /* missing — first entry */ }
    const kept = lines.filter(line => {
      try { return new Date(JSON.parse(line).ts).getTime() >= cutoff; } catch { return false; }
    });
    kept.push(JSON.stringify({ ts: new Date().toISOString(), title, severity }));
    fs.mkdirSync(path.dirname(SEND_LOG_PATH), { recursive: true });
    fs.writeFileSync(SEND_LOG_PATH, kept.join('\n') + '\n');
  } catch (err) {
    console.error(`[Email] failed to write owner-email-log (non-fatal): ${err.message}`);
  }
}


/**
 * Actionable-only email policy (2026-07-11, owner request): the inbox had 305
 * automated alerts, most of them warning/info-level FYIs (WE review gaps,
 * opening-night drop warnings, orphan-unscored, regional auto-adds). Email is
 * reserved for severities that demand ACTION — 'critical' and 'error' (the
 * latter renders as [CRITICAL] in the subject line). warning/info alerts are
 * logged + surfaced in the run's step summary; systemic problems still reach
 * the owner via the BSC Daily digest's repeat-failure promotion.
 *
 * Enforced INSIDE sendEmailAlert so direct callers can't bypass it.
 */
const EMAILABLE_SEVERITIES = new Set(['critical', 'error']);

function shouldEmailAlert(severity) {
  return EMAILABLE_SEVERITIES.has(severity);
}

/**
 * Send an email alert via Resend (for truly critical issues)
 * Requires RESEND_API_KEY and OWNER_EMAIL env vars.
 */
async function sendEmailAlert({ title, description, severity = 'error', fields = [], url }) {
  if (!shouldEmailAlert(severity)) {
    console.log(`[Alert policy] email suppressed for severity=${severity} — "${title}" (actionable-only policy; see BSC Daily / run logs)`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY,
          `\n> ⚠️ [${severity}] **${title}** — ${description || ''} _(email suppressed by actionable-only policy)_\n`);
      } catch {}
    }
    return false;
  }
  const apiKey = process.env.RESEND_API_KEY;
  const ownerEmail = process.env.OWNER_EMAIL;

  if (!apiKey || !ownerEmail) {
    console.log('[Email] RESEND_API_KEY or OWNER_EMAIL not set, skipping email alert');
    return false;
  }

  const severityLabel = { critical: 'CRITICAL', error: 'CRITICAL', warning: 'WARNING', info: 'INFO' };
  const fieldsHtml = fields.map(f => `<li><strong>${f.name}:</strong> ${f.value}</li>`).join('\n');
  const html = `
    <div style="font-family: system-ui, sans-serif; max-width: 600px;">
      <h2 style="color: ${severity === 'error' ? '#e74c3c' : severity === 'warning' ? '#f39c12' : '#3498db'}">
        [${severityLabel[severity] || 'ALERT'}] ${title}
      </h2>
      <p>${description}</p>
      ${fieldsHtml ? `<ul>${fieldsHtml}</ul>` : ''}
      ${url ? `<p><a href="${url}">View details</a></p>` : ''}
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
      <p style="color: #999; font-size: 12px;">Broadway Scorecard automated alert</p>
    </div>
  `;

  return new Promise((resolve) => {
    try {
      const data = JSON.stringify({
        from: 'Broadway Scorecard <alerts@broadwayscorecard.com>',
        to: [ownerEmail],
        subject: `[${severityLabel[severity] || 'ALERT'}] ${title}`,
        html,
      });

      const req = https.request({
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(data),
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log('[Email] Alert email sent successfully');
            logOwnerEmailSent({ title, severity });
            resolve(true);
          } else {
            console.error(`[Email] Failed to send: ${res.statusCode} ${body}`);
            resolve(false);
          }
        });
      });

      req.on('error', (err) => {
        console.error('[Email] Request error:', err.message);
        resolve(false);
      });

      req.write(data);
      req.end();
    } catch (err) {
      console.error('[Email] Error:', err.message);
      resolve(false);
    }
  });
}

async function sendAlert({ title, description, severity = 'error', fields = [], url, email = false }) {
  console.log(`[Alert] ${title}: ${description}`);
  if (email) {
    // Policy suppression is not a delivery failure — sendEmailAlert logs it
    // and returns false; don't fire the ::error:: delivery-failed annotation.
    if (!shouldEmailAlert(severity)) {
      return sendEmailAlert({ title, description, severity, fields, url });
    }
    const delivered = await sendEmailAlert({ title, description, severity, fields, url });
    if (!delivered) {
      // A requested-but-failed alert is itself a critical failure: this exact
      // silent path is why months of completeness alerts reached nobody
      // (2026-07-09 plan-review finding). Surface it where CI makes it visible.
      console.error(`::error::alert delivery FAILED (email) — "${title}". Check RESEND_API_KEY / OWNER_EMAIL. The alert content was only logged, nobody was notified.`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        try {
          require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY,
            `\n## 🚨 Alert delivery FAILED\n\n**${title}** — email could not be sent (RESEND_API_KEY/OWNER_EMAIL missing or Resend error). Alert was log-only.\n`);
        } catch {}
      }
    }
    return delivered;
  }
  return false;
}

// No-ops kept for call-site compatibility
async function sendReport() { return false; }
async function sendNewShowNotification() { return false; }
async function sendMessage() { return false; }
function getNotificationStatus() { return { alerts: false, reports: false, newshows: false }; }

// Trailing-N-day read of the owner-email send log for the BSC Daily digest's
// "how much did I actually get paged this week" section (card #475 acceptance
// criterion: creep must be visible without combing the inbox).
function readOwnerEmailLog({ days = 7 } = {}) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let lines = [];
  try {
    lines = fs.readFileSync(SEND_LOG_PATH, 'utf8').split('\n').filter(Boolean);
  } catch { /* missing — no sends logged yet */ }
  return lines
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .filter(entry => new Date(entry.ts).getTime() >= cutoff);
}

module.exports = {
  sendAlert,
  sendEmailAlert, // resolves true/false — for callers that must act on delivery failure
  shouldEmailAlert, // pure policy predicate — unit-tested in alert-email-policy.test.mjs
  sendReport,
  sendNewShowNotification,
  sendMessage,
  getNotificationStatus,
  readOwnerEmailLog,
  _SEND_LOG_PATH: SEND_LOG_PATH,
};
