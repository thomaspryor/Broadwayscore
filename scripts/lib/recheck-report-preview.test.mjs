// BRO-7622: a RECHECK-AFTER report must show which command the nightly recheck will run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { previewRecheckCommand, namesCommand } = require('./recheck-report-preview.js');

// BRO-6794 as it was on 2026-11-02 (trimmed): description arms nothing usable,
// the launch snapshot is the broken market-name command, and the report names the
// real probe mid-sentence.
const BAD = 'node scripts/lib/verify-data-backfill.js --show=broadway,west-end,regional,tour --reviews=1835';
const GOOD = 'node scripts/check-never-audited-backlog.js --max=100';
const issue = {
  identifier: 'BRO-6794', title: 'Older-years sweep remainder', state: { name: 'In Progress', type: 'started' },
  description: `Remainder of BRO-6761.\n\n## Acceptance criteria\n\n\`${BAD}\`\n`,
  comments: { nodes: [{ body: 'Claimed by local session', createdAt: '2026-11-02T13:45:25Z' }] },
};
const launchEntries = [{ ts: '2026-11-02T13:45:05Z', event: 'launch', linearId: 'BRO-6794', notionId: null, verifyCmd: BAD }];

test('BRO-6794 replay: mid-sentence VERIFY is shadowed by the dispatch snapshot -> warn', () => {
  const reportBody = `**Session report (paused)**\n\nLanded the probe. RECHECK-AFTER: 2026-11-16 VERIFY: ${GOOD}. Not started: blocked hosts.`;
  const r = previewRecheckCommand({ issue, reportBody, launchEntries, now: '2026-11-02T14:19:54Z' });
  assert.equal(r.warn, true);
  assert.equal(r.cmd, BAD);
});

test('a correction line on its own makes the recheck run the real probe -> no warning', () => {
  const reportBody = `**Session report (paused)**\n\nRECHECK-AFTER: 2026-11-16\n\nVERIFY (correction): ${GOOD}\n`;
  const r = previewRecheckCommand({ issue, reportBody, launchEntries, now: '2026-11-02T14:19:54Z' });
  assert.equal(r.warn, false);
  assert.equal(r.cmd, GOOD);
});

test('stamp with no runnable command anywhere -> warn with no command', () => {
  const bare = { ...issue, description: 'prose only' };
  const r = previewRecheckCommand({ issue: bare, reportBody: 'RECHECK-AFTER 2026-11-16 (colon-less stamp)', launchEntries: [], now: '2026-11-02T14:19:54Z' });
  assert.equal(r.warn, true);
  assert.equal(r.cmd, null);
});

test('no stamp -> null (nothing to preview)', () => {
  assert.equal(previewRecheckCommand({ issue, reportBody: 'done, VERIFY: x', launchEntries }), null);
});

// Ship-check findings (BRO-7622): no false warning on NO-VERIFY or spacing; no missed one on a prefix.
test('NO-VERIFY: lines and whitespace differences do not warn', () => {
  const armed = { ...issue, description: `## Acceptance criteria\n\n\`${GOOD}\`\n` };
  const noVerify = previewRecheckCommand({ issue: armed, reportBody: 'RECHECK-AFTER: 2026-11-16\nNO-VERIFY: A/B was fine', launchEntries: [], now: '2026-11-02T14:19:54Z' });
  assert.equal(noVerify.warn, false);
  const spaced = previewRecheckCommand({ issue: armed, reportBody: 'RECHECK-AFTER: 2026-11-16 VERIFY: `node  scripts/check-never-audited-backlog.js --max=100`', launchEntries: [], now: '2026-11-02T14:19:54Z' });
  assert.equal(spaced.warn, false);
});
test('namesCommand matches whole commands only', () => {
  assert.equal(namesCommand('VERIFY: node x.js --max=100.', 'node x.js --max=100'), true);
  assert.equal(namesCommand('VERIFY: node x.js --max=100', 'node x.js --max=10'), false);
});
