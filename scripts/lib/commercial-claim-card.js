/**
 * Linear card text for a pending recouped claim, filed by
 * scripts/notify-pending-commercial-linear.js. Lives in scripts/lib so the
 * unit tests can require it (CLAUDE.md §15) under test.yml's scripts/lib/** path.
 */

'use strict';

function buildNotes(item) {
  // The report keys cards by show slug; the pending row may be keyed by show
  // ID (wicked-2003), and --show / --reject take that key.
  const key = item.pendingKey || item.slug;
  const lines = [
    '## Problem',
    '',
    `The commercial-data pipeline flagged a recouped-claim entry for **${item.slug}** that needs human verification before \`commercial.json\` is updated. The Friday scraper or deep-research pass found evidence that this show recouped, but the auto-apply gate (\`commercial-apply-gate.js\`) refused to promote it because the gate's combination of (confidence, sourceHost, detectedBy) didn't qualify for the trusted-publisher fast path. Without manual review, the show stays at TBD and the Sunday newsletter under-reports.`,
    '',
    '## Claim details',
    '',
    `- **Show slug:** \`${item.slug}\``,
    `- **Pending key:** \`${key}\``,
    `- **Confidence:** ${item.confidence || 'unknown'}`,
    `- **Detected by:** ${item.detectedBy || 'unknown'}`,
    `- **Source host:** ${item.sourceHost || 'unknown'}`,
    `- **Recouped date claim:** ${item.recoupedDate || 'unknown'}`,
    `- **Source URL:** ${item.recoupedSource || 'n/a'}`,
    `- **First researched:** ${item.researchedAt || 'unknown'}`,
    '',
    '### Evidence quote',
    item.evidence ? `> ${item.evidence}` : '_(none captured — verify against source URL above before promoting)_',
    '',
    '## Suggested approach',
    '',
    '1. Open the source URL and confirm the article actually states recoupment for THIS production (not a prior revival, not a different show by the same title).',
    '2. If valid → apply the pending entry:',
    '   ```bash',
    `   node scripts/apply-commercial-pending.js --show=${key}`,
    '   ```',
    '3. If the article is real but additional citations would help, queue a deep-research pass:',
    '   ```bash',
    `   node scripts/deep-research-commercial.js --shows=${item.slug} --max-shows=1`,
    '   ```',
    '4. If invalid (wrong production, SEO republish of an old article, misread by the LLM classifier, no quotable citation) → reject it. The source URLs are remembered in `data/commercial-pending-archive.json`, so neither the Friday scraper nor deep research re-files them; a held backfill row keeps its research and loses only the claim:',
    '   ```bash',
    `   node scripts/sweep-pending-commercial.js --reject=${key} --reason="<why, with what you checked>"`,
    '   ```',
    '5. Optional belt-and-braces: set `humanReviewedDesignation: true` on the `commercial.json` entry so future auto-applies skip it (the merge layer preserves this flag across rebases).',
    '',
    '## Acceptance criteria',
    '',
    `- \`commercial.json\` entry for \`${item.slug}\` reflects the verified state (recouped applied OR archived with reason), OR the entry has \`humanReviewedDesignation: true\` set.`,
    '- Next Friday/Saturday run does NOT re-surface the same entry (verified by checking the archive for the rejected URL, or by the apply removing the pending entry).',
    '',
    ...(/^[a-z0-9][a-z0-9:_-]{0,120}$/.test(key) ? [`VERIFY: node scripts/check-review-item-resolved.js --claim=${key}`] : []),
  ];
  return lines.join('\n');
}

function buildTitle(slug) {
  return `commercial-pending-${slug} — recoupment claim needs review`;
}

module.exports = { buildNotes, buildTitle };
