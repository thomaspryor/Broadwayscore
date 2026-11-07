// rename-show-ids-batch (BRO-4315, 2026 data audit S8-T1).
//
// The pure checks (batch shape, per-pair state, end-state verify) plus one
// end-to-end run of the CLI against a temp three-tree fixture: dry run writes
// nothing, --apply renames and resumes cleanly on a second run, and a bad pair
// refuses the whole batch before anything is written. Requires the real
// modules (CLAUDE.md §15); never touches data/ or the private repos.
//
// Run: node --test tests/unit/rename-show-ids-batch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { batchProblems, pairState, verifyShows, MAX_PAIRS } = require('../../scripts/rename-show-ids-batch.js');
const { planShowIdRename } = require('../../scripts/lib/show-id-rename.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'scripts', 'rename-show-ids-batch.js');
const OLD = 'fixture-play-west-end-2026';
const NEW = 'fixture-play-off-west-end-2026';
const OTHER = 'other-play-west-end-2025';
const pair = { oldId: OLD, newId: NEW, expectTitle: 'Fixture Play' };
const row = (over = {}) => ({ id: OLD, title: 'Fixture Play', slug: OLD, category: 'off-west-end', ...over });

function writeJson(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
}

function buildFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-batch-'));
  const web = path.join(base, 'web');
  const core = path.join(base, 'core-data');
  const rt = path.join(base, 'review-texts');
  writeJson(path.join(core, 'shows.json'), {
    _meta: { lastUpdated: '2026-10-01T00:00:00.000Z', totalShows: 2 },
    shows: [
      { ...row(), venue: 'Fixture Fringe', status: 'open', openingDate: '2026-05-01', images: { hero: `/images/shows/${OLD}/hero.webp` } },
      { id: OTHER, title: 'Other Play', slug: OTHER, category: 'west-end', venue: 'Big House', status: 'closed', openingDate: '2025-01-01' },
    ],
  });
  writeJson(path.join(core, 'reviews.json'), { _meta: {}, reviews: [{ showId: OLD, outletId: 'guardian', assignedScore: 70 }] });
  writeJson(path.join(web, 'data', 'related-shows.json'), { _meta: {}, shows: { [OLD]: { relatedIds: [OTHER], relatedOpenIds: [] }, [OTHER]: { relatedIds: [OLD], relatedOpenIds: [OLD] } } });
  fs.mkdirSync(path.join(web, 'public', 'images', 'shows', OLD), { recursive: true });
  fs.writeFileSync(path.join(web, 'public', 'images', 'shows', OLD, 'hero.webp'), 'img');
  writeJson(path.join(rt, OLD, 'guardian--critic.json'), { showId: OLD, outletId: 'guardian', url: 'https://example.com/r' });
  execFileSync('git', ['init', '-q'], { cwd: rt });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A'], { cwd: rt });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init'], { cwd: rt });
  const batch = path.join(base, 'batch.json');
  writeJson(batch, { card: 'BRO-4315', reason: 'test', renames: [pair] });
  return { base, web, core, rt, batch };
}

const run = (f, extra = []) => spawnSync(process.execPath, [CLI, `--batch=${f.batch}`, `--core-data=${f.core}`, `--review-texts=${f.rt}`, `--web=${f.web}`, ...extra], { encoding: 'utf8' });
const shows = (f) => JSON.parse(fs.readFileSync(path.join(f.core, 'shows.json'), 'utf8')).shows;

test('batchProblems: shape, size, duplicates', () => {
  assert.deepEqual(batchProblems({ card: 'BRO-4315', reason: 'r', renames: [pair] }), []);
  assert.ok(batchProblems({ card: 'x', reason: 'r', renames: [pair] }).some((p) => /card/.test(p)));
  assert.ok(batchProblems({ card: 'BRO-1', reason: '', renames: [pair] }).some((p) => /reason/.test(p)));
  assert.ok(batchProblems({ card: 'BRO-1', reason: 'r', renames: [] }).some((p) => /non-empty/.test(p)));
  assert.ok(batchProblems({ card: 'BRO-1', reason: 'r', renames: [pair, pair] }).some((p) => /twice/.test(p)));
  const many = Array.from({ length: MAX_PAIRS + 1 }, (_, i) => ({ oldId: `a-${i}-west-end`, newId: `a-${i}-off-west-end`, expectTitle: 't' }));
  assert.ok(batchProblems({ card: 'BRO-1', reason: 'r', renames: many }).some((p) => /at most/.test(p)));
});

test('pairState: pending, resume, refusals', () => {
  assert.equal(pairState(pair, [row()]).state, 'pending');
  assert.equal(pairState(pair, [row({ id: NEW, aliases: [OLD] })]).state, 'resume');
  assert.match(pairState(pair, [row({ id: NEW })]).problem, /not a resumable/);
  assert.match(pairState(pair, [row(), row({ id: NEW })]).problem, /both/);
  // A merge re-added the old row beside its renamed twin: resumable.
  assert.equal(pairState(pair, [row(), row({ id: NEW, aliases: [OLD] })]).state, 'reappeared');
  assert.match(pairState(pair, [row({ title: 'Edited' }), row({ id: NEW, aliases: [OLD] })]).problem, /re-added old row/);
  assert.match(pairState(pair, [row({ title: 'Other' })]).problem, /title/);
  assert.match(pairState(pair, [row({ category: 'west-end' })]).problem, /already agrees/);
  assert.match(pairState({ ...pair, newId: 'fixture-play-2026' }, [row()]).problem, /still disagree/);
  assert.match(pairState(pair, []).problem, /no row/);
});

test('verifyShows: end state', () => {
  assert.deepEqual(verifyShows([pair], [row({ id: NEW, slug: NEW, aliases: [OLD] })]), []);
  assert.ok(verifyShows([pair], [row(), row({ id: NEW, aliases: [OLD] })]).some((p) => /old id/.test(p)));
  assert.ok(verifyShows([pair], [row({ id: NEW, aliases: [OLD] }), row({ id: NEW, aliases: [OLD] })]).some((p) => /exactly 1/.test(p)));
  assert.ok(verifyShows([pair], [row({ id: NEW, slug: 's', aliases: [OLD] }), { id: 'x', slug: 's' }]).some((p) => /shared/.test(p)));
  assert.ok(verifyShows([pair], [row({ id: NEW, aliases: [] })]).some((p) => /aliases lost/.test(p)));
});

test('scanResidual:false skips the residual scan', () => {
  const f = buildFixture();
  writeJson(path.join(f.web, 'data', 'unregistered-notes.json'), { note: `mentions ${OLD}` });
  const trees = { web: f.web, coreData: f.core, reviewTexts: f.rt, scanCode: false };
  assert.ok(planShowIdRename(OLD, NEW, trees).residual.length > 0);
  assert.equal(planShowIdRename(OLD, NEW, { ...trees, scanResidual: false }).residual.length, 0);
});

test('CLI: dry run writes nothing, apply renames, rerun resumes clean', () => {
  const f = buildFixture();
  const before = fs.readFileSync(path.join(f.core, 'shows.json'), 'utf8');
  assert.equal(run(f, ['--check']).status, 1, '--check fails before the rename');
  const dry = run(f);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run: 1 pair/);
  assert.equal(fs.readFileSync(path.join(f.core, 'shows.json'), 'utf8'), before);

  const app = run(f, ['--apply']);
  assert.equal(app.status, 0, app.stdout + app.stderr);
  const s = shows(f);
  const renamed = s.find((x) => x.id === NEW);
  assert.ok(renamed && !s.some((x) => x.id === OLD));
  assert.equal(renamed.slug, NEW, 'slug === old id moves with the id');
  assert.ok(renamed.aliases.includes(OLD));
  assert.ok(fs.existsSync(path.join(f.rt, NEW, 'guardian--critic.json')));
  assert.ok(!fs.existsSync(path.join(f.rt, OLD)));
  assert.ok(fs.existsSync(path.join(f.web, 'public', 'images', 'shows', NEW, 'hero.webp')));
  const rel = JSON.parse(fs.readFileSync(path.join(f.web, 'data', 'related-shows.json'), 'utf8')).shows;
  assert.deepEqual(rel[OTHER].relatedIds, [NEW]);
  assert.match(app.stdout, /UPDATE/);

  const again = run(f, ['--apply']);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /resume/);
  const chk = run(f, ['--check']);
  assert.equal(chk.status, 0, chk.stderr);
  // A concurrent web writer re-adding the old key fails the check.
  const relPath = path.join(f.web, 'data', 'related-shows.json');
  const doc = JSON.parse(fs.readFileSync(relPath, 'utf8'));
  doc.shows[OTHER].relatedIds = [OLD];
  writeJson(relPath, doc);
  const bad = run(f, ['--check']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /still pending/);
});

test('CLI: one bad pair refuses the whole batch', () => {
  const f = buildFixture();
  writeJson(f.batch, { card: 'BRO-4315', reason: 'test', renames: [pair, { oldId: OTHER, newId: 'other-play-off-west-end-2025', expectTitle: 'Other Play' }] });
  const before = fs.readFileSync(path.join(f.core, 'shows.json'), 'utf8');
  const r = run(f, ['--apply']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /already agrees/);
  assert.equal(fs.readFileSync(path.join(f.core, 'shows.json'), 'utf8'), before);
  assert.ok(fs.existsSync(path.join(f.rt, OLD)));
});

test('CLI: an old row re-added by a merge is dropped on rerun', () => {
  const f = buildFixture();
  assert.equal(run(f, ['--apply']).status, 0);
  const file = path.join(f.core, 'shows.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.shows.push({ ...row(), status: 'closed' });
  writeJson(file, doc);
  assert.equal(run(f, ['--check']).status, 1, 'check sees the re-added row');
  const dry = run(f);
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /reappeared/);
  assert.equal(shows(f).filter((x) => x.id === OLD).length, 1, 'dry run keeps it');
  const r = run(f, ['--apply']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!shows(f).some((x) => x.id === OLD));
  assert.equal(run(f, ['--check']).status, 0);
});

test('CLI: --check only warns on a late run-log append; --apply sweeps it', () => {
  const f = buildFixture();
  assert.equal(run(f, ['--apply']).status, 0);
  const runs = path.join(f.web, 'data', 'llm-scoring-runs.json');
  writeJson(runs, [{ runId: 1, validation: [{ showId: OLD, delta: 2 }] }]);
  const chk = run(f, ['--check']);
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
  assert.match(chk.stdout, /::warning::.*re-appended to .*llm-scoring-runs\.json/);
  // A non-log file regaining the old id still fails.
  const rel = path.join(f.web, 'data', 'related-shows.json');
  const relDoc = JSON.parse(fs.readFileSync(rel, 'utf8'));
  relDoc.shows[OTHER].relatedIds = [OLD];
  writeJson(rel, relDoc);
  assert.equal(run(f, ['--check']).status, 1);
  const r = run(f, ['--apply']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.readFileSync(runs, 'utf8').includes(OLD));
  const clean = run(f, ['--check']);
  assert.equal(clean.status, 0);
  assert.doesNotMatch(clean.stdout, /::warning::/);
});

test('build-slug-redirects keeps the year-less URL of a renamed id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-redirects-'));
  writeJson(path.join(dir, 'shows.json'), { shows: [
    { id: NEW, slug: NEW, title: 'Fixture Play', category: 'off-west-end', aliases: [OLD] },
    { id: OTHER, slug: OTHER, title: 'Other Play', category: 'west-end' },
  ] });
  const env = { ...process.env, SLUG_REDIRECTS_SHOWS_PATH: path.join(dir, 'shows.json'), SLUG_REDIRECTS_OUT_DIR: dir, SLUG_REDIRECTS_CAST_MANIFEST_PATH: path.join(dir, 'none.json'), SLUG_REDIRECTS_COMPLEXES_DIR: dir, CRITIC_SLUG_ALIASES_PATH: path.join(dir, 'none.json') };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-slug-redirects.js')], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'slug-redirects.json'), 'utf8'));
  const map = out.redirects || out;
  assert.equal(map[OLD].target, NEW, 'old id');
  assert.equal(map['fixture-play-west-end'].target, NEW, 'old year-less base');
  assert.equal(map['fixture-play-off-west-end'].target, NEW, 'new year-less base');
  assert.equal(map['other-play-west-end'].target, OTHER, 'untouched show keeps its base');
});
