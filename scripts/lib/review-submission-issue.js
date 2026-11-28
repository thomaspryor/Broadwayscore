'use strict';

/**
 * Parses a review-submission issue body (written by
 * src/app/api/submit-review/route.ts) for scripts/validate-review-submission.js.
 * Extracted so it can be tested without loading the validator's data files.
 */

/**
 * Extract issue data from GitHub issue body
 */
function parseIssueBody(issueBody) {
  const data = {};

  // Extract review URL
  const urlMatch = issueBody.match(/### Review URL\s*\n\s*(.+)/);
  if (urlMatch) data.reviewUrl = urlMatch[1].trim();

  // Extract show name
  const showMatch = issueBody.match(/### Show Name\s*\n\s*(.+)/);
  if (showMatch && showMatch[1].trim() !== '_No response_') {
    data.showName = showMatch[1].trim();
  }

  // Extract outlet name
  const outletMatch = issueBody.match(/### Outlet Name\s*\n\s*(.+)/);
  if (outletMatch && outletMatch[1].trim() !== '_No response_') {
    data.outletName = outletMatch[1].trim();
  }

  // Extract critic name
  const criticMatch = issueBody.match(/### Critic Name\s*\n\s*(.+)/);
  if (criticMatch && criticMatch[1].trim() !== '_No response_') {
    data.criticName = criticMatch[1].trim();
  }

  // Extract additional notes
  // Stop at the next section or the '---' footer (BRO-4454): the old greedy /(.+)/s capture ran to
  // the end of the body, so the submitter's email section was logged to the
  // public Actions log by validate-review-submission.js and sent to the model
  // as "notes".
  const notesMatch = issueBody.match(/### Additional Notes[ \t]*\r?\n[ \t]*([\s\S]*?)(?=\n###\s|\n---\s*(?:\n|$)|$)/);
  if (notesMatch && notesMatch[1].trim() && notesMatch[1].trim() !== '_No response_') {
    data.additionalNotes = notesMatch[1].trim();
  }

  return data;
}

module.exports = { parseIssueBody };
