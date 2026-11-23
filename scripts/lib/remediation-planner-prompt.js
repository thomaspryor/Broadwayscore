/**
 * remediation-planner-prompt — the planner LLM's prompt for generate-remediation-plan.js (BRO-8209).
 *
 * The prompt used to be an inline template that offered three action types (data-edit, run-script,
 * review-file-op). execute-approved-fix.js also runs review-field-edit (BRO-4216), whose allowlist
 * includes `url` (repair of a provably wrong link) and `criticName`, but the planner was never told,
 * so every wrong-review-link report ended "review records are not in the allowed editable files"
 * (feedback #1203, Falls for Jodie). The advertised list now lives here, next to a test that reads the
 * executor's switch and fails when an action type it runs is neither advertised nor listed in
 * NOT_OFFERED_TO_PLANNER with a reason.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// What the planner may emit. `schema` is the text the prompt shows for the type.
const PLANNER_ACTIONS = [
  {
    type: 'data-edit',
    title: 'data-edit — Change fields in data files',
    schema: ({ allowedFieldsList }) => `Allowed fields:
${allowedFieldsList}
Each edit must specify: file, showId/slug, field, oldValue, newValue`,
  },
  {
    type: 'run-script',
    title: 'run-script — Run a pipeline script',
    schema: ({ allowedScripts }) => `Allowed scripts: ${allowedScripts.join(', ')}
Specify: script name, args (optional, ONE string of space-separated flags, e.g. "args": "--show=some-show-id --apply")
IMPORTANT: Do NOT include validate-data.js as an action — validation runs automatically after data edits.`,
  },
  {
    type: 'review-file-op',
    title: 'review-file-op — Move/delete review files in data/review-texts/',
    schema: () => `Specify: operation (move, delete, rename), sourcePath, destPath (paths are relative to data/review-texts/, e.g. "some-show-id/talkinbroadway--michael-dale.json").
Use delete for a review record that is wrong and has no correct version to keep (a duplicate, another critic's review filed under this critic, a review of a different show). Use move/rename for a file filed under the wrong show or outlet whose content is right.
An outlet change is a move: the outlet is part of the filename (<outletId>--<critic-slug>.json), and outletId itself is NOT an editable field. If the record's text and url are right and only the outlet is wrong, move the file; if its url is also wrong and the reader already supplied the correct review, delete it.`,
  },
  {
    type: 'review-field-edit',
    title: 'review-field-edit — Fix one field on one review record (compare-and-set)',
    schema: () => `Use this for any report about a single review: a link that goes to the wrong article, a wrong critic byline, a wrong date, a review flagged against the wrong show or production, a review that is not a review.
Specify: file ("<showId>/<outletId>--<critic-slug>.json", taken from the Review Records section above), field, oldValue (the CURRENT value, copied from the record), newValue, description.
Editable fields include: url, criticName, publishDate, designation, wrongAttribution, wrongShow, wrongProduction, isNotReview, isNonReview, duplicateOf, humanReviewScore, llmPullQuote (full list: REVIEW_TEXT_EDITABLE_FIELDS in scripts/lib/review-field-edit.js). Never fullText, scores from the model, or pipeline bookkeeping.
- url: only repairs a url that is provably wrong (another critic's review, another show's review, an aggregator or non-review page). The new url must be on the outlet's own domain and come from the reader's report or from the Review Records above; if you do not have the correct url, plan "newValue": "" only where allowed, otherwise say so in canCreatePlan:false. The collector refetches the page afterwards.
- criticName: use when the byline is wrong but the outlet is right.
- The executor refuses an edit whose oldValue no longer matches, so always copy oldValue exactly.`,
  },
];

// Action types execute-approved-fix.js runs that the planner is deliberately not offered. Every
// entry needs a reason: the test fails on an executor type that is in neither list.
const NOT_OFFERED_TO_PLANNER = {
  'add-show': 'owner-curated catalog additions; hand-written pending-fix plans only',
  'retire-show': 'removes a catalog row; hand-written pending-fix plans only',
  'retitle-show': 'hand-written pending-fix plans only',
  'add-commercial-entry': 'needs cited sources the planner cannot verify',
  'drop-orphan-key': 'maintenance action from the data-health digest',
  'outlet-registry-flag': 'maintenance action from the data-health digest',
  'outlet-registry-alias': 'maintenance action from the data-health digest',
  'coverage-expectation-redecide': 'maintenance action from the data-health digest',
  'batch-transform': 'bulk transform, hand-written plans only',
  'ingest-html-handoff': 'needs an encrypted page capture made by a cloud session',
};

function advertisedActionTypes() {
  return PLANNER_ACTIONS.map((a) => a.type);
}

/**
 * Review records for the shows a report is about, so the planner can name the exact file and url.
 * Rows come from reviews.json (always present in CI); when the private review-texts checkout exists
 * the real filenames and fields are read from it instead.
 * @returns {string} markdown section, or '' when there is nothing to show
 */
function buildReviewRecordContext(show, allReviews, { reviewTextsDir = null, limit = 80 } = {}) {
  const { generateReviewFilename } = require('./review-normalization');
  const rows = [];
  const dir = reviewTextsDir && path.join(reviewTextsDir, show.id);
  let onDisk = [];
  try { if (dir) onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch { onDisk = []; }
  if (onDisk.length) {
    for (const f of onDisk) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        rows.push({ file: `${show.id}/${f}`, outletId: r.outletId, outlet: r.outlet, criticName: r.criticName, url: r.url, publishDate: r.publishDate, wrongShow: r.wrongShow || undefined, wrongAttribution: r.wrongAttribution || undefined });
      } catch { /* unreadable file: skip */ }
    }
  } else {
    for (const r of allReviews.filter((x) => x.showId === show.id)) {
      let file = null;
      try { file = `${show.id}/${generateReviewFilename(r.outletId || r.outlet, r.criticName)}`; } catch { /* no filename */ }
      rows.push({ file, fileIsInferred: true, outletId: r.outletId, outlet: r.outlet, criticName: r.criticName, url: r.url, publishDate: r.publishDate });
    }
  }
  if (!rows.length) return '';
  const shown = rows.slice(0, limit);
  const note = onDisk.length
    ? 'Filenames are the real files in data/review-texts.'
    : 'Filenames are inferred from outlet and critic (<outletId>--<critic-slug>.json); the executor refuses a file that does not exist, so a wrong guess fails safe.';
  return `## Review Records for ${show.title} (${rows.length} total${rows.length > limit ? `, showing first ${limit}` : ''})
${note}
\`\`\`json
${JSON.stringify(shown, null, 2)}
\`\`\``;
}

function buildPlannerPrompt({ diagnosis, fixAction, contextParts, allowedFieldsList, allowedScripts }) {
  const ctx = { allowedFieldsList, allowedScripts };
  const actionDocs = PLANNER_ACTIONS
    .map((a, i) => `### ${i + 1}. ${a.title}\n${a.schema(ctx)}`)
    .join('\n\n');

  return `You are generating a remediation plan for a bug on Broadway Scorecard that couldn't be auto-fixed.

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

${actionDocs}

## Rules
- Be SPECIFIC with every action — exact field names, exact values, exact paths
- For data-edits and review-field-edits, include the current oldValue so the executor can verify nothing changed
- Keep it minimal — only what's needed to fix the bug
- Assess risk honestly: Low (data-only, easily reversible), Medium (multiple files, review file ops), High (structural changes)
- Write the summary in plain English as if explaining to a friend
- CRITICAL: Only use show IDs and production details that appear in the Show Data above. Do NOT guess production years, revival numbers, or historical facts. If the show data doesn't include specific shows mentioned in the diagnosis, use generic references (e.g., "the Sweeney Todd entry") and set showId to null with a note that the correct show ID needs to be looked up.
- Review records are editable. Do NOT answer "review records are not in the allowed editable files": a wrong review link, byline or outlet is planned with review-field-edit and review-file-op, using the Review Records section above.
- Never invent a replacement url. Use a url the reader gave or one already in the Review Records; otherwise return canCreatePlan:false and name the page that needs checking.

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
    },
    {
      "type": "review-field-edit",
      "file": "show-id/outlet-id--critic-slug.json",
      "field": "url",
      "oldValue": "current url",
      "newValue": "correct url",
      "description": "Why this change"
    }
  ]
}

Or if you cannot create an actionable plan:
{ "canCreatePlan": false, "reason": "why" }`;
}

module.exports = {
  PLANNER_ACTIONS, NOT_OFFERED_TO_PLANNER, advertisedActionTypes, buildReviewRecordContext, buildPlannerPrompt,
};
