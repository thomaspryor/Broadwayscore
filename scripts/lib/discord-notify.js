/**
 * Notification Module (formerly Discord)
 *
 * Discord removed — all alerts route to email (Resend) for critical issues,
 * or log-only for everything else. BSC Daily email digest covers non-critical.
 *
 * Env vars: RESEND_API_KEY, OWNER_EMAIL (required for email alerts)
 */

const https = require('https');


/**
 * Send an email alert via Resend (for truly critical issues)
 * Requires RESEND_API_KEY and OWNER_EMAIL env vars.
 */
async function sendEmailAlert({ title, description, severity = 'error', fields = [], url }) {
  const apiKey = process.env.RESEND_API_KEY;
  const ownerEmail = process.env.OWNER_EMAIL;

  if (!apiKey || !ownerEmail) {
    console.log('[Email] RESEND_API_KEY or OWNER_EMAIL not set, skipping email alert');
    return false;
  }

  const severityLabel = { error: 'CRITICAL', warning: 'WARNING', info: 'INFO' };
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
    await sendEmailAlert({ title, description, severity, fields, url });
  }
  return false;
}

// No-ops kept for call-site compatibility
async function sendReport() { return false; }
async function sendNewShowNotification() { return false; }
async function sendMessage() { return false; }
function getNotificationStatus() { return { alerts: false, reports: false, newshows: false }; }

module.exports = {
  sendAlert,
  sendEmailAlert, // resolves true/false — for callers that must act on delivery failure
  sendReport,
  sendNewShowNotification,
  sendMessage,
  getNotificationStatus,
};
