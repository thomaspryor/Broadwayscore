// BRO-277: the email-intake channel (~/.claude-email-worker/poll.py's
// escalate_to_dispatch(), the only site that mints an `em-*` marker and
// creates a card for a dispatched email ask) was repointed from Notion to
// Linear under BRO-377. This test exists so a future edit that reintroduces
// a `notion-brain.js create` call in that path — or a docs-only "we repointed
// it" claim that was never actually true — fails CI instead of silently
// drifting, the same trap the transition-inventory doc's two stale `pending`
// rows sat in for weeks (BRO-384 retired the Notion action poller and BRO-377
// repointed the worker; neither update touched the doc, so it kept asserting
// "not repointed" for both after both already were).
//
// poll.py lives outside this repo (~/.claude-email-worker is not a git
// checkout — verified: `git rev-parse --show-toplevel` there fails). A test
// that skips whenever that path is missing would be exactly the silent-green
// trap scripts/lib/aggregator-domain-tld-parity.test.mjs's own comment warns
// against ("a silent skip would make 'this is green' mean 'it never ran'"),
// so the poll.py-dependent assertions below use t.skip() ONLY on this narrow,
// genuinely machine-local file, and the in-repo assertions (the transition
// inventory doc, the retired poller) always run regardless of machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INVENTORY_PATH = join(REPO, 'notion-linear-transition-inventory.md');
const POLLER_PATH = join(REPO, 'scripts', 'notion-action-poll.js');
const WORKER_PATH = join(homedir(), '.claude-email-worker', 'poll.py');

function stripPyComments(src) {
  // Good enough for our own authored file: strip '#' line comments and
  // triple-quoted docstrings, which is where the stale claims lived.
  return src
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/'''[\s\S]*?'''/g, '')
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
}

test('the transition inventory records both intake-channel components as no longer pending', () => {
  const markdown = readFileSync(INVENTORY_PATH, 'utf8');
  const emailWorkerRow = markdown.split('\n').find((l) => l.includes('claude-email-worker/poll.py'));
  const pollerRow = markdown.split('\n').find((l) => l.includes('scripts/notion-action-poll.js'));
  assert.ok(emailWorkerRow, 'email worker row must still exist in the inventory');
  assert.ok(pollerRow, 'notion action poller row must still exist in the inventory');
  assert.match(emailWorkerRow, /\|\s*migrated\s*\|/, 'email worker must be marked migrated, not pending');
  assert.match(pollerRow, /\|\s*retired\s*\|/, 'notion action poller must be marked retired, not pending');
});

test('the retired notion action poller cannot reach the Notion API (structural, in-repo)', () => {
  const src = readFileSync(POLLER_PATH, 'utf8');
  assert.match(src, /NOTION_POLLER_ALLOWED/, 'retirement guard must still exist');
  // Full behavioral coverage (exit code 7, --help, --card can't bypass it)
  // lives in notion-action-poll-retired.test.mjs — this is just a tripwire
  // so THIS file also fails if the guard is ever deleted, without duplicating
  // that file's subprocess-spawning assertions.
});

test('escalate_to_dispatch creates via Linear, not Notion (machine-local)', (t) => {
  if (!existsSync(WORKER_PATH)) {
    t.skip(`~/.claude-email-worker/poll.py not present on this machine (${WORKER_PATH}) — this is local, unversioned infra, not repo code`);
    return;
  }
  const src = stripPyComments(readFileSync(WORKER_PATH, 'utf8'));
  const fnStart = src.indexOf('def escalate_to_dispatch(');
  assert.ok(fnStart > 0, 'escalate_to_dispatch() must still exist — it is the only em-* card-creation site');
  const nextDefIdx = src.indexOf('\ndef ', fnStart + 1);
  const fnBody = nextDefIdx > 0 ? src.slice(fnStart, nextDefIdx) : src.slice(fnStart);

  assert.match(fnBody, /linear-brain\.js.*create/s, 'card creation must go through linear-brain.js create');
  assert.doesNotMatch(fnBody, /notion-brain\.js.*create/s, 'card creation must NOT go through notion-brain.js create');
  assert.match(fnBody, /linear-next\.js/, 'dispatch must go through linear-next.js');
  assert.doesNotMatch(fnBody, /notion-action-poll\.js/, 'dispatch must not route through the retired notion-action-poll.js');
});

test('no other function in poll.py creates a Notion card for email intake (machine-local)', (t) => {
  if (!existsSync(WORKER_PATH)) {
    t.skip(`~/.claude-email-worker/poll.py not present on this machine (${WORKER_PATH})`);
    return;
  }
  const src = stripPyComments(readFileSync(WORKER_PATH, 'utf8'));
  assert.doesNotMatch(
    src,
    /notion-brain\.js["']?\s*,?\s*["']?create/,
    'no code path in the email worker may create a Notion card — the only creation site (escalate_to_dispatch) must use linear-brain.js'
  );
});
