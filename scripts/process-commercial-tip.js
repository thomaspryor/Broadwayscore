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

const fs = require('fs');
const path = require('path');
const https = require('https');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ISSUE_NUMBER = process.env.ISSUE_NUMBER;
const ISSUE_BODY = process.env.ISSUE_BODY;

const COMMERCIAL_PATH = path.join(__dirname, '..', 'data', 'commercial.json');
const CHANGELOG_PATH = path.join(__dirname, '..', 'data', 'commercial-changelog.json');
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
      model: 'claude-sonnet-4-20250514',
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
  const commercial = JSON.parse(fs.readFileSync(COMMERCIAL_PATH, 'utf8'));
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

    if (analysis.isCredible && analysis.confidence !== 'low' && analysis.proposedChanges?.length > 0 && slug) {
      // Apply changes
      for (const change of analysis.proposedChanges) {
        if (commercial.shows[slug]) {
          commercial.shows[slug][change.field] = change.newValue;
          if (change.isEstimate && change.field !== 'designation') {
            if (!commercial.shows[slug].isEstimate) commercial.shows[slug].isEstimate = {};
            commercial.shows[slug].isEstimate[change.field] = true;
          }
        }
      }

      commercial._meta.lastUpdated = new Date().toISOString().split('T')[0];
      fs.writeFileSync(COMMERCIAL_PATH, JSON.stringify(commercial, null, 2) + '\n');

      // Update changelog
      let changelog;
      try {
        changelog = JSON.parse(fs.readFileSync(CHANGELOG_PATH, 'utf8'));
      } catch (e) {
        changelog = { _meta: { description: 'Automated commercial data update log', lastUpdated: null }, entries: [] };
      }

      changelog.entries.push({
        date: new Date().toISOString().split('T')[0],
        source: `User tip via GitHub issue #${ISSUE_NUMBER}`,
        changesApplied: analysis.proposedChanges.map(c => ({
          slug,
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          confidence: analysis.confidence,
        })),
      });
      changelog._meta.lastUpdated = new Date().toISOString().split('T')[0];
      fs.writeFileSync(CHANGELOG_PATH, JSON.stringify(changelog, null, 2) + '\n');

      // Post comment
      const changesTable = analysis.proposedChanges
        .map(c => `| ${c.field} | ${JSON.stringify(c.oldValue)} | ${JSON.stringify(c.newValue)} |`)
        .join('\n');

      if (GITHUB_TOKEN && ISSUE_NUMBER) {
        await postGitHubComment(`## Tip Processed Successfully

**Show:** ${tip.showName} (\`${slug}\`)
**Confidence:** ${analysis.confidence}

### Changes Applied

| Field | Old Value | New Value |
|-------|-----------|-----------|
${changesTable}

**Reasoning:** ${analysis.reasoning}

---
*Automated by [process-commercial-tip.js](https://github.com/thomaspryor/Broadwayscore/blob/main/scripts/process-commercial-tip.js)*`);
      }

      console.log(`Applied ${analysis.proposedChanges.length} changes for ${slug}`);
    } else {
      // Flag for manual review
      const reason = !analysis.isCredible
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
