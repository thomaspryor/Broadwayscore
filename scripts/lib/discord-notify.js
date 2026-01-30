/**
 * Discord Notification Module
 *
 * Sends notifications to Discord webhooks for site monitoring.
 *
 * Channels:
 * - #alerts - CI failures, critical data issues, site errors
 * - #weekly-reports - Integrity report, review counts, box office updates
 * - #new-shows - When new shows are discovered or open
 *
 * Environment variables:
 * - DISCORD_WEBHOOK_ALERTS - Webhook URL for #alerts channel
 * - DISCORD_WEBHOOK_REPORTS - Webhook URL for #weekly-reports channel
 * - DISCORD_WEBHOOK_NEWSHOWS - Webhook URL for #new-shows channel
 *
 * Usage:
 *   const { sendAlert, sendReport, sendNewShowNotification } = require('./lib/discord-notify');
 *
 *   await sendAlert({
 *     title: 'CI Failure',
 *     description: 'Data validation failed',
 *     severity: 'error',
 *     fields: [{ name: 'Run', value: 'https://github.com/...' }]
 *   });
 */

const https = require('https');
const http = require('http');

// Color codes for Discord embeds
const COLORS = {
  success: 0x2ecc71, // Green
  warning: 0xf39c12, // Orange
  error: 0xe74c3c,   // Red
  info: 0x3498db,    // Blue
};

// Emoji for severity
const SEVERITY_EMOJI = {
  success: ':white_check_mark:',
  warning: ':warning:',
  error: ':x:',
  info: ':information_source:',
};

/**
 * Send a message to a Discord webhook
 *
 * @param {string} webhookUrl - Discord webhook URL
 * @param {Object} payload - Discord message payload
 * @returns {Promise<boolean>} - True if sent successfully
 */
async function sendToWebhook(webhookUrl, payload) {
  if (!webhookUrl) {
    console.log('[Discord] No webhook URL configured, skipping notification');
    return false;
  }

  return new Promise((resolve) => {
    try {
      const url = new URL(webhookUrl);
      const data = JSON.stringify(payload);

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      };

      const protocol = url.protocol === 'https:' ? https : http;

      const req = protocol.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log('[Discord] Notification sent successfully');
            resolve(true);
          } else {
            console.error(`[Discord] Failed to send: ${res.statusCode} ${body}`);
            resolve(false);
          }
        });
      });

      req.on('error', (err) => {
        console.error('[Discord] Request error:', err.message);
        resolve(false);
      });

      req.write(data);
      req.end();
    } catch (err) {
      console.error('[Discord] Error:', err.message);
      resolve(false);
    }
  });
}

/**
 * Send an alert notification (CI failures, critical issues)
 *
 * @param {Object} options - Alert options
 * @param {string} options.title - Alert title
 * @param {string} options.description - Alert description
 * @param {'error'|'warning'|'info'} options.severity - Severity level
 * @param {Array<{name: string, value: string}>} [options.fields] - Additional fields
 * @param {string} [options.url] - Link to more details
 */
async function sendAlert({ title, description, severity = 'error', fields = [], url }) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_ALERTS;

  const embed = {
    title: `${SEVERITY_EMOJI[severity]} ${title}`,
    description,
    color: COLORS[severity],
    timestamp: new Date().toISOString(),
    footer: {
      text: 'Broadway Scorecard Alerts',
    },
  };

  if (fields.length > 0) {
    embed.fields = fields.map(f => ({
      name: f.name,
      value: f.value,
      inline: f.inline !== false,
    }));
  }

  if (url) {
    embed.url = url;
  }

  return sendToWebhook(webhookUrl, {
    username: 'Broadway Scorecard',
    embeds: [embed],
  });
}

/**
 * Send a weekly report notification
 *
 * @param {Object} options - Report options
 * @param {string} options.title - Report title
 * @param {string} options.summary - Report summary
 * @param {Object} options.metrics - Key metrics
 * @param {boolean} [options.hasIssues] - Whether issues were found
 * @param {string} [options.url] - Link to full report
 */
async function sendReport({ title, summary, metrics, hasIssues = false, url }) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_REPORTS;
  const severity = hasIssues ? 'warning' : 'success';

  const fields = [];

  if (metrics) {
    if (metrics.totalReviews !== undefined) {
      fields.push({ name: 'Total Reviews', value: String(metrics.totalReviews), inline: true });
    }
    if (metrics.unknownOutlets !== undefined) {
      const emoji = metrics.unknownOutlets > 0 ? ':warning:' : ':white_check_mark:';
      fields.push({ name: 'Unknown Outlets', value: `${emoji} ${metrics.unknownOutlets}`, inline: true });
    }
    if (metrics.duplicates !== undefined) {
      const emoji = metrics.duplicates > 0 ? ':warning:' : ':white_check_mark:';
      fields.push({ name: 'Duplicates', value: `${emoji} ${metrics.duplicates}`, inline: true });
    }
    if (metrics.syncDelta !== undefined) {
      fields.push({ name: 'Sync Delta', value: String(metrics.syncDelta), inline: true });
    }
  }

  const embed = {
    title: `${SEVERITY_EMOJI[severity]} ${title}`,
    description: summary,
    color: COLORS[severity],
    fields,
    timestamp: new Date().toISOString(),
    footer: {
      text: 'Broadway Scorecard Weekly Report',
    },
  };

  if (url) {
    embed.url = url;
  }

  return sendToWebhook(webhookUrl, {
    username: 'Broadway Scorecard',
    embeds: [embed],
  });
}

/**
 * Send a new show notification
 *
 * @param {Object} options - Show notification options
 * @param {string} options.showTitle - Name of the show
 * @param {string} options.venue - Theater venue
 * @param {string} options.openingDate - Opening date
 * @param {'discovered'|'opened'|'closing_soon'} options.event - Event type
 * @param {string} [options.url] - Link to show page
 * @param {string} [options.imageUrl] - Show poster image
 */
async function sendNewShowNotification({ showTitle, venue, openingDate, event, url, imageUrl }) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_NEWSHOWS;

  const eventMessages = {
    discovered: 'New Broadway show discovered!',
    opened: 'Show has officially opened!',
    closing_soon: 'Show closing soon!',
  };

  const eventEmoji = {
    discovered: ':new:',
    opened: ':tada:',
    closing_soon: ':hourglass:',
  };

  const embed = {
    title: `${eventEmoji[event] || ':theatre:'} ${showTitle}`,
    description: eventMessages[event] || 'Show update',
    color: COLORS.info,
    fields: [
      { name: 'Venue', value: venue || 'TBA', inline: true },
      { name: 'Opening', value: openingDate || 'TBA', inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: {
      text: 'Broadway Scorecard',
    },
  };

  if (url) {
    embed.url = url;
  }

  if (imageUrl) {
    embed.thumbnail = { url: imageUrl };
  }

  return sendToWebhook(webhookUrl, {
    username: 'Broadway Scorecard',
    embeds: [embed],
  });
}

/**
 * Send a simple text message (for debugging or custom messages)
 *
 * @param {string} channel - Channel name: 'alerts', 'reports', 'newshows'
 * @param {string} message - Text message to send
 */
async function sendMessage(channel, message) {
  const webhooks = {
    alerts: process.env.DISCORD_WEBHOOK_ALERTS,
    reports: process.env.DISCORD_WEBHOOK_REPORTS,
    newshows: process.env.DISCORD_WEBHOOK_NEWSHOWS,
  };

  const webhookUrl = webhooks[channel];
  return sendToWebhook(webhookUrl, {
    username: 'Broadway Scorecard',
    content: message,
  });
}

/**
 * Check if Discord notifications are configured
 *
 * @returns {Object} - Status of each webhook
 */
function getNotificationStatus() {
  return {
    alerts: !!process.env.DISCORD_WEBHOOK_ALERTS,
    reports: !!process.env.DISCORD_WEBHOOK_REPORTS,
    newshows: !!process.env.DISCORD_WEBHOOK_NEWSHOWS,
  };
}

module.exports = {
  sendAlert,
  sendReport,
  sendNewShowNotification,
  sendMessage,
  sendToWebhook,
  getNotificationStatus,
  COLORS,
};
