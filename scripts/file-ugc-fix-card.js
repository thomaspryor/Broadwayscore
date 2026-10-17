'use strict';
/**
 * Files the START-NOW fix card for a failed signed-in-users check (BRO-5542,
 * owner 2026-10-16: "I hate getting emailed about issues that can be fixed just
 * by me pasting it into a Claude session"). test-ugc-roundtrip.yml runs this
 * before it emails the owner, so the email can say a fix is already running.
 *
 * Literal START-NOW line, Todo, P1 (cloud-worker-pick.js takes it straight
 * away; a dispatchAtFiling card would wait for the Mac). An open card from the
 * last 24h is reused, so a failing check files one card, not one per run.
 * Prints `card=BRO-N` to $GITHUB_OUTPUT (empty when nothing could be filed).
 * Env: FAILED_CHECKS, RUN_URL.
 */
const KEY = 'ugc-roundtrip:users-affected';
const KEY_LINE = `ugc-fix-key: ${KEY}`;
const DAY_MS = 24 * 3600000;

function buildCard({ failed, runUrl }) {
  const { startNowLine } = require('./lib/start-now-filing.js');
  const description = [
    startNowLine('the Mac drain').replace('visitor-facing daily health row (digest-audience.js)', 'signed-in users may be affected by this failing live check'),
    KEY_LINE,
    '',
    `The daily live check of sign-in, saving and privacy (test-ugc-roundtrip.yml) failed and its automatic database restore did not fix it. Failing checks: ${failed || 'see the run log'}.`,
    runUrl ? `Run: ${runUrl}` : '',
    '',
    'What to do: read the run log, find the cause and fix it, then confirm with `node scripts/test-ugc-roundtrip.mjs` (or a re-run of the workflow).',
    'If a failing check mentions RLS, anonymous access or another user\'s data, treat it as a privacy leak: fix that first. Do not turn sign-in off unless the repo\'s own docs name a safe switch; if nothing safe exists, say so in a comment on this card.',
    'The owner is emailed separately and is told this card exists; nothing is needed from them.',
    'The live result is only known after the workflow runs again, so also trigger test-ugc-roundtrip.yml and quote its result when you close this card.',
    'VERIFY: node --test tests/unit/ugc-roundtrip-urgency.test.mjs',
  ].filter((l) => l !== '').join('\n');
  return { title: 'Signed-in users may be affected: fix the failing sign-in, saving or privacy check', description };
}

async function main() {
  const linear = require('./lib/linear-client.js');
  const { isTerminalStateType } = require('./lib/linear-state-types.js');
  const card = buildCard({ failed: process.env.FAILED_CHECKS, runUrl: process.env.RUN_URL });
  const unpickable = require('./lib/cloud-worker-pick.js').startNowUnpickableReason({ ...card, priority: 1, mode: 'dispatch' });
  if (unpickable) throw new Error(`fix card would never be picked (${unpickable.reason})`);
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const found = await linear.listIssuesByProvenance({ since, descriptionMarkers: [KEY_LINE] });
  const open = found.find((i) => !isTerminalStateType(i.state && i.state.type));
  let id = open && open.identifier;
  if (!id) {
    const { createLinearIssue } = require('./lib/linear-issue-create.js');
    const { issue } = await createLinearIssue({ ...card, priority: 1, dispatch: true, source: 'ugc-roundtrip' });
    id = issue.identifier;
  }
  console.log(`fix card: ${id}${open ? ' (already open)' : ' (filed)'}`);
  if (process.env.GITHUB_OUTPUT) require('fs').appendFileSync(process.env.GITHUB_OUTPUT, `card=${id}\n`);
}

if (require.main === module) {
  main().catch((e) => { console.error(`::warning::could not file the fix card: ${e.message}`); });
}

module.exports = { buildCard, KEY_LINE };
