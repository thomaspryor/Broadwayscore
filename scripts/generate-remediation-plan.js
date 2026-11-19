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

import './lib/llm-usage-install.js'; // LLM spend meter: keep it the first import (BRO-5043)
import { Anthropic } from '@anthropic-ai/sdk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
if (require('./lib/cli-help').hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/generate-remediation-plan.js (driven by ISSUE_BODY, ISSUE_NUMBER, FIX_ACTION env vars; see the header comment)');
  process.exit(0);
}
const { buildFixApprovalEmail, formatFieldValue } = require('./lib/email-templates.js');
const { GPT54_MINI, CLAUDE_SONNET } = require('./lib/models');
const { buildVerifierPrompt } = require('./lib/remediation-verifier');
const { detectSystematicIssue } = require('./lib/systematic-fix-detection.js');
const { pickEditableFields } = require('./lib/feedback-pipeline-fields.js');
const { generateApprovalUrl } = require('./lib/approval-link.js');
const { buildEntry, mergeEntries } = require('./lib/feedback-request-ledger.js');
const { loadIssueDiagnosis, loadStore } = require('./lib/feedback-submitter-store.js');
const Proposal = require('./lib/feedback-proposal.js');
const { sendOwnerThreadEmail, threadSubject } = require('./lib/owner-email-thread.js');
const { showLinkFor } = require('./draft-fixed-replies.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

// --- Helpers ---

// DIAGNOSIS_JSON plus the reader's name, email and message from the private
// store (BRO-4453: new issues no longer carry them; old ones still do).
function parseDiagnosis(issueBody) {
  return loadIssueDiagnosis(issueBody);
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
    req.setTimeout(60000, () => req.destroy(new Error('request timed out after 60s idle')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const LEDGER_PATH = path.join(ROOT, 'data/audit/feedback-request-ledger.json');

/**
 * Track a "Manual Fix Needed" content-error ask the same way missing-show/
 * missing-reviews requests already are (task #1440, 2026-08-13 feedback-form
 * audit): so scripts/verify-feedback-requests-live.js can confirm it actually
 * shipped instead of the fix silently never landing after the GitHub issue
 * closes. Only wired for the one content-error shape the diagnosis already
 * extracts structured facts for (see diagnose-feedback-bug.js's awards
 * instructions) — ceremony/category/missingPerson are real data here, not a
 * guess reconstructed from prose, which is the bar the other content-error
 * shapes (wrong critic name, outlet rename, single missing review, rebuilt
 * show record) don't clear yet without their own prompt-side extraction.
 * Fail-soft: a broken ledger write must never crash plan generation.
 */
function maybeTrackContentFix(diagnosis, issueNumber) {
  if (diagnosis.fixType !== 'data') return false;
  if (!diagnosis.showId || !diagnosis.ceremony || !diagnosis.category || !diagnosis.missingPerson) {
    return false;
  }
  try {
    const raw = fs.existsSync(LEDGER_PATH) ? JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')) : { entries: [] };
    const entry = buildEntry(
      {
        kind: 'content-fix',
        contentErrorType: 'wrong-award-co-winner',
        showId: diagnosis.showId,
        showTitle: diagnosis.submitterShow,
        expected: { ceremony: diagnosis.ceremony, category: diagnosis.category, person: diagnosis.missingPerson },
      },
      {
        submissionId: `issue-${issueNumber}`,
        issueNumber: Number(issueNumber) || null,
        requestedAt: new Date().toISOString(),
        message: diagnosis.originalMessage,
        show: diagnosis.submitterShow,
      }
    );
    const { ledger, added } = mergeEntries(raw, [entry]);
    if (added === 0) return false;
    fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n');
    console.log(`Tracked content-error ask in the request ledger: ${entry.key}`);
    return true;
  } catch (err) {
    console.error('maybeTrackContentFix: failed to update ledger (non-fatal):', err.message);
    return false;
  }
}

// --- Plan verification ---

async function verifyPlanWithGPT(plan, diagnosis, showContext) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.log('No OPENAI_API_KEY — skipping second-LLM verification');
    return { verified: true, skipped: true };
  }

  const prompt = buildVerifierPrompt(plan, diagnosis, showContext);

  const data = JSON.stringify({
    model: GPT54_MINI, // BRO-7608: gpt-4o-mini anchored on stored values (0/5 on a correct director fix); 5.4-mini 5/5, wrong-production control still fails 5/5
    reasoning_effort: 'none', // same profile as llm-batch.js OPENAI_REQUEST_PROFILES: reasoning must not eat the cap
    max_completion_tokens: 3000, // reasoning model: no temperature, tokens include reasoning
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
          if (!text) console.log(`Plan verification: empty response (finish_reason=${parsed.choices?.[0]?.finish_reason}, error=${parsed.error?.message})`);
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            console.log(`Plan verification: ${result.passed ? 'PASSED' : 'FAILED'} (${result.confidence})`);
            if (result.issues?.length > 0) {
              console.log(`  Issues: ${result.issues.join('; ')}`);
            }
            resolve({ verified: result.passed, issues: result.issues || [], confidence: result.confidence });
          } else {
            console.log('Plan verification: could not parse response');
            resolve({ verified: true, skipped: true });
          }
        } catch (err) {
          console.log(`Plan verification error: ${err.message}`);
          resolve({ verified: true, skipped: true });
        }
      });
    });
    req.setTimeout(300000, () => req.destroy(new Error('request timed out after 300s idle')));
    req.on('error', (err) => {
      console.log(`Plan verification network error: ${err.message}`);
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

// The narrower set offered to the planner LLM. Each must also be in the
// executor's allowlist, or the generated plan is refused at apply time (BRO-6742).
const { ALLOWED_SCRIPTS: EXECUTOR_ALLOWED_SCRIPTS } = require('./lib/run-script-allowlist');
const ALLOWED_SCRIPTS = [
  'rebuild-all-reviews.js',
  'gather-reviews.js',
  'collect-review-texts.js',
  'generate-critic-consensus.js',
  'validate-data.js',
  'fetch-show-images-auto.js',
].filter((name) => EXECUTOR_ALLOWED_SCRIPTS.includes(name));

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
  // Needs-review issues carry no DIAGNOSIS_JSON (BRO-7847): build a
  // diagnosis-shaped object from the submission id and the private store so
  // they get a proposal email too.
  const diagnosis = parseDiagnosis(issueBody) || Proposal.buildNeedsReviewDiagnosis(issueBody, loadStore(process.env.FEEDBACK_SUBMITTERS_PATH || undefined));
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

  // --- Proposal email (BRO-7847): owner only, one per issue, capped, kill switch ---
  const ownerEmail = process.env.OWNER_EMAIL;
  const proposalLedger = Proposal.loadLedger();
  const proposalOn = !!ownerEmail && !Proposal.proposalsDisabled() && Proposal.decideSend(proposalLedger, issueNumber).send;
  const submittedAt = diagnosis.submittedAt || diagnosis.submissionId || null;

  async function sendProposal({ alreadyFixed, fixedEvidence, catalogMatches, plan: p, approveUrl, rejectUrl, rootCause }) {
    const reader = { name: diagnosis.submitterName, email: diagnosis.submitterEmail, show: diagnosis.submitterShow, message: diagnosis.originalMessage };
    const url = (catalogMatches && catalogMatches[0] && catalogMatches[0].url) || showLinkFor(reader.show, shows);
    const reply = Proposal.buildReaderReplyDraft({ reader, show: reader.show, url });
    const scan = p ? Proposal.scanSimilar(p, shows) : { ran: false, findings: [] };
    const { html, text } = Proposal.buildProposalEmail({
      issueNumber, reader, alreadyFixed, fixedEvidence, catalogMatches, plan: p, approveUrl, rejectUrl,
      rootCause, rootCauseUrl: Proposal.buildRootCauseUrl({ issueNumber, rootCause, secret }), scan, reply,
    });
    await sendOwnerThreadEmail({
      issueNumber, subject: threadSubject({ show: reader.show, issueNumber }), html, text, root: true,
    });
    const sentAt = new Date().toISOString();
    Proposal.recordSent(proposalLedger, issueNumber, { sentAt, submittedAt, kind: alreadyFixed ? 'already-fixed' : 'needs-fix' });
    Proposal.saveLedger(proposalLedger);
    const mins = proposalLedger.entries[String(issueNumber)].minutes;
    console.log(`Proposal email sent (${alreadyFixed ? 'already fixed' : 'needs fix'}); ${mins == null ? 'SLA unknown' : `${mins} min after submission`}`);
    output('proposal_sent', 'true');
    output('proposal_minutes', mins == null ? '' : String(mins));
  }

  // Content-addition asks: if the show is already in the catalog, say so and
  // let the workflow close the issue with a comment (#1190, #1124 pattern).
  if (diagnosis.needsReview && Proposal.isContentAdditionBody(issueBody)) {
    const matches = Proposal.selectAutoCloseMatch(diagnosis.originalMessage, diagnosis.submitterShow, shows);
    if (matches.length > 0 && proposalOn) {
      try {
        await sendProposal({
          alreadyFixed: true,
          fixedEvidence: [`${matches.length} catalog ${matches.length === 1 ? 'entry matches' : 'entries match'} the show they named`],
          catalogMatches: matches,
          rootCause: {
            title: 'router leaves already-fixed asks open',
            summary: 'The feedback router could not tell which catalog entry the reader meant, so it left the issue open and sent no reply.',
            approach: 'When a requested title already matches a catalog entry, close the issue with a comment and put the reply draft in front of the owner.',
          },
        });
        output('already_fixed', 'true');
        output('already_fixed_urls', matches.map((m) => m.url).join(' '));
      } catch (err) {
        console.error('Proposal email failed:', err.message);
      }
      output('plan_created', 'false');
      return;
    }
  }

  // Find relevant shows — prefer the canonical multi-show showIds[] (issue
  // #515: a report can name more than one show), fall back to the legacy
  // singular showId, then to extracting names from the message text.
  let relevantShows = [];
  const diagShowIds = Array.isArray(diagnosis.showIds) ? diagnosis.showIds.filter(Boolean) : [];
  if (diagShowIds.length > 0) {
    for (const id of diagShowIds) {
      const show = shows.find(s => s.id === id);
      if (show) relevantShows.push(show);
    }
  } else if (diagnosis.showId) {
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
Specify: script name, args (optional, ONE string of space-separated flags, e.g. "args": "--show=some-show-id --apply")
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

- "rootCause" is optional. Include it ONLY when the specific fix leaves a pipeline or process gap that let this error through (for example a scraper that never retries). Give a plain-English summary and approach. Never put reader names, emails or message text in it. Otherwise set it to null.

Respond with ONLY a JSON object:
{
  "canCreatePlan": true,
  "rootCause": null,
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

    const tracked = maybeTrackContentFix(diagnosis, issueNumber);
    output('ledger_updated', tracked ? 'true' : 'false');

    // BRO-7600: the dispatchable card is filed by the workflow's own
    // 'File dispatchable card' step (scripts/file-feedback-card.js), the single
    // filer for every needs-manual-review path. It needs LINEAR_API_KEY, which
    // this step deliberately does not hold.
    output('plan_refused', 'true');
    output('plan_refusal_reason', String(plan.reason || '').replace(/\s+/g, ' ').slice(0, 300));
    const escalation = { filed: true };

    // Send a status email — its wording depends on whether the card above
    // actually got filed (auto-dispatched) or not (genuine fallback, still
    // needs a human to look).
    if (proposalOn) {
      try {
        await sendProposal({
          alreadyFixed: false,
          plan: { summary: `No automatic fix could be planned yet. ${String(plan.reason || '').replace(/\s+/g, ' ').slice(0, 300)} A fix card has been queued.`, steps: [], riskLevel: 'n/a' },
        });
      } catch (err) {
        console.error('Proposal email failed:', err.message);
      }
    } else if (ownerEmail && !diagnosis.needsReview) {
      const who = diagnosis.submitterName && diagnosis.submitterName !== 'Anonymous' ? diagnosis.submitterName : 'Someone';
      const showRef = diagnosis.submitterShow ? ` about <strong>${diagnosis.submitterShow}</strong>` : '';

      const banner = escalation.filed
        ? `<p style="margin:0 0 12px;padding:10px 14px;background-color:#dbeafe;border:1px solid #3b82f6;border-radius:6px;color:#1e40af;font-size:14px;">&#129302; <strong>Card being filed</strong> &mdash; auto-fix and the plan generator both couldn't scope this one, so the next workflow step files a P1 card for a Claude session to investigate. No action needed.</p>`
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
        ? `${escalation.filed ? 'Fix card queued' : 'Manual Fix Needed'}: ${diagnosis.submitterShow} (#${issueNumber})`
        : `${escalation.filed ? 'Fix card queued' : 'Manual Fix Needed'} (#${issueNumber})`;

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
      showIds: diagShowIds.length > 0 ? diagShowIds : (diagnosis.showId ? [diagnosis.showId] : []),
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
        const currentValue = formatFieldValue(targetShow[action.field]);
        currentState.push({
          showTitle: targetShow.title,
          showId: targetShow.id,
          field: action.field,
          currentValue,
          proposedChange: action.description || JSON.stringify(action.newValue),
          // The show's stored IBDB url, or none. The old slug-built url was never a real IBDB
          // address (IBDB urls end in a numeric production id), so "verify on IBDB" led nowhere.
          ibdbUrl: targetShow.ibdbUrl || null,
        });
      }
    }
  }

  // 6. Generate HMAC-signed approval URLs (bound to this plan's planId)
  const approveUrl = generateApprovalUrl('approve', issueNumber, secret, planId);
  const rejectUrl = generateApprovalUrl('reject', issueNumber, secret, planId);

  // 7. Send approval email
  const applied = Proposal.checkPlanAlreadyApplied(plan, shows);
  if (proposalOn) {
    try {
      await sendProposal({
        alreadyFixed: applied.fixed,
        fixedEvidence: applied.evidence,
        plan: { summary: plan.summary, steps: plan.steps, riskLevel: plan.riskLevel, actions: plan.actions },
        approveUrl: applied.fixed ? null : approveUrl,
        rejectUrl: applied.fixed ? null : rejectUrl,
        rootCause: plan.rootCause && plan.rootCause.summary ? plan.rootCause : null,
      });
      // Close only after the owner was actually told (kill switch and cap never close).
      if (applied.fixed) output('already_fixed', 'true');
    } catch (err) {
      console.error('Proposal email failed:', err.message);
    }
  } else if (ownerEmail && !diagnosis.needsReview) {
    const { subject, html } = buildFixApprovalEmail({
      // From the in-memory diagnosis, NOT planData.submitter — the persisted
      // plan is PII-redacted but the email to the owner keeps the full text.
      submitterName: diagnosis.submitterName || 'Anonymous',
      submitterEmail: diagnosis.submitterEmail || null,
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
          if (proposalOn) {
            await sendOwnerThreadEmail({ issueNumber, subject: threadSubject({ show: diagnosis.submitterShow, issueNumber }), html: sysHtml });
          } else {
            await sendEmail(
              ownerEmail,
              'Tom at Broadway Scorecard <updates@broadwayscorecard.com>',
              `Systematic Fix: ${systematic.summary.slice(0, 60)} (#${issueNumber})`,
              sysHtml
            );
          }
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
