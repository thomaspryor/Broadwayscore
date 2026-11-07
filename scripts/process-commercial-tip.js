#!/usr/bin/env node

/**
 * Process Commercial Tip
 *
 * Triggered by GitHub Actions when an issue with 'commercial-tip' label is created.
 * Validates the tip, matches it to a show, and applies changes if confident.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY - Claude API key for validation
 *   GITHUB_TOKEN - For posting comments on issues
 *   ISSUE_NUMBER - GitHub issue number
 *   ISSUE_BODY - Issue body text
 */

require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const https = require('https');
const { CLAUDE_SONNET } = require('./lib/models');
const { loadCommercial } = require('./lib/commercial-write-guard');
const { buildTipRecord, queueTipForReview, readPendingFile } = require('./lib/commercial-tip-record');
const { FIZZLE_MIN_RETURNED_PCT } = require('./lib/commercial-designations');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ISSUE_NUMBER = process.env.ISSUE_NUMBER;
const ISSUE_BODY = process.env.ISSUE_BODY;

const COMMERCIAL_PATH = path.join(__dirname, '..', 'data', 'commercial.json');
const PENDING_PATH = path.join(__dirname, '..', 'data', 'commercial-pending-review.json');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

function parseIssueBody(body) {
  if (!body) return null;

  const showNameMatch = body.match(/### Show Name\s*\n\s*(.+)/);
  const tipTypeMatch = body.match(/### Type of Information\s*\n\s*(.+)/);
  const detailsMatch = body.match(/### Details\s*\n\s*([\s\S]*?)(?=###|$)/);
  const sourceMatch = body.match(/### Source \(optional\)\s*\n\s*(.+)/);

  return {
    showName: showNameMatch ? showNameMatch[1].trim() : null,
    tipType: tipTypeMatch ? tipTypeMatch[1].trim() : null,
    details: detailsMatch ? detailsMatch[1].trim() : null,
    source: sourceMatch ? sourceMatch[1].trim() : null,
  };
}

function matchShowToSlug(showName, commercial, shows) {
  if (!showName) return null;

  const slug = showName.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .trim();

  // Check commercial.json slugs
  if (commercial.shows[slug]) return slug;

  // Check shows.json
  const showMatch = shows.find(s =>
    s.slug === slug ||
    s.title.toLowerCase() === showName.toLowerCase() ||
    s.title.toLowerCase().includes(showName.toLowerCase()) ||
    showName.toLowerCase().includes(s.title.toLowerCase())
  );
  if (showMatch) return showMatch.slug;

  // Normalized match
  const normalized = slug
    .replace(/^the-/, '')
    .replace(/-the-musical$/, '')
    .replace(/-on-broadway$/, '');

  for (const key of Object.keys(commercial.shows)) {
    const normalizedKey = key
      .replace(/^the-/, '')
      .replace(/-the-musical$/, '')
      .replace(/-on-broadway$/, '')
      .replace(/-\d{4}$/, '');
    if (normalizedKey === normalized) return key;
  }

  return null;
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: CLAUDE_SONNET,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.content && parsed.content[0]) {
            resolve(parsed.content[0].text);
          } else {
            reject(new Error(`Unexpected API response: ${data.slice(0, 200)}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse API response: ${e.message}`));
        }
      });
    });
    req.setTimeout(300000, () => req.destroy(new Error('request timed out after 300s idle')));

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function postGitHubComment(comment) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ body: comment });
    const repo = 'thomaspryor/Broadwayscore';

    const options = {
      hostname: 'api.github.com',
      path: `/repos/${repo}/issues/${ISSUE_NUMBER}/comments`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'BroadwayScorecard-Bot',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`GitHub API error ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error('request timed out after 60s idle')));

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function addLabel(label) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ labels: [label] });
    const repo = 'thomaspryor/Broadwayscore';

    const options = {
      hostname: 'api.github.com',
      path: `/repos/${repo}/issues/${ISSUE_NUMBER}/labels`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'BroadwayScorecard-Bot',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve());
    });
    req.setTimeout(60000, () => req.destroy(new Error('request timed out after 60s idle')));

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('Processing commercial tip...');

  if (!ISSUE_BODY) {
    console.error('ERROR: ISSUE_BODY is required');
    process.exit(1);
  }

  if (!ANTHROPIC_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY is required');
    process.exit(1);
  }

  // Parse the issue
  const tip = parseIssueBody(ISSUE_BODY);
  if (!tip || !tip.showName || !tip.details) {
    console.log('Could not parse issue body');
    if (GITHUB_TOKEN && ISSUE_NUMBER) {
      await postGitHubComment('Could not parse the tip submission. Please make sure all required fields are filled out.');
    }
    return;
  }

  console.log(`Show: ${tip.showName}`);
  console.log(`Type: ${tip.tipType}`);
  console.log(`Details: ${tip.details}`);

  // Load data
  const commercial = loadCommercial();
  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));

  // Match show
  const slug = matchShowToSlug(tip.showName, commercial, shows);
  console.log(`Matched slug: ${slug || 'NOT FOUND'}`);

  // Validate with Claude
  const currentData = slug ? JSON.stringify(commercial.shows[slug], null, 2) : 'No existing data';

  const validationPrompt = `You are a Broadway commercial data analyst. A user has submitted a tip about a Broadway show's financial performance.

Show name: ${tip.showName}
Matched slug: ${slug || 'NOT FOUND'}
Tip type: ${tip.tipType}
Details: ${tip.details}
Source: ${tip.source || 'Not provided'}

Current commercial data for this show:
${currentData}

Please analyze this tip and respond with a JSON object:
{
  "isCredible": boolean,
  "confidence": "high" | "medium" | "low",
  "reasoning": "Why you believe this is/isn't credible",
  "proposedChanges": [
    {
      "field": "field_name",
      "oldValue": current_value,
      "newValue": proposed_value,
      "isEstimate": boolean
    }
  ]
}

Rules:
- High confidence: official source cited (SEC filing, press announcement from Deadline/Variety/Playbill)
- Medium confidence: credible secondary source or consistent with known data
- Low confidence: unverified claim, vague details, or contradicts known data
- NEVER propose changing designation to/from Miracle, Nonprofit, or Tour Stop
- TBD->Windfall is OK if recoupment is officially announced
- A show that closed without recouping: "Fizzle" (${FIZZLE_MIN_RETURNED_PCT}% or more of its capitalization came back) or "Flop" (under ${FIZZLE_MIN_RETURNED_PCT}%) only when the tip's source states how much came back, proposed with estimatedRecoupmentPct as [low, high]; otherwise "Did Not Recoup"
- Be conservative: only propose changes you're confident about`;

  try {
    const response = await callClaude(validationPrompt);

    // Extract JSON from response
    let analysis;
    try {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : response);
    } catch (e) {
      console.error('Failed to parse Claude response:', e.message);
      if (GITHUB_TOKEN && ISSUE_NUMBER) {
        await postGitHubComment(`Tip received but automated processing encountered an error. This has been flagged for manual review.\n\nError: Could not parse AI validation response.`);
        await addLabel('needs-manual-review');
      }
      return;
    }

    console.log('Analysis:', JSON.stringify(analysis, null, 2));

    const wantsApply = analysis.isCredible && analysis.confidence !== 'low' && analysis.proposedChanges?.length > 0 && slug;
    // buildTipRecord is the validation step: it cleans the proposal against
    // the commercial rules and returns the field changes that survive. Only
    // those changes are queued below; the full record it builds is not written.
    const built = wantsApply
      ? buildTipRecord(commercial, shows.shows || shows, slug, analysis.proposedChanges)
      : { record: null, changes: [], refusedReason: null };

    if (wantsApply && built.record) {
      // BRO-6398: a reader tip is public, unauthenticated text judged by a
      // model, so it never writes commercial.json here. The cleaned changes
      // join data/commercial-pending-review.json as a human-review row. The
      // daily apply pass skips held rows; the health check files a worker card
      // for a row held past a week, and that worker applies the change to commercial.json
      // (apply-commercial-pending.js --release-held=SLUG for a figures-only
      // tip on an undesignated record, otherwise by hand).
      let pending = readPendingFile(fs, PENDING_PATH);
      const matchedShow = (shows.shows || shows).find((s) => s && s.slug === slug);
      pending = queueTipForReview(pending, {
        slug,
        title: (matchedShow && matchedShow.title) || tip.showName,
        changes: built.changes,
        confidence: analysis.confidence,
        source: tip.source,
        issueNumber: ISSUE_NUMBER,
        reasoning: analysis.reasoning,
      });
      fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n');

      // Post comment
      const changesTable = built.changes
        .map(c => `| ${c.field} | ${JSON.stringify(c.oldValue)} | ${JSON.stringify(c.newValue)} |`)
        .join('\n');

      if (GITHUB_TOKEN && ISSUE_NUMBER) {
        await postGitHubComment(`## Tip Queued for Review

**Show:** ${tip.showName} (\`${slug}\`)
**Confidence:** ${analysis.confidence}

### Proposed Changes (queued for the owner's review; nothing is live yet)

| Field | Current Value | Proposed Value |
|-------|---------------|----------------|
${changesTable}

**Reasoning:** ${analysis.reasoning}

---
*Automated by [process-commercial-tip.js](https://github.com/thomaspryor/Broadwayscore/blob/main/scripts/process-commercial-tip.js)*`);
        await addLabel('needs-manual-review');
      }

      console.log(`Queued ${built.changes.length} proposed changes for ${slug} in commercial-pending-review.json`);
    } else {
      // Flag for manual review
      const reason = built.refusedReason
        ? `Proposed change refused: ${built.refusedReason}`
        : !analysis.isCredible
        ? `Not credible: ${analysis.reasoning}`
        : analysis.confidence === 'low'
        ? `Low confidence: ${analysis.reasoning}`
        : !slug
        ? `Could not match show "${tip.showName}" to any known show`
        : `No changes proposed: ${analysis.reasoning}`;

      if (GITHUB_TOKEN && ISSUE_NUMBER) {
        await postGitHubComment(`## Tip Received - Manual Review Needed

**Show:** ${tip.showName}${slug ? ` (\`${slug}\`)` : ''}
**Confidence:** ${analysis.confidence || 'N/A'}
**Reason:** ${reason}

This tip has been flagged for manual review.

---
*Automated by [process-commercial-tip.js](https://github.com/thomaspryor/Broadwayscore/blob/main/scripts/process-commercial-tip.js)*`);
        await addLabel('needs-manual-review');
      }

      console.log(`Tip flagged for manual review: ${reason}`);
    }
  } catch (err) {
    console.error('Error processing tip:', err.message);
    if (GITHUB_TOKEN && ISSUE_NUMBER) {
      await postGitHubComment(`Tip received but automated processing encountered an error. This has been flagged for manual review.\n\nError: ${err.message}`);
      await addLabel('needs-manual-review');
    }
  }
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
