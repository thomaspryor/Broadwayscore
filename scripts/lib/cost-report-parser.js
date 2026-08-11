/**
 * cost-report-parser.js — extracts and ranks the "Top SB Credit Consumers"
 * table from a Monday scraper-cost-report.yml GitHub issue body (card #114).
 *
 * The workflow (.github/workflows/scraper-cost-report.yml) builds this
 * section as a fenced code block of "Workflow Name: NNNN credits" lines,
 * already sorted descending by an awk pipeline. This parser re-derives the
 * ranking itself rather than trusting the source order, so a future change
 * to the workflow's sort (or a hand-edited issue body) can't silently ship
 * a wrong #1 to whoever reads it next.
 *
 * Pure function, no fs/network — feed it an issue body string
 * (e.g. `gh issue view N --json body -q .body`).
 */
'use strict';

const SECTION_HEADING = /^##\s*Top SB Credit Consumers This Week\s*$/m;
const LINE_RE = /^(.+?):\s*([\d,]+)\s*credits\s*$/;

/**
 * @param {string} issueBody - full markdown body of a "Scraper Cost Report" issue
 * @returns {Array<{workflow: string, credits: number}>} descending by credits;
 *   empty array when the section is missing, empty, or shows the "—" placeholder
 */
function parseTopSbConsumers(issueBody) {
  if (!issueBody) return [];

  const headingMatch = SECTION_HEADING.exec(issueBody);
  if (!headingMatch) return [];

  const afterHeading = issueBody.slice(headingMatch.index + headingMatch[0].length);
  // Content lives inside the first fenced code block after the heading;
  // fall back to scanning raw lines up to the next heading if unfenced.
  const fenced = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(afterHeading);
  const nextHeading = /^##\s/m.exec(afterHeading);
  const body = fenced ? fenced[1] : afterHeading.slice(0, nextHeading ? nextHeading.index : undefined);

  const consumers = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line === '—' || line === '-') continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const workflow = m[1].trim();
    const credits = parseInt(m[2].replace(/,/g, ''), 10);
    if (!workflow || !Number.isFinite(credits)) continue;
    consumers.push({ workflow, credits });
  }

  return consumers.sort((a, b) => b.credits - a.credits);
}

/**
 * @param {string} issueBody
 * @returns {{workflow: string, credits: number} | null} the single highest
 *   SB-credit consumer, or null if the section is empty/missing
 */
function topSbConsumer(issueBody) {
  const consumers = parseTopSbConsumers(issueBody);
  return consumers.length ? consumers[0] : null;
}

module.exports = { parseTopSbConsumers, topSbConsumer };
