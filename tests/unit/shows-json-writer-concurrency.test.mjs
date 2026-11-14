// BRO-5574: backfill-playwright-credits.yml read-mutate-writes the shows catalog
// (scripts/backfill-playwright-credits.js saveShows + per-N-shows CI checkpoint pushes),
// so it must serialize with the other shows.json writers in the shared group.
//
// BRO-5803: generalized. Every workflow that runs a shows.json-writing script and
// pushes core data (./.github/actions/push-core-data) must either sit in the
// `shows-json-writer` concurrency group with cancel-in-progress: false, or carry a
// `# shows-json-writer-exempt: <reason>` line explaining why not. GitHub keeps ONE
// pending run per group, so long, frequent or per-event workflows stay out on
// purpose (push-core-data's rebase + reconcileShowsJson merge is their safety net).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const { loadWorkflows } = require(join(root, 'scripts/lib/workflow-dependency-graph.js'));

const GROUP = 'shows-json-writer';
const EXEMPT_ANNOTATION = /^\s*#\s*shows-json-writer-exempt:\s*(.*)$/m;
const WRITES_SHOWS = /showsWriteGuard\.saveShows|saveShows\(\s*[a-z]/;
const PUSHES_CORE_DATA = /uses:\s*\.\/\.github\/actions\/push-core-data\b/;

// Scripts that match WRITES_SHOWS but are not treated as shows.json writers here.
const NOT_WRITERS = {
  // The write primitive itself: its saveShows() definition matches the regex,
  // and requiring it does not make a script a writer.
  'scripts/lib/shows-write-guard.js': 'defines saveShows; importers are checked on their own call sites',
  // Runs in ~25 workflows as a validation gate. Its auto-fixes (stale previews ->
  // open, slug/venue normalization) are idempotent and every run reproduces them,
  // so a fix lost to a concurrent push is re-applied by the next validate step.
  'scripts/validate-data.js': 'idempotent auto-normalizations, re-applied by every validate run',
};

const wfDir = join(root, '.github', 'workflows');
const workflows = loadWorkflows(wfDir);
const rawOf = (file) => readFileSync(join(wfDir, file), 'utf8');

function isShowsWriter(script, seen = new Set()) {
  if (NOT_WRITERS[script] || seen.has(script) || !existsSync(join(root, script))) return false;
  seen.add(script);
  const src = read(script);
  if (WRITES_SHOWS.test(src)) return true;
  // One level of local lib requires: bww-roundup-persistence.js / show-id-rename.js
  // save shows.json on behalf of the script that calls them.
  if (script.startsWith('scripts/lib/')) return false;
  for (const m of src.matchAll(/require\(\s*['"]\.\/lib\/([\w.-]+?)(?:\.js)?['"]\s*\)/g)) {
    if (isShowsWriter(`scripts/lib/${m[1]}.js`, seen)) return true;
  }
  return false;
}

function writerScriptsIn(raw) {
  const scripts = new Set([...raw.matchAll(/\bnode\s+(scripts\/[\w./-]+\.(?:c?js|mjs))/g)].map((m) => m[1]));
  return [...scripts].filter((s) => isShowsWriter(s)).sort();
}

const inGroup = (w) => w.concurrency.some((c) => c.group.includes(GROUP));

test('backfill script still writes shows.json (premise of the shared group)', () => {
  assert.match(read('scripts/backfill-playwright-credits.js'), /saveShows\(\s*[a-z]/);
});

test('backfill-playwright-credits.yml is in the shows-json-writer concurrency group', () => {
  const m = read('.github/workflows/backfill-playwright-credits.yml').match(/^concurrency:\s*\n(?:[ \t]+#.*\n)*[ \t]+group:\s*(\S+)\s*\n(?:\s*\n)*[ \t]+cancel-in-progress:\s*(\S+)/m);
  assert.ok(m, 'top-level concurrency block missing');
  assert.equal(m[1], 'shows-json-writer');
  assert.equal(m[2], 'false');
});

test('scan finds known writers (guards against a scan that silently matches nothing)', () => {
  const byFile = Object.fromEntries(workflows.map((w) => [w.file, writerScriptsIn(rawOf(w.file))]));
  assert.ok(byFile['update-show-status.yml'].includes('scripts/update-show-status.js'));
  assert.ok(byFile['enrich-west-end-dates.yml'].includes('scripts/enrich-west-end-dates.js'));
  // Library-mediated writer: opening-night-poller.js saves via bww-roundup-persistence.js.
  assert.ok(byFile['opening-night-poller.yml'].includes('scripts/opening-night-poller.js'));
  assert.ok(!byFile['update-show-status.yml'].includes('scripts/validate-data.js'));
});

test('every core-data-pushing shows.json writer is in the group or annotated exempt', () => {
  const problems = [];
  for (const w of workflows) {
    const raw = rawOf(w.file);
    const exempt = raw.match(EXEMPT_ANNOTATION);
    const writers = PUSHES_CORE_DATA.test(raw) ? writerScriptsIn(raw) : [];
    if (writers.length === 0) {
      if (exempt) problems.push(`${w.file}: stale shows-json-writer-exempt (no longer runs a shows.json writer that pushes core data)`);
      continue;
    }
    if (inGroup(w)) {
      if (exempt) problems.push(`${w.file}: in ${GROUP} AND annotated exempt; drop the annotation`);
      continue;
    }
    if (!exempt) {
      problems.push(`${w.file}: runs ${writers.join(', ')} and pushes core data, but is not in the ${GROUP} concurrency group. Join it (cancel-in-progress: false) or add "# shows-json-writer-exempt: <reason>" in its concurrency block.`);
    } else if (exempt[1].trim().length < 15) {
      problems.push(`${w.file}: shows-json-writer-exempt needs a real reason (got "${exempt[1].trim()}")`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every shows-json-writer member queues instead of cancelling siblings', () => {
  const bad = [];
  for (const w of workflows) {
    for (const c of w.concurrency) {
      if (c.group.includes(GROUP) && c.cancelRaw !== 'false') bad.push(`${w.file} (${c.level}): cancel-in-progress ${c.cancelRaw}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('NOT_WRITERS entries still exist and still match the writer regex', () => {
  for (const [script, reason] of Object.entries(NOT_WRITERS)) {
    assert.ok(existsSync(join(root, script)), `${script} is gone; drop it from NOT_WRITERS`);
    assert.match(read(script), WRITES_SHOWS, `${script} no longer matches; drop it from NOT_WRITERS`);
    assert.ok(reason.length >= 15);
  }
});
