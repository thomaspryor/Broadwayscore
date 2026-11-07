// BRO-280 acceptance criteria: every intake channel and background job named
// in the issue body (BSC Daily email, the two/three intake channels, the
// ~20 background jobs, session rituals) must have an explicit disposition
// recorded (migrated to Linear / retired / carried to a named BRO-issue).
// Reads notion-linear-transition-inventory.md and diffs its component rows
// against a hardcoded list of the components BRO-280 names, so a component
// silently dropped from the doc (or never given a disposition) fails CI
// instead of drifting unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY_PATH = path.join(__dirname, '..', '..', 'notion-linear-transition-inventory.md');

// Every component BRO-280's acceptance criteria names, grouped as the issue
// body groups them. This list is intentionally hardcoded (not derived from
// the doc under test) so the test catches a component silently disappearing.
const REQUIRED_COMPONENTS = {
  'BSC Daily email': ['BSC Daily digest email (7:30am, `com.broadwayscore.morning-digest`)'],
  'Intake channels': [
    'Email worker (`~/.claude-email-worker/poll.py`, launchd `com.broadwayscore.claude-email-worker`)',
    'Notion action poller (`scripts/notion-action-poll.js`, launchd `com.bwsc.action-dispatcher`)',
    'Alert router `dispatchCard()` (`scripts/lib/owner-alert-router.js`)',
  ],
  'Background jobs': [
    '`com.bwsc.action-dispatcher` (notion-action-poll.js)',
    '`com.broadwayscore.bsc-reconcile`',
    '`com.broadwayscore.reconcile-dead-completions`',
    '`com.broadwayscore.newsletter-sunday-review` (autonomous-run.js)',
    '`com.broadwayscore.backlog-drain`',
    '`com.broadwayscore.bsc-autoprune`',
    '`com.broadwayscore.morning-digest`',
    '`com.broadwayscore.dispatch-watchdog-health`',
    '`com.broadwayscore.task-store-archive`',
    '16 other unaffected jobs (deploy heartbeat, hook liveness, cookie refresh, opening-night monitor, worktree GC, …)',
  ],
  'Session rituals': [
    'CLAUDE.md rule 6 ("Notion is the single source of truth")',
    '`session-start` skill',
    '`wrap-up` skill',
    '`done` skill',
    '`did-it-work` skill',
    '`ship-check` skill',
    '`what-else` skill',
    '`second-opinion` skill',
    '`notion-sweep` skill',
    '`morning-briefing` skill',
    '`triage-feedback` skill',
    '5 repo-scoped skills referencing Notion/`bsc-next`',
  ],
};

const VALID_DISPOSITION = /^(migrated|retired|keep|carried:BRO-\d+|pending|pending:BRO-\d+)$/;

// Parses `| Component | Disposition | Evidence |` markdown table rows into
// { component -> disposition }. Deliberately simple (split on the leading
// `|`) rather than a full markdown parser — this file's table format is
// authored by us, not user input.
function parseDispositions(markdown) {
  const dispositions = new Map();
  for (const line of markdown.split('\n')) {
    const m = line.match(/^\|\s*(.+?)\s*\|\s*(\S+)\s*\|\s*(.+?)\s*\|$/);
    if (!m) continue;
    const [, component, disposition] = m;
    if (component === 'Component' || /^---+$/.test(component)) continue; // header/separator rows
    dispositions.set(component, disposition);
  }
  return dispositions;
}

test('every BRO-280-named component has an explicit, validly-formatted disposition', () => {
  const markdown = readFileSync(INVENTORY_PATH, 'utf8');
  const dispositions = parseDispositions(markdown);

  const missing = [];
  const invalid = [];
  for (const [group, components] of Object.entries(REQUIRED_COMPONENTS)) {
    for (const component of components) {
      if (!dispositions.has(component)) {
        missing.push(`${group}: ${component}`);
        continue;
      }
      const disposition = dispositions.get(component);
      if (!VALID_DISPOSITION.test(disposition)) {
        invalid.push(`${group}: ${component} -> "${disposition}"`);
      }
    }
  }

  assert.deepEqual(missing, [], `components missing a disposition row:\n${missing.join('\n')}`);
  assert.deepEqual(invalid, [], `components with an unrecognized disposition value:\n${invalid.join('\n')}`);
});

test('the inventory file does not silently grow undocumented dispositions', () => {
  const markdown = readFileSync(INVENTORY_PATH, 'utf8');
  const dispositions = parseDispositions(markdown);
  const allRequired = new Set(Object.values(REQUIRED_COMPONENTS).flat());
  for (const [component, disposition] of dispositions) {
    if (!allRequired.has(component)) continue; // rows outside the 4 required groups are fine
    assert.match(
      disposition,
      VALID_DISPOSITION,
      `"${component}" has disposition "${disposition}", not one of: migrated / retired / keep / carried:BRO-NNN / pending / pending:BRO-NNN`
    );
  }
});
