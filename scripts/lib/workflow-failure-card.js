'use strict';
/** Card text for a failed workflow whose alert is digest-only (BRO-6674). Mirrors scripts/lib/schema-drift-card.js. */

const CARDS = {
  'rotate-gitlab-token': {
    title: 'GitLab mirror token rotation failed: rotate it before it expires',
    why: 'rotate-gitlab-token.yml runs monthly and rotates GITLAB_MIRROR_TOKEN once it has 30 days left. A failed run leaves the old token ticking, and the next scheduled run is a month away. If the token expires the GitLab mirror stops updating.',
    action: 'Read the run log. If the token is expired or invalid, create a new GitLab personal access token and tell the owner on this card (only they hold the GitLab login). If the rotation API call failed, re-run rotate-gitlab-token.yml by workflow_dispatch and quote that it passes before closing.',
  },
};

const keyLine = (workflow) => `workflow-failure-key: ${workflow}`;

function buildCard({ workflow, runUrl }) {
  const c = CARDS[workflow];
  if (!c) throw new Error(`no failure card defined for workflow "${workflow}"`);
  return {
    title: c.title,
    description: [
      'START-NOW: a digest-only workflow failed and the failure needs same-day action. Any worker may take it once the Mac drain has not claimed it.',
      keyLine(workflow),
      '',
      c.why,
      runUrl ? `Run: ${runUrl}` : '',
      '',
      `What to do: ${c.action}`,
      'The owner is not emailed for this; the card is the alert.',
      'VERIFY: node --test scripts/audit-low-severity-workflows.test.mjs',
    ].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0)).join('\n'),
  };
}

module.exports = { CARDS, keyLine, buildCard };
