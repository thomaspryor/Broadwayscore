# Discord Notification Setup

This guide explains how to configure Discord notifications for Broadway Scorecard.

## Overview

Discord notifications keep you informed about:
- **#alerts**: CI failures, critical data issues, site errors
- **#weekly-reports**: Integrity reports, review counts, health metrics
- **#new-shows**: New Broadway shows discovered or opened

## Step 1: Create a Discord Server

If you don't have one already:
1. Open Discord (desktop or mobile app)
2. Click the "+" button on the left sidebar
3. Choose "Create My Own"
4. Name it something like "Broadway Scorecard"

## Step 2: Create Channels

Create three text channels for different notification types:
1. Right-click the server name → "Create Channel"
2. Create these channels:
   - `#alerts` - For urgent issues (CI failures, data problems)
   - `#weekly-reports` - For scheduled reports
   - `#new-shows` - For show discovery notifications

## Step 3: Create Webhooks

For each channel, create a webhook:

1. Right-click the channel → "Edit Channel"
2. Go to "Integrations" → "Webhooks"
3. Click "New Webhook"
4. Name it "Broadway Scorecard" (or any name you prefer)
5. Click "Copy Webhook URL"
6. Save this URL - you'll need it for GitHub secrets

Repeat for all three channels. You should have three webhook URLs.

## Step 4: Add GitHub Secrets

Add the webhook URLs as GitHub repository secrets:

1. Go to your repository on GitHub
2. Navigate to Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Add these secrets:

| Secret Name | Value |
|-------------|-------|
| `DISCORD_WEBHOOK_ALERTS` | Webhook URL for #alerts channel |
| `DISCORD_WEBHOOK_REPORTS` | Webhook URL for #weekly-reports channel |
| `DISCORD_WEBHOOK_NEWSHOWS` | Webhook URL for #new-shows channel |

## Step 5: Verify Setup

The notifications will start working automatically on the next workflow run.

To test immediately:
1. Go to Actions → "Weekly Data Integrity Check"
2. Click "Run workflow"
3. Check your Discord #weekly-reports channel

## Notification Types

### Alerts (#alerts)

Sent when:
- CI tests fail (data validation or E2E tests)
- Critical data quality issues detected (unknown outlets, duplicates)

Example:
```
❌ CI Failure: Data Validation
Data validation checks failed. Review required.

Workflow: Test Suite
Job: Data Validation
Trigger: push

[Link to workflow run]
```

### Weekly Reports (#weekly-reports)

Sent every Sunday with data quality metrics:

Example:
```
✅ Weekly Data Integrity Report
All metrics look healthy

Total Reviews: 2111
Unknown Outlets: ✅ 0
Duplicates: ✅ 0
Sync Delta: 13

[Link to workflow run]
```

### New Shows (#new-shows)

Sent when new Broadway shows are discovered:

Example:
```
🆕 Maybe Happy Ending
New Broadway show discovered!

Venue: Belasco Theatre
Opening: January 16, 2025

[Link to show page]
```

## Customization

### Notification Module

The notification logic is in `scripts/lib/discord-notify.js`. You can customize:
- Colors (success, warning, error, info)
- Message formats
- Which events trigger notifications

### Adding New Notification Types

To add notifications to other workflows:

```javascript
const { sendAlert, sendReport, sendNewShowNotification } = require('./scripts/lib/discord-notify.js');

// Send an alert
await sendAlert({
  title: 'Alert Title',
  description: 'What happened',
  severity: 'error', // 'error', 'warning', or 'info'
  fields: [
    { name: 'Field Name', value: 'Field Value' }
  ],
  url: 'https://link-to-details.com'
});

// Send a report
await sendReport({
  title: 'Report Title',
  summary: 'Summary text',
  metrics: {
    totalReviews: 2111,
    unknownOutlets: 0,
    duplicates: 0,
    syncDelta: 13
  },
  hasIssues: false,
  url: 'https://link-to-report.com'
});

// Send a new show notification
await sendNewShowNotification({
  showTitle: 'Show Name',
  venue: 'Theater Name',
  openingDate: 'January 1, 2026',
  event: 'discovered', // 'discovered', 'opened', or 'closing_soon'
  url: 'https://broadwayscorecard.com/show/show-slug'
});
```

## Troubleshooting

### Notifications not appearing

1. **Check webhook URL is correct**: Ensure no extra spaces or characters
2. **Check GitHub secrets**: Verify the secret names match exactly
3. **Check workflow logs**: Look for "Discord notification failed" errors
4. **Test webhook manually**:
   ```bash
   curl -X POST -H "Content-Type: application/json" \
     -d '{"content": "Test message"}' \
     YOUR_WEBHOOK_URL
   ```

### Rate limiting

Discord webhooks have rate limits (~30 messages per minute per webhook). If you're hitting limits:
- Batch notifications where possible
- Add delays between messages
- Use a single message with multiple embeds

### Webhook URL leaked

If your webhook URL is accidentally exposed:
1. Go to Discord channel settings → Integrations → Webhooks
2. Delete the compromised webhook
3. Create a new webhook
4. Update the GitHub secret with the new URL

## Security Notes

- Webhook URLs are secrets - never commit them to the repository
- GitHub secrets are encrypted and only available to workflows
- Webhooks can only send messages, not read channel content
- Each webhook is tied to a specific channel
