#!/usr/bin/env node

/**
 * Fetches feedback submissions from Formspree, categorizes them using AI,
 * sends thank-you emails for non-bug feedback, and creates summaries.
 *
 * Runs daily. Uses dedup tracking to avoid re-processing submissions.
 */

import { Anthropic } from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { diagnoseBug } from './diagnose-feedback-bug.js';

const require = createRequire(import.meta.url);
const { buildFeedbackThankYouEmail, postJSON } = require('./lib/email-templates.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TRACKING_FILE = path.join(__dirname, '../data/audit/processed-feedback.json');
const MAX_SUBMISSIONS_PER_RUN = 20; // Spam cap
const MAX_DIAGNOSES = 5;

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Load dedup tracking data
 */
function loadTracking() {
  try {
    return JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8'));
  } catch {
    return { processedIds: [], lastChecked: null };
  }
}

/**
 * Save dedup tracking data (keep last 500 IDs)
 */
function saveTracking(data) {
  data.lastChecked = new Date().toISOString();
  if (data.processedIds.length > 500) {
    data.processedIds = data.processedIds.slice(-500);
  }
  fs.mkdirSync(path.dirname(TRACKING_FILE), { recursive: true });
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Fetch submissions from Formspree (last 48 hours with overlap for safety).
 * Pulls both the main inbox and the Formshield spam folder — Formshield
 * false-flags legit submissions (partnership pitches, URLs, phone numbers),
 * and if we only read the inbox, real messages are silently lost.
 * Spam-flagged rows are tagged with `_isSpam: true` for downstream handling.
 */
async function fetchFormspreeSubmissions() {
  const token = process.env.FORMSPREE_TOKEN;

  if (!token) {
    console.log('FORMSPREE_TOKEN not set. Skipping fetch.');
    return [];
  }

  const since = new Date();
  since.setHours(since.getHours() - 48);
  const sinceParam = since.toISOString();

  async function fetchBucket(isSpam) {
    const qs = `since=${sinceParam}${isSpam ? '&spam=true' : ''}`;
    try {
      const response = await fetch(
        `https://formspree.io/api/0/forms/mojdjwqo/submissions?${qs}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        console.error(`Formspree ${isSpam ? 'spam' : 'inbox'} API error: ${response.status} ${response.statusText}`);
        return [];
      }

      const data = await response.json();
      return (data.submissions || []).map(s => ({ ...s, _isSpam: isSpam }));
    } catch (error) {
      console.error(`Error fetching Formspree ${isSpam ? 'spam' : 'inbox'}:`, error.message);
      return [];
    }
  }

  const [inbox, spam] = await Promise.all([fetchBucket(false), fetchBucket(true)]);
  if (spam.length > 0) {
    console.log(`Pulled ${spam.length} spam-flagged submission(s) from Formshield — will surface for manual review.`);
  }
  return [...inbox, ...spam];
}

/**
 * Filter out already-processed and spam submissions
 */
function filterSubmissions(submissions, tracking) {
  const processedSet = new Set(tracking.processedIds);

  return submissions.filter(sub => {
    const id = sub._id || sub.id || sub.createdAt;

    // Already processed
    if (processedSet.has(id)) return false;

    // Honeypot triggered (spam)
    if (sub._gotcha) {
      console.log(`  Skipping spam (honeypot): ${id}`);
      return false;
    }

    // No message = not useful
    if (!sub.message || sub.message.trim().length === 0) {
      console.log(`  Skipping empty message: ${id}`);
      return false;
    }

    return true;
  });
}

/**
 * Categorize feedback using Claude API
 */
async function categorizeFeedback(submissions) {
  if (submissions.length === 0) return [];

  const submissionsText = submissions.map((sub, idx) => {
    return `
SUBMISSION ${idx + 1}:
- Category (user-selected): ${sub.category || 'Not specified'}
- Name: ${sub.name || 'Anonymous'}
- Email: ${sub.email || 'Not provided'}
- Show: ${sub.show || 'N/A'}
- Message: ${sub.message}
- Submitted: ${new Date(sub.createdAt).toLocaleDateString()}
`;
  }).join('\n---\n');

  const prompt = `You are analyzing user feedback submissions for Broadway Scorecard, a website that aggregates Broadway show reviews and ratings.

Categorize each submission and provide:
1. **Category** (Bug, Feature Request, Content Error, Praise, Other)
2. **Priority** (High, Medium, Low)
3. **Summary** (1-2 sentences)
4. **Recommended Action** (brief suggestion)

SUBMISSIONS:
${submissionsText}

Respond in this JSON format:
{
  "categorized": [
    {
      "submissionNumber": 1,
      "category": "Bug|Feature Request|Content Error|Praise|Other",
      "priority": "High|Medium|Low",
      "summary": "Brief summary of the feedback",
      "recommendedAction": "What should be done about this",
      "userCategory": "What the user selected"
    }
  ]
}`;

  console.log('Categorizing feedback with Claude API...\n');

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  const responseText = message.content[0].text;
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse Claude response as JSON');
  }

  const result = JSON.parse(jsonMatch[0]);
  return result.categorized || [];
}

/**
 * Send thank-you email via Resend for non-bug feedback
 */
async function sendThankYouEmail(email, name, category, showName) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey || !email) return false;

  // Map AI category to email type
  const typeMap = {
    'Praise': 'praise',
    'Feature Request': 'feature',
    'Other': 'acknowledged',
  };
  const emailType = typeMap[category] || 'acknowledged';

  const { subject, html } = buildFeedbackThankYouEmail(emailType, name, showName);

  try {
    await postJSON('https://api.resend.com/emails', {
      from: 'Tom at Broadway Scorecard <updates@broadwayscorecard.com>',
      to: [email],
      subject,
      html,
    }, {
      'Authorization': `Bearer ${resendKey}`,
    });
    console.log(`  Sent ${emailType} thank-you to ${email}`);
    return true;
  } catch (err) {
    console.error(`  Failed to send email to ${email}: ${err.message}`);
    return false;
  }
}

/**
 * Generate markdown summary
 */
function generateSummary(submissions, categorized, bugDiagnoses = [], spamFlagged = []) {
  if (submissions.length === 0 && spamFlagged.length === 0) return '';

  const summary = [];

  summary.push('# Feedback Digest');
  summary.push('');
  summary.push(`**Period**: ${new Date().toLocaleDateString()}`);
  summary.push(`**Inbox Submissions**: ${submissions.length}`);
  if (spamFlagged.length > 0) {
    summary.push(`**Spam-Flagged (needs human review)**: ${spamFlagged.length}`);
  }
  summary.push('');
  summary.push('---');
  summary.push('');

  // Spam-flagged submissions — rendered verbatim at the top so Tom can
  // decide whether to rescue + "Not Spam" them in Formspree, or ignore.
  // These bypass AI categorization/emails/diagnosis intentionally.
  if (spamFlagged.length > 0) {
    summary.push('## ⚠️ Needs Review — Spam-Flagged by Formshield');
    summary.push('');
    summary.push('_Formshield flagged these as spam. Real partnership pitches, follow-ups, and messages containing URLs or phone numbers are routinely false-flagged. Open each in the Formspree **Spam** tab and click "Not Spam" to rescue + train the filter._');
    summary.push('');
    spamFlagged.forEach((sub) => {
      summary.push(`### ${sub.name || 'Anonymous'}${sub.email ? ` — ${sub.email}` : ''}`);
      summary.push('');
      summary.push(`- **Category**: ${sub.category || 'n/a'}`);
      if (sub.show) summary.push(`- **Show**: ${sub.show}`);
      summary.push(`- **Submitted**: ${sub._date || sub.createdAt || 'unknown'}`);
      summary.push(`- **Message**: ${sub.message || '(empty)'}`);
      summary.push('');
    });
    summary.push('---');
    summary.push('');
  }

  if (submissions.length === 0) {
    summary.push('*No new inbox submissions this period.*');
    return summary.join('\n');
  }

  // Group by category
  const byCategory = {
    'Bug': [], 'Feature Request': [], 'Content Error': [],
    'Praise': [], 'Other': []
  };

  categorized.forEach((cat, idx) => {
    const submission = submissions[idx];
    if (!byCategory[cat.category]) byCategory[cat.category] = [];
    byCategory[cat.category].push({ ...cat, submission });
  });

  // High priority items first
  const highPriority = categorized.filter(c => c.priority === 'High');
  if (highPriority.length > 0) {
    summary.push('## High Priority Items');
    summary.push('');
    highPriority.forEach((item) => {
      const sub = submissions[item.submissionNumber - 1];
      summary.push(`### ${item.category}: ${item.summary}`);
      summary.push('');
      summary.push(`**From**: ${sub.name || 'Anonymous'} ${sub.email ? `(${sub.email})` : ''}`);
      if (sub.show) summary.push(`**Show**: ${sub.show}`);
      summary.push(`**Message**: ${sub.message}`);
      summary.push('');
      summary.push(`**Recommended Action**: ${item.recommendedAction}`);
      summary.push('');
      summary.push('---');
      summary.push('');
    });
  }

  // All items by category
  summary.push('## All Submissions by Category');
  summary.push('');

  Object.entries(byCategory).forEach(([category, items]) => {
    if (items.length === 0) return;

    summary.push(`### ${category} (${items.length})`);
    summary.push('');

    items.forEach((item) => {
      const sub = item.submission;
      summary.push(`**${item.priority} Priority**: ${item.summary}`);
      summary.push('');
      summary.push(`- **From**: ${sub.name || 'Anonymous'} ${sub.email ? `(${sub.email})` : ''}`);
      if (sub.show) summary.push(`- **Show**: ${sub.show}`);
      summary.push(`- **Message**: ${sub.message}`);
      summary.push(`- **Action**: ${item.recommendedAction}`);

      const diag = bugDiagnoses.find(d => d.item.submissionNumber === item.submissionNumber && d.diagnosis);
      if (diag) {
        summary.push(`- **Diagnosis**: ${diag.diagnosis.summary} (${diag.diagnosis.confidence} confidence) — see separate bug-diagnosis issue`);
      }

      summary.push('');
    });

    summary.push('');
  });

  summary.push('---');
  summary.push('');
  summary.push('*Categorized by automated system*');

  return summary.join('\n');
}

/**
 * Main execution
 */
async function main() {
  console.log('Fetching feedback submissions...\n');

  try {
    // Load dedup tracking
    const tracking = loadTracking();

    const allSubmissions = await fetchFormspreeSubmissions();
    console.log(`Fetched ${allSubmissions.length} submissions from Formspree\n`);

    // Filter out already-processed and spam
    const newFiltered = filterSubmissions(allSubmissions, tracking);

    // Split spam-flagged from the main pipeline. Spam-flagged items bypass
    // AI categorization, thank-you emails, and auto-diagnosis — they land
    // in a dedicated "Needs Review" section in the digest for human triage.
    const spamFlagged = newFiltered.filter(s => s._isSpam);
    const newSubmissions = newFiltered.filter(s => !s._isSpam);
    console.log(`${newSubmissions.length} new inbox submission(s), ${spamFlagged.length} spam-flagged\n`);

    // Output for workflow to know if there are submissions (either kind)
    if (process.env.GITHUB_OUTPUT) {
      const has = (newSubmissions.length + spamFlagged.length) > 0;
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_submissions=${has}\n`);
      // The Feedback Digest GitHub issue is pure noise for routine feedback
      // (bugs become their own deduped bug-diagnosis issues; praise/features
      // get submitter thank-yous). The ONLY genuinely owner-actionable digest
      // case is a Formshield spam-flagged item needing a manual "Not Spam"
      // rescue — so the workflow gates the digest issue on this.
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_spam_flagged=${spamFlagged.length > 0}\n`);
    }

    if (newSubmissions.length === 0 && spamFlagged.length === 0) {
      console.log('No new submissions. Exiting.');
      saveTracking(tracking);
      return;
    }

    // Spam cap
    const submissions = newSubmissions.slice(0, MAX_SUBMISSIONS_PER_RUN);
    if (newSubmissions.length > MAX_SUBMISSIONS_PER_RUN) {
      console.log(`WARNING: ${newSubmissions.length} submissions exceed cap of ${MAX_SUBMISSIONS_PER_RUN}. Processing first ${MAX_SUBMISSIONS_PER_RUN} only.`);
    }

    // Categorize (inbox only — spam-flagged go straight to digest for manual review)
    const categorized = submissions.length > 0 ? await categorizeFeedback(submissions) : [];
    if (submissions.length > 0) console.log('Categorization complete\n');

    // Send thank-you emails for non-bug categories
    let emailsSent = 0;
    for (let i = 0; i < categorized.length; i++) {
      const cat = categorized[i];
      const sub = submissions[i];

      // Bug/Content Error emails are sent after resolution, not now
      if (cat.category === 'Bug' || cat.category === 'Content Error') continue;

      if (sub.email) {
        const sent = await sendThankYouEmail(sub.email, sub.name, cat.category, sub.show);
        if (sent) emailsSent++;
      }
    }
    if (emailsSent > 0) {
      console.log(`Sent ${emailsSent} thank-you email(s)\n`);
    }

    // Diagnose bugs and content errors (max 5)
    const bugDiagnoses = [];

    for (const item of categorized) {
      if (bugDiagnoses.length >= MAX_DIAGNOSES) break;
      if (item.category !== 'Bug' && item.category !== 'Content Error') continue;

      const sub = submissions[item.submissionNumber - 1];
      if (!sub) continue;

      console.log(`Diagnosing: ${item.summary}`);
      try {
        const diagnosis = await diagnoseBug(sub.message, sub.show || null, sub.category || null);
        bugDiagnoses.push({ item, submission: sub, diagnosis });
        console.log(`  ${diagnosis.confidence} confidence: ${diagnosis.summary}`);
      } catch (err) {
        console.error(`  Diagnosis failed: ${err.message}`);
        bugDiagnoses.push({ item, submission: sub, diagnosis: null });
      }
    }

    if (bugDiagnoses.length > 0) {
      console.log(`\nDiagnosed ${bugDiagnoses.filter(d => d.diagnosis).length}/${bugDiagnoses.length} bugs\n`);
    }

    // Write diagnoses for workflow to create separate issues
    const diagnosesPath = path.join(__dirname, '../.bug-diagnoses.json');
    fs.writeFileSync(diagnosesPath, JSON.stringify(bugDiagnoses, null, 2));

    const summary = generateSummary(submissions, categorized, bugDiagnoses, spamFlagged);

    if (summary) {
      console.log('=== SUMMARY ===');
      console.log(summary);
      console.log('===============\n');
    }

    // Write summary to file for GitHub Actions
    const summaryPath = path.join(__dirname, '../.feedback-summary.md');
    fs.writeFileSync(summaryPath, summary || '');

    // Mark all processed submissions (inbox + spam-flagged) in tracking
    // so we don't re-surface the same spam-flagged items every run.
    for (const sub of [...submissions, ...spamFlagged]) {
      const id = sub._id || sub.id || sub.createdAt || sub._date;
      if (id && !tracking.processedIds.includes(id)) {
        tracking.processedIds.push(id);
      }
    }
    saveTracking(tracking);

    console.log(`Tracking updated (${tracking.processedIds.length} total IDs)`);

  } catch (error) {
    console.error('Error processing feedback:', error);
    process.exit(1);
  }
}

main();
