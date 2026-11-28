/**
 * Pure prompt-builder + response-parser for feedback categorization.
 * Extracted from process-feedback.js (test-extraction pattern, CLAUDE.md §15)
 * so the triage rules are unit-testable without a live Anthropic call.
 * Colocated test: tests/unit/feedback-categorize.test.mjs
 *
 * Routing consequences the rules encode (2026-07-26, Elephant Shoes incident):
 * only Bug and Content Error submissions reach the maintainer (diagnosis →
 * GitHub issue). Feature Request/Praise/Other end at a thank-you email — an
 * anonymous submission in those categories vanishes without a trace. So
 * content-addition requests MUST be Content Error, and market/venue must
 * never be grounds for the model to declare a request out of scope.
 */

function buildCategorizationPrompt(submissions) {
  const submissionsText = submissions.map((sub, idx) => {
    return `
SUBMISSION ${idx + 1}:
- Category (user-selected): ${sub.category || 'Not specified'}
- Name: ${sub.name || 'Anonymous'}
- Email: ${sub.email || 'Not provided'}
- Show: ${sub.show || 'N/A'}
- Message: ${sub.message}
- Submitted: ${new Date(sub._date || sub.createdAt).toLocaleDateString()}
`;
  }).join('\n---\n');

  return `You are analyzing user feedback submissions for Broadway Scorecard, a website that aggregates critic reviews and ratings for Broadway, Off-Broadway, and West End shows — plus Broadway-aimed regional tryouts and select regional productions (the catalog already includes regional entries).

Categorize each submission and provide:
1. **Category** (Bug, Feature Request, Content Error, Praise, Other)
2. **Priority** (High, Medium, Low)
3. **Summary** (1-2 sentences)
4. **Recommended Action** (brief suggestion)

Categorization rules:
- A request to add a missing show, or missing reviews/data for a named theatrical production (ANY market, including regional tryouts), is "Content Error" with "contentRequest": true. Missing content is actionable data work; only Bug and Content Error submissions reach the maintainer, so misfiling these makes them vanish silently.
- Reports that existing site content is wrong (scores, dates, cast, misattributed reviews) are "Content Error" with "contentRequest": false.
- Never declare a legitimate theatre-content request out of scope because of its market or venue. Scope decisions belong to the maintainer.
- Promotional or link-insertion requests (marketing, SEO, unrelated commercial sites) and other junk are "Other", never "Content Error".
- "Feature Request" is for new site functionality (filters, pages, features), not for content/data additions.

SUBMISSIONS:
${submissionsText}

Respond in this JSON format:
{
  "categorized": [
    {
      "submissionNumber": 1,
      "category": "Bug|Feature Request|Content Error|Praise|Other",
      "contentRequest": false,
      "priority": "High|Medium|Low",
      "summary": "Brief summary of the feedback",
      "recommendedAction": "What should be done about this",
      "userCategory": "What the user selected"
    }
  ]
}`;
}

function parseCategorizedResponse(responseText) {
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse Claude response as JSON');
  }
  const result = JSON.parse(jsonMatch[0]);
  const categorized = Array.isArray(result.categorized) ? result.categorized : [];
  // Normalize contentRequest to a strict boolean: the model sometimes emits
  // "true"/"false" strings, and the workflow drain branches on `=== true`.
  for (const item of categorized) {
    if (item && typeof item === 'object') {
      item.contentRequest = item.contentRequest === true || item.contentRequest === 'true';
    }
  }
  return categorized;
}

module.exports = { buildCategorizationPrompt, parseCategorizedResponse };
