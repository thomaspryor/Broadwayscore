// scripts/tests/notion-write-paths-retired.test.mjs
//
// Acceptance test for BRO-3430 — three live code paths still wrote to the
// retired Notion board (CLAUDE.md §6, mirror frozen 2026-08-20):
//   (a) posthog-friction-analyzer.js called @notionhq/client's
//       `.pages.create()` directly, bypassing notion-brain.js's exit-6
//       read-only guard entirely.
//   (b) audit-opening-dates.js shelled out to a board CLI to file its audit
//       card but never checked the child's exit status, so a refused/failed
//       create silently never appeared and the job still went green.
//   (c) notion-brain.js's `update` command has no guard and (before this
//       fix) no documented reason for staying open next to `create`'s.
//
// Per CLAUDE.md rule 15 this require()s the real detection functions from
// scripts/lib/notion-write-paths-audit.js rather than restating the regexes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globSync } from 'glob';

const require = createRequire(import.meta.url);
const {
  createsNotionPagesDirectly,
  swallowsChildExit,
  updateCommandDocumentsExemption,
} = require('../lib/notion-write-paths-audit.js');

const ROOT = join(import.meta.dirname, '..', '..');

describe('(a) no script outside notion-brain.js creates Notion pages directly', () => {
  test('the real scripts/ tree is clean (no direct .pages.create() bypass)', () => {
    const files = globSync('scripts/**/*.{js,mjs}', { cwd: ROOT, nodir: true })
      .filter((f) => !f.includes('node_modules'))
      .filter((f) => f !== 'scripts/notion-brain.js') // the one allowed chokepoint
      .filter((f) => !/\.test\.(js|mjs)$/.test(f)) // fixtures in test files mimic violations on purpose
      .map((f) => join(ROOT, f));
    assert.ok(files.length > 200, `expected a substantial scripts/ tree, found ${files.length} files`);

    const violations = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (createsNotionPagesDirectly(source)) violations.push(file.slice(ROOT.length + 1));
    }
    assert.deepEqual(violations, [], `expected zero direct-create bypasses, got ${JSON.stringify(violations)}`);
  });

  test('notion-brain.js itself still counts as creating pages (sanity — detector is not inert)', () => {
    const source = readFileSync(join(ROOT, 'scripts/notion-brain.js'), 'utf8');
    assert.equal(createsNotionPagesDirectly(source), true);
  });

  test('the old posthog-friction-analyzer.js pattern (direct @notionhq/client pages.create) is detected', () => {
    const fixture = `
      const { Client: NotionClient } = require('@notionhq/client');
      async function createNotionCard(notion, issue) {
        const page = await notion.pages.create({ parent: {}, properties: {} });
        return page.url;
      }
    `;
    assert.equal(createsNotionPagesDirectly(fixture), true);
  });

  test('a file that only reads/updates Notion (no pages.create) is not flagged', () => {
    const fixture = `
      const { Client } = require('@notionhq/client');
      async function readOnly(notion) {
        return notion.pages.retrieve({ page_id: 'x' });
      }
    `;
    assert.equal(createsNotionPagesDirectly(fixture), false);
  });
});

describe('(b) audit-opening-dates.js asserts the child exit rather than swallowing it', () => {
  const source = readFileSync(join(ROOT, 'scripts/audit-opening-dates.js'), 'utf8');

  test('files through linear-brain.js, not notion-brain.js', () => {
    assert.match(source, /linear-brain\.js/);
    assert.doesNotMatch(source, /notion-brain\.js/);
  });

  test('every spawnSync .status guard in the file throws on failure', () => {
    assert.equal(swallowsChildExit(source), false);
  });

  test('the original swallowed-exit shape (console.warn, no throw) is detected as a violation', () => {
    const fixture = `
      const create = spawnSync('node', [brain, 'create', title], { encoding: 'utf8' });
      if (create.status === 0) {
        console.log('created');
      } else {
        console.warn('Notion: create failed:', create.stderr);
      }
    `;
    assert.equal(swallowsChildExit(fixture), true);
  });

  test('a fixed !== 0 guard that throws is not flagged', () => {
    const fixture = `
      const create = spawnSync('node', [brain, 'create', title], { encoding: 'utf8' });
      if (create.status !== 0) {
        throw new Error('create failed: ' + create.stderr);
      }
    `;
    assert.equal(swallowsChildExit(fixture), false);
  });

  test('a swallowed failure hidden behind a NESTED brace is still caught (non-greedy regex would truncate at the first inner "}")', () => {
    const fixture = `
      const create = spawnSync('node', [brain, 'create', title], { encoding: 'utf8' });
      if (create.status !== 0) {
        if (verbose) {
          console.error('debug: create failed');
        }
        console.warn('real problem, still swallowed');
      }
    `;
    assert.equal(swallowsChildExit(fixture), true);
  });

  test('a throw behind a nested brace is correctly recognized as handled', () => {
    const fixture = `
      const create = spawnSync('node', [brain, 'create', title], { encoding: 'utf8' });
      if (create.status !== 0) {
        if (someCondition) {
          logExtra();
        }
        throw new Error('create failed: ' + create.stderr);
      }
    `;
    assert.equal(swallowsChildExit(fixture), false);
  });

  test('a file with multiple guards flags a violation even if a later guard is fine', () => {
    const fixture = `
      if (dedup.status !== 0) {
        throw new Error('dedup failed');
      }
      if (create.status !== 0) {
        console.warn('create failed, oh well');
      }
    `;
    assert.equal(swallowsChildExit(fixture), true);
  });
});

describe('audit-closing-dates.js — the sibling job with the identical bug (found during BRO-3430 review)', () => {
  const source = readFileSync(join(ROOT, 'scripts/audit-closing-dates.js'), 'utf8');

  test('files through linear-brain.js, not notion-brain.js', () => {
    assert.match(source, /linear-brain\.js/);
    assert.doesNotMatch(source, /notion-brain\.js/);
  });

  test('every spawnSync .status guard in the file throws on failure', () => {
    assert.equal(swallowsChildExit(source), false);
  });
});

describe('(c) notion-brain.js update either refuses or documents its exemption', () => {
  test('the real file passes', () => {
    const source = readFileSync(join(ROOT, 'scripts/notion-brain.js'), 'utf8');
    assert.equal(updateCommandDocumentsExemption(source), true);
  });

  test('an update command with neither a guard nor a documenting comment fails', () => {
    const fixture = `
      // some unrelated comment
      async function updateCard(args) {
        const pageId = args._positional[1];
      }
    `;
    assert.equal(updateCommandDocumentsExemption(fixture), false);
  });

  test('an update command guarded like create passes', () => {
    const fixture = `
      async function updateCard(args) {
        const writeVerdict = notionCreateVerdict(process.env);
        if (!writeVerdict.allowed) process.exit(6);
      }
    `;
    assert.equal(updateCommandDocumentsExemption(fixture), true);
  });
});
