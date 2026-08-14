#!/usr/bin/env node

/**
 * Generates a remediation plan for bugs that auto-fix couldn't handle.
 *
 * Called from auto-fix-feedback-bug.yml when outcome is skipped/validation-failed.
 * Uses Claude to create a detailed, human-approved fix plan, saves it to
 * data/pending-fixes/{issue}.json, and emails Tom with Approve/Reject buttons.
 *
 * Env vars:
 *   ISSUE_BODY             - Full GitHub issue body text
 *   ISSUE_NUMBER           - GitHub issue number
 *   FIX_ACTION             - What auto-fix returned (skipped, validation-failed, error)
 *   ANTHROPIC_API_KEY      - Claude API key
 *   RESEND_API_KEY         - For sending email
 *   OWNER_EMAIL            - Tom's email
 *   APPROVAL_HMAC_SECRET   - For signing approval URLs
 */

import { Anthropic } from '@anthropic-ai/sdk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildFixApprovalEmail } = require('./lib/email-templates.js');
const { GPT4O_MINI, CLAUDE_SONNET } = require('./lib/models');
const { detectSystematicIssue } = require('./lib/systematic-fix-detection.js');
const { buildEscalationCard } = require('./lib/plan-refusal-escalation.js');
const { pickEditableFields } = require('./lib/feedback-pipeline-fields.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

// --- Helpers ---

function parseDiagnosis(issueBody) {
  const match = issueBody.match(/<!-- DIAGNOSIS_JSON\n([\s\S]*?)\nDIAGNOSIS_JSON -->/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function loadJsonSafe(relPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
  } catch { return null; }
}

function loadFile(relPath, maxChars = 50000) {
  try {
    const content = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    return content.length > maxChars ? content.slice(0, maxChars) + '\n...[truncated]' : content;
  } catch { return null; }
}

function output(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function generateApprovalUrl(action, issueNumber, secret, planId) {
  // 7-day expiry. planId binds the link to THIS generated plan: a rerun for
  // the same issue overwrites {issue}.json, and without the binding an
  // unexpired link for plan A would silently execute plan B. The executor
  // refuses on planId mismatch.
  const expires = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);
  const token = crypto
    .createHmac('sha256', secret)
    .update(`${action}:${issueNumber}:${expires}:${planId}`)
    .digest('hex');
  return `https://broadwayscorecard.com/api/approve-fix?issue=${issueNumber}&token=${token}&expires=${expires}&action=${action}&plan=${planId}`;
}

async function sendEmail(to, from, subject, html) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log('No RESEND_API_KEY — skipping email'); return; }

  const data = JSON.stringify({ from, to: [to], subject, html });
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('Email sent successfully');
          resolve(body);
        } else {
          console.log(`Email failed: ${res.statusCode} ${body.slice(0, 200)}`);
          reject(new Error(`Email ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Files a self-contained P1 card so the standing P0/P1-auto-dispatch-at-creation
// path (CLAUDE.md §6) picks this up and runs a real fix session — replaces the
// old dead end of just emailing the owner "needs your attention" with nothing
// actionable behind it (task #755). This runner has no cmux/bsc-next available
// (GitHub Actions), so filing the card is the CI-side half of the dispatch;
// notion-tasks-sync.js pull + the Mac-side loop do the rest. Fail-soft: a
// broken Notion call must never crash the workflow — the fallback email still
// fires either way (with different wording depending on whether this worked).
function escalatePlanRefusal({ diagnosis, planReason, issueNumber, issueUrl }) {
  const card = buildEscalationCard({ diagnosis, planReason, issueNumber, issueUrl });
  const scriptsDir = path.join(ROOT, 'scripts');
  try {
    execFileSync('node', [
      path.join(scriptsDir, 'notion-brain.js'), 'create', card.title,
      '--priority', card.priority, '--status', card.status, '--action', card.action,
      '--notes', card.notes, '--park', card.parkReason,
    ], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  } catch (err) {
    console.error('escalatePlanRefusal: notion-brain create failed:', err.message);
    return { filed: false };
  }
  try {
    execFileSync('node', [path.join(scriptsDir, 'notion-tasks-sync.js'), 'pull'],
      { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  } catch (err) {
    // Card is filed either way — a later scheduled sync picks it up. This
    // just shortens the dispatch latency when it works.
    console.error('escalatePlanRefusal: notion-tasks-sync pull failed (card still filed):', err.message);
  }
  console.log(`escalatePlanRefusal: filed P1 card "${card.title}"`);
  return { filed: true, title: card.title };
}

// --- GPT-4o verification ---

async function verifyPlanWithGPT(plan, diagnosis, showContext) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.log('No OPENAI_API_KEY — skipping second-LLM verification');
    return { verified: true, skipped: true };
  }

  const prompt = `You are fact-checking a proposed data fix for Broadway Scorecard. Your ONLY job is to check for factual errors — wrong production years, wrong directors, wrong show IDs, or claims that contradict the show data provided.

## Proposed Fix
**Summary:** ${plan.summary}
**Steps:** ${plan.steps.join('; ')}
**Actions:** ${JSON.stringify(plan.actions, null, 2)}

## Original Diagnosis
${diagnosis.summary}
${diagnosis.whatsHappening}

## Show Data From Our Database
${showContext || '(no show data available)'}

## Instructions
1. Check each action's showId — does it match a real show in the data?
2. Check any production years or revival claims — do they match the show data's openingDate?
3. Check factual claims about directors, cast, venues — do they match creativeTeam data?
4. If the show data doesn't include the claimed show, flag it as UNVERIFIED (not necessarily wrong, just can't confirm)

Respond with ONLY a JSON object:
{
  "passed": true/false,
  "issues": ["Issue 1", "Issue 2"],
  "confidence": "high|medium|low"
}

If everything looks correct, return {"passed": true, "issues": [], "confidence": "high"}.`;

  const data = JSON.stringify({
    model: GPT4O_MINI,
    temperature: 0.1,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve) => {
    const req = https.request('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const text = parsed.choices?.[0]?.message?.content || '';
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            console.log(`GPT-4o verification: ${result.passed ? 'PASSED' : 'FAILED'} (${result.confidence})`);
            if (result.issues?.length > 0) {
              console.log(`  Issues: ${result.issues.join('; ')}`);
            }
            resolve({ verified: result.passed, issues: result.issues || [], confidence: result.confidence });
          } else {
            console.log('GPT-4o verification: could not parse response');
            resolve({ verified: true, skipped: true });
          }
        } catch (err) {
          console.log(`GPT-4o verification error: ${err.message}`);
          resolve({ verified: true, skipped: true });
        }
      });
    });
    req.on('error', (err) => {
      console.log(`GPT-4o verification network error: ${err.message}`);
      resolve({ verified: true, skipped: true });
    });
    req.write(data);
    req.end();
  });
}

// --- Allowed actions for plans ---

// awards.json excluded: executeApprovedFix has no data-edit handler for it.
const EDITABLE_DATA_FIELDS = pickEditableFields([
  'shows.json', 'commercial.json', 'audience-buzz.json',
]);

const ALLOWED_SCRIPTS = [
  'rebuild-all-reviews.js',
  'gather-reviews.js',
  'collect-review-texts.js',
  'generate-critic-consensus.js',
  'validate-data.js',
  'fetch-show-images-auto.js',
];

// --- Show name extraction (mirrors diagnose-feedback-bug.js) ---

function extractShowNamesFromMessage(message) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
    const shows = raw.shows || raw;
    const lower = message.toLowerCase();
    const matched = new Set();
    for (const show of shows) {
      const titleLower = show.title.toLowerCase();
      if (titleLower.length >= 4 && lower.includes(titleLower)) {
        matched.add(show.title);
      }
    }
    return Array.from(matched);
  } catch { return []; }
}

function loadAllShowData(showsArray, title) {
  return showsArray.filter(s => s.title.toLowerCase() === title.toLowerCase());
}

// --- Main ---

async function main() {
  const issueBody = process.env.ISSUE_BODY;
  const issueNumber = process.env.ISSUE_NUMBER;
  const fixAction = process.env.FIX_ACTION || 'skipped';

  if (!issueBody || !issueNumber) {
    console.error('Missing ISSUE_BODY or ISSUE_NUMBER');
    output('plan_created', 'false');
    return;
  }

  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) {
    console.error('No APPROVAL_HMAC_SECRET — cannot generate approval links');
    output('plan_created', 'false');
    return;
  }

  // 1. Parse diagnosis from issue body
  const diagnosis = parseDiagnosis(issueBody);
  if (!diagnosis) {
    console.log('No DIAGNOSIS_JSON found — cannot generate plan');
    output('plan_created', 'false');
    return;
  }

  console.log(`Generating remediation plan for issue #${issueNumber}`);
  console.log(`  Diagnosis: ${diagnosis.summary}`);
  console.log(`  Fix type: ${diagnosis.fixType}, Auto-fix result: ${fixAction}`);

  // 2. Build context for Claude
  const showsData = loadJsonSafe('data/shows.json');
  const shows = showsData?.shows || showsData || [];

  // Find relevant shows — by showId if available, otherwise extract from message text
  let relevantShows = [];
  if (diagnosis.showId) {
    const show = shows.find(s => s.id === diagnosis.showId);
    if (show) relevantShows.push(show);
  }

  // When showId is null, extract show names from the original message
  if (relevantShows.length === 0 && diagnosis.originalMessage) {
    const extractedNames = extractShowNamesFromMessage(diagnosis.originalMessage);
    console.log(`  Extracted show names from message: ${extractedNames.join(', ') || '(none)'}`);
    const seen = new Set();
    for (const name of extractedNames) {
      const matches = loadAllShowData(shows, name);
      for (const m of matches) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          relevantShows.push(m);
        }
      }
    }
    if (relevantShows.length > 0) {
      console.log(`  Found ${relevantShows.length} matching shows: ${relevantShows.map(s => `${s.title} (${s.id})`).join(', ')}`);
    }
  }

  let contextParts = [];

  // Show data for all relevant shows
  const commercial = relevantShows.length > 0 ? loadJsonSafe('data/commercial.json') : null;
  const reviewsData = relevantShows.length > 0 ? loadJsonSafe('data/reviews.json') : null;
  const allReviews = reviewsData?.reviews || reviewsData || [];

  for (const show of relevantShows) {
    const showContext = { ...show };
    contextParts.push(`## Show Data: ${show.title} (${show.id})\n\`\`\`json\n${JSON.stringify(showContext, null, 2)}\n\`\`\``);

    // Commercial data
    const slug = show.slug || show.id;
    if (commercial?.shows?.[slug]) {
      contextParts.push(`## Commercial Data: ${show.title}\n\`\`\`json\n${JSON.stringify(commercial.shows[slug], null, 2)}\n\`\`\``);
    }

    // Reviews summary
    const showReviews = allReviews.filter(r => r.showId === show.id);
    if (showReviews.length > 0) {
      const summary = showReviews.slice(0, 10).map(r => ({
        outlet: r.outlet, critic: r.criticName, score: r.assignedScore, tier: r.tier,
      }));
      contextParts.push(`## Reviews for ${show.title} (${showReviews.length} total, showing first 10)\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``);
    }
  }

  // Relevant source code based on fix type
  if (diagnosis.fixType === 'code' || diagnosis.fixType === 'config') {
    for (const f of (diagnosis.relevantFiles || []).slice(0, 3)) {
      const content = loadFile(f, 30000);
      if (content) contextParts.push(`## ${f}\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  const allowedFieldsList = Object.entries(EDITABLE_DATA_FIELDS)
    .map(([file, fields]) => `  ${file}: ${fields.join(', ')}`)
    .join('\n');

  // 3. Call Claude to generate remediation plan
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are generating a remediation plan for a bug on Broadway Scorecard that couldn't be auto-fixed.

## Bug Diagnosis
**Summary:** ${diagnosis.summary}
**What's happening:** ${diagnosis.whatsHappening}
**Findings:** ${diagnosis.findings?.join('; ') || 'N/A'}
**Proposed fix:** ${diagnosis.proposedFix}
**Fix type:** ${diagnosis.fixType}
**Confidence:** ${diagnosis.confidence}
**Auto-fix result:** ${fixAction}

${contextParts.join('\n\n')}

## What You Can Plan
Your plan will be executed automatically after human approval. You may include these action types:

### 1. data-edit — Change fields in data files
Allowed fields:
${allowedFieldsList}
Each edit must specify: file, showId/slug, field, oldValue, newValue

### 2. run-script — Run a pipeline script
Allowed scripts: ${ALLOWED_SCRIPTS.join(', ')}
Specify: script name, arguments (optional)
IMPORTANT: Do NOT include validate-data.js as an action — validation runs automatically after data edits.

### 3. review-file-op — Move/delete review files in data/review-texts/
Specify: operation (move, delete, rename), source path, destination path

## Rules
- Be SPECIFIC with every action — exact field names, exact values, exact paths
- For data-edits, include the current oldValue so the executor can verify nothing changed
- Keep it minimal — only what's needed to fix the bug
- Assess risk honestly: Low (data-only, easily reversible), Medium (multiple files, review file ops), High (structural changes)
- Write the summary in plain English as if explaining to a friend
- CRITICAL: Only use show IDs and production details that appear in the Show Data above. Do NOT guess production years, revival numbers, or historical facts. If the show data doesn't include specific shows mentioned in the diagnosis, use generic references (e.g., "the Sweeney Todd entry") and set showId to null with a note that the correct show ID needs to be looked up.

Respond with ONLY a JSON object:
{
  "canCreatePlan": true,
  "summary": "Plain English summary of the fix in 1-2 sentences",
  "steps": ["Step 1 in plain English", "Step 2"],
  "riskLevel": "Low|Medium|High",
  "actions": [
    {
      "type": "data-edit",
      "file": "shows.json",
      "showId": "show-id",
      "field": "venue",
      "oldValue": "current value",
      "newValue": "new value",
      "description": "Why this change"
    }
  ]
}

Or if you cannot create an actionable plan:
{ "canCreatePlan": false, "reason": "why" }`;

  let plan;
  try {
    const message = await anthropic.messages.create({
      model: CLAUDE_SONNET,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in Claude response');
    plan = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('Claude API error:', err.message);
    output('plan_created', 'false');
    return;
  }

  if (!plan.canCreatePlan) {
    console.log(`Cannot create plan: ${plan.reason}`);
    output('plan_created', 'false');

    // Task #755 (owner mandate 2026-08-02): a refused plan used to just email
    // the owner "needs your attention" with nothing behind it — homework, not
    // a fix. File a self-contained P1 card instead so the standing dispatch
    // loop picks it up and a real session lands the fix.
    const issueUrl = `https://github.com/thomaspryor/Broadwayscore/issues/${issueNumber}`;
    let escalation = { filed: false };
    try {
      escalation = escalatePlanRefusal({ diagnosis, planReason: plan.reason, issueNumber, issueUrl });
    } catch (err) {
      console.error('escalatePlanRefusal threw:', err.message);
    }

    // Send a status email — its wording depends on whether the card above
    // actually got filed (auto-dispatched) or not (genuine fallback, still
    // needs a human to look).
    const ownerEmail = process.env.OWNER_EMAIL;
    if (ownerEmail) {
      const who = diagnosis.submitterName && diagnosis.submitterName !== 'Anonymous' ? diagnosis.submitterName : 'Someone';
      const showRef = diagnosis.submitterShow ? ` about <strong>${diagnosis.submitterShow}</strong>` : '';

      const banner = escalation.filed
        ? `<p style="margin:0 0 12px;padding:10px 14px;background-color:#dbeafe;border:1px solid #3b82f6;border-radius:6px;color:#1e40af;font-size:14px;">&#129302; <strong>Fix session dispatched</strong> &mdash; auto-fix and the plan generator both couldn't scope this one, so a P1 card was filed and queued for a Claude session to investigate. No action needed.</p>`
        : `<p style="margin:0 0 12px;padding:10px 14px;background-color:#fef3c7;border:1px solid #f59e0b;border-radius:6px;color:#92400e;font-size:14px;">&#9888;&#65039; <strong>Needs your attention</strong> &mdash; auto-fix and plan generator both couldn't handle this one, and filing the auto-dispatch card also failed.</p>`;

      const fallbackHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#333;">
${banner}
<p style="margin:0;">${who} reported a bug${showRef}:</p>
<br>
${diagnosis.originalMessage
  ? `<p style="margin:0;padding-left:16px;border-left:3px solid #ddd;color:#555;font-style:italic;">${diagnosis.originalMessage.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`
  : `<p style="margin:0;color:#999;font-style:italic;">(no message text available)</p>`}
<br>
<p style="margin:0;"><strong>Diagnosis:</strong> ${(diagnosis.summary || 'No summary available').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
<br>
<p style="margin:0;color:#555;"><strong>Why it couldn't be auto-planned:</strong> ${(plan.reason || 'Unknown reason').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
<br>
<table cellpadding="0" cellspacing="0" border="0" style="margin:0;"><tr>
  <td align="center" bgcolor="#3b82f6" style="border-radius:6px;padding:0;"><a href="${issueUrl}" style="display:block;padding:12px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">View Issue on GitHub</a></td>
</tr></table>
<br>
<p style="margin:0;color:#999;font-size:13px;">Issue: <a href="${issueUrl}" style="color:#999;">#${issueNumber}</a></p>
</body></html>`;

      const fallbackSubject = diagnosis.submitterShow
        ? `${escalation.filed ? 'Fix dispatched' : 'Manual Fix Needed'}: ${diagnosis.submitterShow} (#${issueNumber})`
        : `${escalation.filed ? 'Fix dispatched' : 'Manual Fix Needed'} (#${issueNumber})`;

      try {
        await sendEmail(
          ownerEmail,
          'Tom at Broadway Scorecard <updates@broadwayscorecard.com>',
          fallbackSubject,
          fallbackHtml
        );
        console.log(`Status email sent to ${ownerEmail}`);
      } catch (err) {
        console.error('Failed to send status email:', err.message);
      }
    } else {
      console.log('No OWNER_EMAIL set — skipping status email');
    }

    return;
  }

  // 3b. Verify plan with GPT-4o (second-LLM fact-check)
  const showContextForVerification = contextParts.filter(p => p.startsWith('## Show Data')).join('\n\n');
  const verification = await verifyPlanWithGPT(plan, diagnosis, showContextForVerification);

  // 4. Save plan to data/pending-fixes/
  const planFile = path.join(ROOT, 'data/pending-fixes', `${issueNumber}.json`);
  const planId = crypto.randomUUID();
  const planData = {
    issueNumber: parseInt(issueNumber),
    planId,
    status: 'pending',
    createdAt: new Date().toISOString(),
    // diagnosis.summary/whatsHappening are LLM paraphrases that routinely
    // quote the reporter verbatim — they stay OUT of this PUBLIC-repo file
    // (they live in the GitHub issue and the approval email).
    diagnosis: {
      fixType: diagnosis.fixType,
      confidence: diagnosis.confidence,
      showId: diagnosis.showId,
      showSlug: diagnosis.showSlug,
    },
    // PII stays OUT of the persisted plan file — data/pending-fixes/ is
    // committed to the PUBLIC repo (it was gitignored 2026-03-08 for exactly
    // this reason, which silently broke plan persistence: every approval email
    // since then pointed at a plan file that was never committed, so the
    // Approve button dispatched an executor that found nothing). Name, email
    // and message are ALL redacted; the executor re-derives them from the
    // GitHub issue's DIAGNOSIS_JSON at execute time for the thank-you email.
    // They live only in the approval email itself (built from the in-memory
    // diagnosis below).
    submitter: {
      name: null,
      email: null,
      show: diagnosis.submitterShow || null,
      message: '',
    },
    plan: {
      summary: plan.summary,
      steps: plan.steps,
      riskLevel: plan.riskLevel,
      actions: plan.actions,
    },
    verification: {
      passed: verification.verified,
      skipped: verification.skipped || false,
      issues: verification.issues || [],
      confidence: verification.confidence || null,
    },
  };

  fs.writeFileSync(planFile, JSON.stringify(planData, null, 2) + '\n');
  console.log(`Plan saved to ${planFile}`);

  // 5. Build "current state" context for the email so the recipient can verify
  const currentState = [];
  for (const action of (plan.actions || [])) {
    if (action.type === 'data-edit' && action.showId) {
      const targetShow = shows.find(s => s.id === action.showId);
      if (targetShow) {
        const currentValue = action.field === 'creativeTeam'
          ? (targetShow.creativeTeam || []).map(ct => `${ct.name} (${ct.role})`).join(', ') || 'empty'
          : targetShow[action.field] != null ? String(targetShow[action.field]) : 'not set';
        currentState.push({
          showTitle: targetShow.title,
          showId: targetShow.id,
          field: action.field,
          currentValue,
          proposedChange: action.description || JSON.stringify(action.newValue),
          ibdbUrl: `https://www.ibdb.com/broadway-production/${targetShow.slug || targetShow.id}`,
        });
      }
    }
  }

  // 6. Generate HMAC-signed approval URLs (bound to this plan's planId)
  const approveUrl = generateApprovalUrl('approve', issueNumber, secret, planId);
  const rejectUrl = generateApprovalUrl('reject', issueNumber, secret, planId);

  // 7. Send approval email
  const ownerEmail = process.env.OWNER_EMAIL;
  if (ownerEmail) {
    const { subject, html } = buildFixApprovalEmail({
      // From the in-memory diagnosis, NOT planData.submitter — the persisted
      // plan is PII-redacted but the email to the owner keeps the full text.
      submitterName: diagnosis.submitterName || 'Anonymous',
      showTitle: diagnosis.submitterShow || null,
      originalMessage: diagnosis.originalMessage || '',
      planSummary: plan.summary,
      planSteps: plan.steps,
      riskLevel: plan.riskLevel,
      currentState,
      verification,
      approveUrl,
      rejectUrl,
      issueNumber: parseInt(issueNumber),
    });

    try {
      await sendEmail(
        ownerEmail,
        'Tom at Broadway Scorecard <updates@broadwayscorecard.com>',
        subject,
        html
      );
      console.log(`Approval email sent to ${ownerEmail}`);
    } catch (err) {
      console.error('Failed to send approval email:', err.message);
    }
  } else {
    console.log('No OWNER_EMAIL set — skipping email');
  }

  output('plan_created', 'true');
  console.log('Remediation plan generated successfully');

  // 8. Systematic issue detection — scan for similar patterns across the dataset
  try {
    const systematic = detectSystematicIssue(plan, shows);
    if (systematic && systematic.totalMatches > 0) {
      console.log(`\nSystematic issue detected: ${systematic.totalMatches} similar entries across ${systematic.showCount} shows`);

      // Save systematic plan (its own planId — approving the spot plan must
      // not be able to execute the systematic one, or vice versa)
      const sysPlanId = `${issueNumber}-systematic`;
      const sysPlanUuid = crypto.randomUUID();
      const sysPlanFile = path.join(ROOT, 'data/pending-fixes', `${sysPlanId}.json`);
      const sysPlanData = {
        issueNumber: sysPlanId,
        planId: sysPlanUuid,
        parentIssue: parseInt(issueNumber),
        status: 'pending',
        createdAt: new Date().toISOString(),
        isSystematic: true,
        diagnosis: {
          summary: `Systematic: ${systematic.summary}`,
          whatsHappening: systematic.description,
          fixType: 'data',
          confidence: 'high',
          showId: null,
          showSlug: null,
        },
        submitter: planData.submitter,
        plan: {
          summary: systematic.summary,
          steps: systematic.steps,
          riskLevel: systematic.riskLevel,
          actions: systematic.actions,
        },
        verification: { passed: true, skipped: true, issues: [], confidence: null },
      };

      fs.writeFileSync(sysPlanFile, JSON.stringify(sysPlanData, null, 2) + '\n');
      console.log(`Systematic plan saved to ${sysPlanFile}`);

      // Send separate systematic email
      if (ownerEmail) {
        const sysApproveUrl = generateApprovalUrl('approve', sysPlanId, secret, sysPlanUuid);
        const sysRejectUrl = generateApprovalUrl('reject', sysPlanId, secret, sysPlanUuid);

        const { subject: sysSubject, html: sysHtml } = buildFixApprovalEmail({
          submitterName: 'System (auto-detected)',
          showTitle: `Systematic issue from #${issueNumber}`,
          originalMessage: `While fixing the spot issue (${plan.summary}), we detected the same pattern in ${systematic.totalMatches} additional entries across ${systematic.showCount} shows. This is a separate approval — the spot fix above can be approved independently.`,
          planSummary: systematic.summary,
          planSteps: systematic.steps,
          riskLevel: systematic.riskLevel,
          currentState: systematic.sampleEntries || [],
          verification: { verified: true, skipped: true },
          approveUrl: sysApproveUrl,
          rejectUrl: sysRejectUrl,
          issueNumber: parseInt(issueNumber),
        });

        try {
          await sendEmail(
            ownerEmail,
            'Tom at Broadway Scorecard <updates@broadwayscorecard.com>',
            `Systematic Fix: ${systematic.summary.slice(0, 60)} (#${issueNumber})`,
            sysHtml
          );
          console.log('Systematic approval email sent');
        } catch (err) {
          console.error('Failed to send systematic email:', err.message);
        }
      }
    } else {
      console.log('\nNo systematic issue detected');
    }
  } catch (err) {
    console.error('Systematic detection failed (non-fatal):', err.message);
  }
}

// Systematic issue detection lives in scripts/lib/systematic-fix-detection.js
// (extracted 2026-07-31 with tests, after the inline version's same-value
// generalization proposed closing all 147 open shows from one status flip).

main().catch(err => {
  console.error('Fatal error:', err);
  output('plan_created', 'false');
});
