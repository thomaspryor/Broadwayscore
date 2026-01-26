#!/usr/bin/env node

/**
 * Fetches feedback submissions from Formspree and categorizes them using AI
 * Creates a summary for review
 */

import { Anthropic } from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Fetch submissions from Formspree
 */
async function fetchFormspreeSubmissions() {
  const token = process.env.FORMSPREE_TOKEN;

  if (!token) {
    console.log('⚠️  FORMSPREE_TOKEN not set. Skipping fetch.');
    return [];
  }

  try {
    // Get submissions from the last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const since = sevenDaysAgo.toISOString();

    const response = await fetch(
      `https://formspree.io/api/0/forms/YOUR_FORM_ID/submissions?since=${since}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      console.error(`Formspree API error: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json();
    return data.submissions || [];
  } catch (error) {
    console.error('Error fetching from Formspree:', error.message);
    return [];
  }
}

/**
 * Categorize feedback using Claude API
 */
async function categorizeFeedback(submissions) {
  if (submissions.length === 0) {
    return [];
  }

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

  console.log('🤖 Categorizing feedback with Claude API...\n');

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 4000,
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ]
  });

  const responseText = message.content[0].text;

  // Extract JSON from response
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse Claude response as JSON');
  }

  const result = JSON.parse(jsonMatch[0]);
  return result.categorized || [];
}

/**
 * Generate markdown summary
 */
function generateSummary(submissions, categorized) {
  if (submissions.length === 0) {
    return 'No feedback submissions to process this week.';
  }

  const summary = [];

  summary.push('# Feedback Digest');
  summary.push('');
  summary.push(`**Period**: ${new Date().toLocaleDateString()}`);
  summary.push(`**Total Submissions**: ${submissions.length}`);
  summary.push('');
  summary.push('---');
  summary.push('');

  // Group by category
  const byCategory = {
    'Bug': [],
    'Feature Request': [],
    'Content Error': [],
    'Praise': [],
    'Other': []
  };

  categorized.forEach((cat, idx) => {
    const submission = submissions[idx];
    if (!byCategory[cat.category]) {
      byCategory[cat.category] = [];
    }
    byCategory[cat.category].push({ ...cat, submission });
  });

  // High priority items first
  const highPriority = categorized.filter(c => c.priority === 'High');
  if (highPriority.length > 0) {
    summary.push('## 🚨 High Priority Items');
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
  summary.push('## 📊 All Submissions by Category');
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
  console.log('📬 Fetching feedback submissions...\n');

  try {
    const submissions = await fetchFormspreeSubmissions();

    console.log(`✅ Fetched ${submissions.length} submissions\n`);

    if (submissions.length === 0) {
      console.log('No submissions to process. Exiting.');

      // Write empty summary
      const summaryPath = path.join(__dirname, '../.feedback-summary.md');
      fs.writeFileSync(summaryPath, 'No feedback submissions to process this week.');

      return;
    }

    const categorized = await categorizeFeedback(submissions);

    console.log('✅ Categorization complete\n');

    const summary = generateSummary(submissions, categorized);

    console.log('=== SUMMARY ===');
    console.log(summary);
    console.log('===============\n');

    // Write summary to file for GitHub Actions
    const summaryPath = path.join(__dirname, '../.feedback-summary.md');
    fs.writeFileSync(summaryPath, summary);

    console.log(`✅ Summary written to ${summaryPath}`);

    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `summary=${summaryPath}\n`
      );
    }

  } catch (error) {
    console.error('❌ Error processing feedback:', error);
    process.exit(1);
  }
}

main();
