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
const { CLAUDE_SONNET } = require('./lib/models');
const { loadPendingDiagnoses, mergePendingDiagnoses } = require('./lib/pending-diagnoses.js');
const { buildCategorizationPrompt, parseCategorizedResponse } = require('./lib/feedback-categorize.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TRACKING_FILE = path.join(__dirname, '../data/audit/processed-feedback.json');
// Diagnoses awaiting GitHub-issue creation. Committed (not ephemeral) because a
// run can be cancelled between diagnosing and issue creation — the submission is
// already marked processed by then, so an uncommitted diagnosis is silently lost
// (Erik Andersen's homepage-filter bug, run 28876301784, 2026-07-07). The
// workflow drains this file after creating issues.
const PENDING_DIAGNOSES_FILE = path.join(__dirname, '../data/audit/pending-bug-diagnoses.json');
const MAX_SUBMISSIONS_PER_RUN = 20; // Spam cap
const MAX_DIAGNOSES = 5;

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Resolve a stable dedup identifier for a Formspree submission.
 *
 * SINGLE SOURCE OF TRUTH — both the de-dup filter and the tracking-save loop
 * MUST use this. They previously diverged: the filter read `_id||id||createdAt`
 * while the save read `_id||id||createdAt||_date`. The Formspree submissions API
 * returns NEITHER `_id`/`id`/`createdAt` — the identifier field is `_date`
 * (an ISO timestamp). So the filter computed `undefined` and never matched,
 * re-sending the thank-you email every run (Louise Penn got 15+ identical
 * "Re: your feedback" emails over ~17h, 2026-06-10/11). Keeping the fallbacks
 * for `_id`/`id`/`createdAt` is harmless future-proofing if the API changes.
 */
function submissionId(sub) {
  return sub._id || sub.id || sub.createdAt || sub._date;
}

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
    const id = submissionId(sub);

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

  const prompt = buildCategorizationPrompt(submissions);

  console.log('Categorizing feedback with Claude API...\n');

  const message = await anthropic.messages.create({
    model: CLAUDE_SONNET,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  return parseCategorizedResponse(message.content[0].text);
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
    'Content Request': 'content',
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

    // Leftover diagnoses from a cancelled run still need their issues created —
    // surface them to the workflow even when there's nothing new to process.
    const pendingDiagnoses = loadPendingDiagnoses(PENDING_DIAGNOSES_FILE);
    if (process.env.GITHUB_OUTPUT) {
      // Undiagnosed (diagnosis:null) leftovers count too — the workflow now
      // creates a needs-review fallback issue for them instead of dropping.
      const hasPending = pendingDiagnoses.some(d => d && d.submission && d.item);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_pending_diagnoses=${hasPending}\n`);
      if (hasPending) console.log(`${pendingDiagnoses.length} pending diagnosis(es) from a previous run awaiting issue creation`);
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

    // Send thank-you emails for non-bug categories. Pair via submissionNumber,
    // not array position — the model can reorder or omit rows, and a positional
    // pairing would send user A's acknowledgement to user B.
    let emailsSent = 0;
    for (const cat of categorized) {
      const sub = submissions[cat.submissionNumber - 1];
      if (!sub) continue;

      // Bug/Content Error emails are sent after resolution, not now — except
      // content-addition requests, which bypass diagnosis/auto-fix entirely
      // and would otherwise never get any acknowledgement.
      if ((cat.category === 'Bug' || cat.category === 'Content Error') && !cat.contentRequest) continue;

      if (sub.email) {
        const emailCategory = cat.contentRequest ? 'Content Request' : cat.category;
        const sent = await sendThankYouEmail(sub.email, sub.name, emailCategory, sub.show);
        if (sent) emailsSent++;
      }
    }
    if (emailsSent > 0) {
      console.log(`Sent ${emailsSent} thank-you email(s)\n`);
    }

    // Diagnose bugs and content errors. MAX_DIAGNOSES caps LLM diagnosis
    // attempts only — content requests cost no LLM call and must not consume
    // the budget (five "add my show" rows would otherwise starve every real
    // bug in the batch into silent oblivion).
    const bugDiagnoses = [];
    let diagnosisAttempts = 0;

    for (const item of categorized) {
      if (item.category !== 'Bug' && item.category !== 'Content Error') continue;

      const sub = submissions[item.submissionNumber - 1];
      if (!sub) continue;

      if (item.contentRequest) {
        // Content-addition requests aren't code bugs — diagnoseBug would
        // hallucinate file-level diagnoses. A null diagnosis routes them to
        // the workflow's needs-review issue path so the request still reaches
        // the maintainer without burning an LLM call or an auto-fix dispatch.
        console.log(`Content request (no diagnosis): ${item.summary}`);
        bugDiagnoses.push({ item, submission: sub, diagnosis: null });
        continue;
      }

      if (diagnosisAttempts >= MAX_DIAGNOSES) continue;
      diagnosisAttempts++;

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

    // Write diagnoses for workflow to create separate issues. Merge with any
    // leftovers from a cancelled run (deduped by submission ID) so nothing is
    // dropped; the workflow's issue-creation step drains this file.
    const merged = mergePendingDiagnoses(pendingDiagnoses, bugDiagnoses, submissionId);
    fs.writeFileSync(PENDING_DIAGNOSES_FILE, JSON.stringify(merged, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT && merged.some(d => d && d.submission && d.item)) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_pending_diagnoses=true\n`);
    }

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
      const id = submissionId(sub);
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
