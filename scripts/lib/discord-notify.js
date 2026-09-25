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
// idempotencyKey (BRO-4141): Resend's Idempotency-Key makes the FIRST send
// with a key win for 24h; a repeat returns the original id (200) or 409 if the
// body changed. This is the only cross-runner dedup that holds when parallel
// CI jobs each read a stale cooldown ledger (7 identical "main test.yml STILL
// red" emails in 20 min on 2026-09-23 through a 24h cooldown).
async function sendEmailAlert({ title, description, severity = 'error', fields = [], url, idempotencyKey }) {
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

  // Callers that don't pass a key (the direct sendAlert({email:true}) senders)
  // get one keyed on the whole message, so only an exact duplicate from a
  // parallel runner is dropped; two different incidents that share a static
  // title still both reach the owner.
  const subject = `[${severityLabel[severity] || 'ALERT'}] ${title}`;
  idempotencyKey = idempotencyKey || defaultIdempotencyKey(subject + html, Date.now());
  const data = JSON.stringify({
    from: 'Broadway Scorecard <alerts@broadwayscorecard.com>',
    to: [ownerEmail],
    subject,
    html,
  });

  // A concurrent_idempotent_requests 409 means another runner's identical-key
  // send is still in flight and may yet fail, so it is not proof of delivery:
  // wait and ask again. Once that send finishes, Resend answers 200 (same body)
  // or invalid_idempotent_request (different body), and both mean it went out.
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await postResendEmail(apiKey, data, idempotencyKey);
    const outcome = classifyResendResponse(res.statusCode, res.body);
    if (outcome === 'sent') {
      console.log('[Email] Alert email sent successfully');
      logOwnerEmailSent({ title, severity });
      return true;
    }
    if (outcome === 'duplicate') {
      console.log(`[Email] Duplicate suppressed by Idempotency-Key ${idempotencyKey}`);
      return true;
    }
    if (outcome !== 'in-flight') {
      console.error(`[Email] Failed to send: ${res.statusCode} ${res.body}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  console.error(`[Email] Gave up: identical send still in flight after retries (${idempotencyKey})`);
  return false;
}

function postResendEmail(apiKey, data, idempotencyKey) {
  return new Promise((resolve) => {
    try {
      const req = https.request({
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(data),
          'Idempotency-Key': idempotencyKey,
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      });
      req.on('error', (err) => resolve({ statusCode: 0, body: `request error: ${err.message}` }));
      req.write(data);
      req.end();
    } catch (err) {
      resolve({ statusCode: 0, body: `error: ${err.message}` });
    }
  });
}

// Hashed so a long key can't lose its time bucket to Resend's 256-char cap.
function defaultIdempotencyKey(content, nowMs) {
  const digest = require('crypto').createHash('sha1').update(String(content)).digest('hex').slice(0, 20);
  return `owner-alert-msg:${digest}:${Math.floor(nowMs / 3600e3)}`;
}

// Resend reuses of an Idempotency-Key (verified live 2026-09-25):
//   200 + original id                   -> same body, already sent
//   409 invalid_idempotent_request      -> different body, first send completed
//   409 concurrent_idempotent_requests  -> first send still in flight
function classifyResendResponse(statusCode, body) {
  if (statusCode >= 200 && statusCode < 300) return 'sent';
  const b = String(body || '');
  if (statusCode === 409 && /concurrent_idempotent_requests/.test(b)) return 'in-flight';
  if (statusCode === 409 && /invalid_idempotent_request/.test(b)) return 'duplicate';
  return 'failed';
}

async function sendAlert({ title, description, severity = 'error', fields = [], url, email = false, idempotencyKey }) {
  console.log(`[Alert] ${title}: ${description}`);
  if (email) {
    // Policy suppression is not a delivery failure — sendEmailAlert logs it
    // and returns false; don't fire the ::error:: delivery-failed annotation.
    if (!shouldEmailAlert(severity)) {
      return sendEmailAlert({ title, description, severity, fields, url, idempotencyKey });
    }
    const delivered = await sendEmailAlert({ title, description, severity, fields, url, idempotencyKey });
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
  classifyResendResponse,
  defaultIdempotencyKey,
  sendReport,
  sendNewShowNotification,
  sendMessage,
  getNotificationStatus,
  readOwnerEmailLog,
  _SEND_LOG_PATH: SEND_LOG_PATH,
};
