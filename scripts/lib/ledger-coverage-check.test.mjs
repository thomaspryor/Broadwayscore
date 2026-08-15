import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  findLedgerScripts,
  findMissingLedgerCommits,
} = require('./ledger-coverage-check.js');

// --- YAML-level tests (findMissingLedgerCommits) — synthetic ledgerScripts
// set, no filesystem/AST involvement, mirrors alert-ledger-commit-check.test.mjs ---

const LEDGER_SCRIPTS = new Set(['audit-foo.js']);

const MISSING_COMMIT_FIXTURE = `name: Bad Example
on:
  push:
jobs:
  broken:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: node scripts/audit-foo.js
      - name: Commit other stuff
        run: |
          git add data/audit/some-other-file.json
          git commit -m 'x'
`;

const DIRECT_COMMIT_FIXTURE = `name: Good Example (direct git add)
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: node scripts/audit-foo.js
      - name: Commit
        run: |
          git add data/audit/scraper-spend-ledger.jsonl 2>/dev/null || true
          git commit -m 'x'
`;

const LOOP_COMMIT_FIXTURE = `name: Good Example (for-loop staging)
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: node scripts/audit-foo.js
      - name: Commit
        run: |
          for f in data/audit/foo.json data/audit/scraper-spend-ledger.jsonl; do
            [ -e "$f" ] && git add "$f" || echo "skip: $f"
          done
          git commit -m 'x'
`;

const MULTILINE_LOOP_COMMIT_FIXTURE = `name: Good Example (backslash-continued for-loop)
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: node scripts/audit-foo.js
      - name: Commit
        run: |
          for f in data/audit/foo.json \\
                   data/audit/bar.json \\
                   data/audit/scraper-spend-ledger.jsonl; do
            [ -e "$f" ] && git add "$f" || echo "skip: $f"
          done
          git commit -m 'x'
`;

const STAGE_HELPER_DIR_FIXTURE = `name: Good Example (stage-data-changes.sh with a covering dir arg)
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: node scripts/audit-foo.js
      - name: Commit
        run: |
          bash scripts/lib/stage-data-changes.sh data/audit/
          git commit -m 'x'
`;

const STAGE_HELPER_NO_ARGS_FIXTURE = `name: Good Example (stage-data-changes.sh with no args stages all of data/)
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: node scripts/audit-foo.js
      - name: Commit
        run: |
          bash scripts/lib/stage-data-changes.sh
          git commit -m 'x'
`;

const STAGE_HELPER_NON_COVERING_FIXTURE = `name: Bad Example (stage-data-changes.sh with an unrelated arg)
on:
  push:
jobs:
  broken:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: node scripts/audit-foo.js
      - name: Commit
        run: |
          bash scripts/lib/stage-data-changes.sh public/images/shows/
          git commit -m 'x'
`;

const DIRECT_ADD_DIR_FIXTURE = `name: Good Example (bare git add of a covering directory)
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: node scripts/audit-foo.js
      - name: Commit
        run: |
          git add data/audit/ data/collection-state/ || true
          git commit -m 'x'
`;

const DIRECT_ADD_GLOB_FIXTURE = `name: Bad Example (glob that does not cover the .jsonl ledger)
on:
  push:
jobs:
  broken:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: node scripts/audit-foo.js
      - name: Commit
        run: |
          git add data/audit/*.json 2>/dev/null || true
          git commit -m 'x'
`;

const COMPOSITE_ACTION_FIXTURE = `name: Good Example (composite action wraps the git add)
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: node scripts/audit-foo.js
      - name: Commit scraper-spend ledger
        if: always()
        continue-on-error: true
        uses: ./.github/actions/commit-scraper-spend-ledger
        with:
          workflow-name: audit-foo
`;

const NO_LEDGER_CALLER_FIXTURE = `name: Irrelevant workflow
on:
  push:
jobs:
  unrelated:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: node scripts/some-other-script.js
`;

test('flags a job that invokes a ledger-reaching script with no commit step', () => {
  const violations = findMissingLedgerCommits(MISSING_COMMIT_FIXTURE, LEDGER_SCRIPTS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].job, 'broken');
  assert.match(violations[0].message, /scraper-spend-ledger\.jsonl/);
});

test('does not flag a job with a direct git add of the ledger file', () => {
  assert.deepEqual(findMissingLedgerCommits(DIRECT_COMMIT_FIXTURE, LEDGER_SCRIPTS), []);
});

test('does not flag a job that stages the ledger file via a for-loop', () => {
  assert.deepEqual(findMissingLedgerCommits(LOOP_COMMIT_FIXTURE, LEDGER_SCRIPTS), []);
});

test('does not flag a job whose for-loop file list is backslash-continued across lines', () => {
  assert.deepEqual(findMissingLedgerCommits(MULTILINE_LOOP_COMMIT_FIXTURE, LEDGER_SCRIPTS), []);
});

test('ignores workflows that never invoke a ledger-reaching script', () => {
  assert.deepEqual(findMissingLedgerCommits(NO_LEDGER_CALLER_FIXTURE, LEDGER_SCRIPTS), []);
});

// Real bug found in ship-check review (2026-08-04): recover-explicit-ratings.yml
// stages via `bash scripts/lib/stage-data-changes.sh data/audit/`, which a
// plain text search for `git add <ledger-file>` doesn't recognize.
test('does not flag a job that stages the ledger file via stage-data-changes.sh with a covering dir arg', () => {
  assert.deepEqual(findMissingLedgerCommits(STAGE_HELPER_DIR_FIXTURE, LEDGER_SCRIPTS), []);
});

test('does not flag a job that stages via stage-data-changes.sh with no args (stages all of data/)', () => {
  assert.deepEqual(findMissingLedgerCommits(STAGE_HELPER_NO_ARGS_FIXTURE, LEDGER_SCRIPTS), []);
});

test('still flags a job whose stage-data-changes.sh call only covers an unrelated path', () => {
  const violations = findMissingLedgerCommits(STAGE_HELPER_NON_COVERING_FIXTURE, LEDGER_SCRIPTS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].job, 'broken');
});

// Real gap found in BRO-163's pre-implementation review: several workflows
// (collect-review-texts.yml, collect-free-reviews.yml, collect-soft-paywall.yml,
// collect-hard-paywall.yml, overnight-collect.yml) stage the ledger via a bare
// `git add data/audit/` directory add, not the literal filename or the
// stage-data-changes.sh helper — a LEDGER_FILE substring search missed all of
// them.
test('does not flag a job that stages the ledger file via a bare directory git add', () => {
  assert.deepEqual(findMissingLedgerCommits(DIRECT_ADD_DIR_FIXTURE, LEDGER_SCRIPTS), []);
});

// opening-night-express.yml stages via `git add data/audit/*.json`, which does
// NOT cover the ledger's `.jsonl` extension — must stay flagged, not be
// swallowed by the new directory-add recognition.
test('still flags a job whose git add is a glob that does not cover the .jsonl ledger', () => {
  const violations = findMissingLedgerCommits(DIRECT_ADD_GLOB_FIXTURE, LEDGER_SCRIPTS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].job, 'broken');
});

// BRO-163: a job that `uses:` the reusable commit-scraper-spend-ledger
// composite action counts as staging the ledger, even though the actual
// `git add` line lives inside the action file, not the calling workflow.
test('does not flag a job that uses the commit-scraper-spend-ledger composite action', () => {
  assert.deepEqual(findMissingLedgerCommits(COMPOSITE_ACTION_FIXTURE, LEDGER_SCRIPTS), []);
});

// --- AST-level tests (findLedgerScripts) — real fixture files on disk, since
// the acorn walk reads scripts/*.js from a directory ---

function withFixtureScripts(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-coverage-fixture-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const abs = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('flags a script that directly calls serpQuery from url-discovery.js', () => {
  withFixtureScripts(
    {
      'lib/url-discovery.js': `
        function serpQuery(q) { return q; }
        module.exports = { serpQuery };
      `,
      'direct-caller.js': `#!/usr/bin/env node
        const { serpQuery } = require('./lib/url-discovery');
        async function main() { await serpQuery('x'); }
        main();
      `,
    },
    (dir) => {
      const found = findLedgerScripts(dir);
      assert.ok(found.has('direct-caller.js'), 'expected direct-caller.js to be flagged');
    }
  );
});

test('does NOT flag a script that only imports a data constant from url-discovery.js (no call)', () => {
  // Mirrors the real rebuild-all-reviews.js false-positive: destructuring
  // OUTLET_DOMAINS/REGISTRY_DOMAIN_ALIASES is not a call.
  withFixtureScripts(
    {
      'lib/url-discovery.js': `
        const OUTLET_DOMAINS = { nyt: 'nytimes.com' };
        function serpQuery(q) { return q; }
        module.exports = { OUTLET_DOMAINS, serpQuery };
      `,
      'data-only-caller.js': `#!/usr/bin/env node
        const { OUTLET_DOMAINS } = require('./lib/url-discovery');
        console.log(OUTLET_DOMAINS.nyt);
      `,
    },
    (dir) => {
      const found = findLedgerScripts(dir);
      assert.ok(!found.has('data-only-caller.js'), 'data-only import must not be flagged');
    }
  );
});

test('flags a script that calls a wrapper function which itself calls serpQuery (transitive)', () => {
  // Mirrors audit-closing-dates.js -> closing-date-discovery.js's
  // discoverAnnouncedClosingDate -> discoverAnnouncedDate -> serpQuery.
  withFixtureScripts(
    {
      'lib/url-discovery.js': `
        function serpQuery(q) { return q; }
        module.exports = { serpQuery };
      `,
      'lib/wrapper.js': `
        const { serpQuery } = require('./url-discovery');
        async function innerDiscover(q) { return serpQuery(q); }
        async function outerDiscover(q) { return innerDiscover(q); }
        module.exports = { outerDiscover };
      `,
      'transitive-caller.js': `#!/usr/bin/env node
        const { outerDiscover } = require('./lib/wrapper');
        async function main() { await outerDiscover('x'); }
        main();
      `,
    },
    (dir) => {
      const found = findLedgerScripts(dir);
      assert.ok(found.has('transitive-caller.js'), 'expected transitive-caller.js to be flagged via the wrapper chain');
    }
  );
});

test('flags a script using assignment-form destructured require (lazy try/catch require pattern)', () => {
  // Real bug found in ship-check review (2026-08-04): recover-explicit-ratings.js
  // declares `let discoverCorrectUrl;` then binds it via
  // `({ discoverCorrectUrl } = require('./lib/url-discovery'))` inside a
  // try/catch — an AssignmentExpression, not a VariableDeclarator. The
  // original collectBindings() only recognized `const {x} = require(...)`
  // and silently missed this real SERP-calling script entirely.
  withFixtureScripts(
    {
      'lib/url-discovery.js': `
        function serpQuery(q) { return q; }
        module.exports = { serpQuery };
      `,
      'lazy-require-caller.js': `#!/usr/bin/env node
        let serpQuery;
        try {
          ({ serpQuery } = require('./lib/url-discovery'));
        } catch (err) {
          console.log('unavailable');
        }
        async function main() { await serpQuery('x'); }
        main();
      `,
    },
    (dir) => {
      const found = findLedgerScripts(dir);
      assert.ok(found.has('lazy-require-caller.js'), 'expected lazy-require-caller.js to be flagged');
    }
  );
});

test('does not flag a script that only requires scraper.js (out of scope — see check header comment)', () => {
  withFixtureScripts(
    {
      'lib/scraper.js': `
        async function fetchPage(url) { return url; }
        module.exports = { fetchPage };
      `,
      'plain-scraper.js': `#!/usr/bin/env node
        const { fetchPage } = require('./lib/scraper');
        async function main() { await fetchPage('http://x'); }
        main();
      `,
    },
    (dir) => {
      const found = findLedgerScripts(dir);
      assert.ok(!found.has('plain-scraper.js'), 'scraper.js callers are intentionally out of scope');
    }
  );
});
