'use strict';
/**
 * Files (or reuses) the START-NOW card for a failed digest-only workflow (BRO-6674).
 *
 *   node scripts/file-workflow-failure-card.js <workflow-key> [--dry-run]
 *
 * One open card carries the key line, so repeated failures comment on it
 * instead of filing a new one. Env: LINEAR_API_KEY, RUN_URL. Never exits
 * non-zero on a filing error (advisory; the calling step is continue-on-error).
 */
const { buildCard, keyLine } = require('./lib/workflow-failure-card.js');

const DAY_MS = 24 * 3600000;

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const workflow = args.find((a) => !a.startsWith('--'));
  if (!workflow) { console.error('Usage: node scripts/file-workflow-failure-card.js <workflow-key> [--dry-run]'); process.exit(2); }
  const card = buildCard({ workflow, runUrl: process.env.RUN_URL });
  if (dry) {
    console.log(`[dry-run] would file (or reuse the open card carrying "${keyLine(workflow)}"):\n\nTITLE: ${card.title}\n\n${card.description}`);
    return;
  }
  const linear = require('./lib/linear-client.js');
  const { isTerminalStateType } = require('./lib/linear-state-types.js');
  const unpickable = require('./lib/cloud-worker-pick.js').startNowUnpickableReason({ ...card, priority: 2, mode: 'dispatch' });
  if (unpickable) throw new Error(`card would never be picked (${unpickable.reason})`);
  const since = new Date(Date.now() - 90 * DAY_MS).toISOString();
  const found = await linear.listIssuesByProvenance({ since, descriptionMarkers: [keyLine(workflow)] });
  const open = found.find((i) => !isTerminalStateType(i.state && i.state.type));
  let id = open && open.identifier;
  if (open) {
    await linear.createComment(open.id, `Failed again${process.env.RUN_URL ? ` (${process.env.RUN_URL})` : ''}.`);
  } else {
    const { createLinearIssue } = require('./lib/linear-issue-create.js');
    try {
      const { issue } = await createLinearIssue({ ...card, priority: 2, dispatch: true, source: workflow });
      id = issue.identifier;
    } catch (e) {
      if (e && e.code === 'NEAR_DUPLICATE_OPEN' && e.twin && e.twin.identifier) id = e.twin.identifier;
      else throw e;
    }
  }
  if (!/^BRO-\d+$/.test(String(id))) throw new Error(`unexpected card id: ${id}`);
  console.log(`workflow failure card: ${id}${open ? ' (already open)' : ' (filed)'}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(`::warning::could not file the workflow failure card: ${e.message}`); });
}
