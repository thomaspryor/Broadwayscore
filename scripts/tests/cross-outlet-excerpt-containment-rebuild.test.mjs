// LIVE-DATA-LANE: reads data/shows.json (untracked core data); data/critic-registry.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
/**
 * cross-outlet-excerpt-containment-rebuild.test.mjs — BRO-7684, pipeline half.
 *
 * Runs the real rebuild-all-reviews.js on a fixture show dir (same harness as
 * excerpt-fingerprint-dedup.test.mjs): a fresh bylineless, url-less quote whose
 * words sit inside a sibling outlet's fullText is flagged crossOutletDuplicate
 * (method excerpt-containment) and dropped in the SAME run. The pure rule is
 * covered in cross-outlet-excerpt-containment.test.mjs (blocking lane).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SHOW = 'operation-mincemeat-2025';
const showsJson = path.join(ROOT, 'data', 'shows.json');
const haveShow = fs.existsSync(showsJson) && fs.readFileSync(showsJson, 'utf8').includes(`"${SHOW}"`);

const QUOTE = 'The cast of five plays dozens of roles with such breakneck precision that the evening feels less like a musical than a magic trick performed in plain sight';
const FULL = [
  'Operation Mincemeat arrives on Broadway after a long run in London, and it has lost none of its cheek on the journey across the Atlantic.',
  'The story of the British intelligence officers who dressed a corpse as a courier to fool the Nazis is absurd enough on its own.',
  `${QUOTE}.`,
  'The songs borrow from sea shanties, Gilbert and Sullivan and modern pop without ever feeling like a pastiche of any of them.',
  'A late ballad sung by a secretary who writes the dead man love letters stops the show cold and earns every tear it draws from the audience.',
  'There are moments when the jokes pile up faster than the plot can carry them, but the energy rarely flags across two and a half hours.',
].join(' ');

const fullRec = () => ({
  showId: SHOW, outlet: 'The New York Times', outletId: 'nytimes', criticName: 'Jesse Green',
  url: 'https://www.nytimes.com/2025/03/20/theater/operation-mincemeat-review.html',
  publishDate: '2025-03-20', fullText: FULL, assignedScore: 85, contentTier: 'complete', source: 'collect-review-texts',
});
const quoteRec = (extra = {}) => ({
  showId: SHOW, outlet: 'New York Daily News', outletId: 'nydailynews', criticName: 'Unknown',
  publishDate: '2025-03-20', source: 'bww-roundup', bwwExcerpt: `${QUOTE}.`,
  assignedScore: 85, bwwSentiment: 'positive', contentTier: 'excerpt', ...extra,
});

// --- the pure rule ---
// --- the pipeline: same rebuild run ---
// `root` from an earlier call reruns the rebuild on the same tree (files given are written over it).
function rebuild(files, root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7684-'))) {
  const texts = path.join(root, 'review-texts');
  const dir = path.join(texts, SHOW);
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, d] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), JSON.stringify(d, null, 2));
  const out = execFileSync('node', [path.join(ROOT, 'scripts', 'rebuild-all-reviews.js'), `--show=${SHOW}`], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, REBUILD_REVIEW_TEXTS_DIR: texts, REBUILD_EXCLUSION_AUDIT_DIR: path.join(root, 'audit') },
  });
  const included = Number((/(\d+) review\(s\) would be included/.exec(out) || [])[1]);
  const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
  return { included, out, read, root };
}

test('rebuild: a fresh bylineless quote inside a sibling fullText is flagged and dropped in the same run', { skip: !haveShow && 'data/shows.json lacks the fixture show' }, () => {
  const r = rebuild({ 'nytimes--jesse-green.json': fullRec(), 'nydailynews--unknown.json': quoteRec() });
  const q = r.read('nydailynews--unknown.json');
  assert.equal(q.crossOutletDuplicate, true, r.out.slice(-800));
  assert.equal(q.crossOutletPrimaryFile, `${SHOW}/nytimes--jesse-green.json`);
  assert.equal(q.crossOutletMethod, 'excerpt-containment');
  assert.equal(r.read('nytimes--jesse-green.json').crossOutletDuplicate, undefined, 'the fullText keeper is never flagged');
  assert.equal(r.included, 1);
});

test('rebuild: a quote with its own url is left alone (two reviews)', { skip: !haveShow && 'data/shows.json lacks the fixture show' }, () => {
  const r = rebuild({
    'nytimes--jesse-green.json': fullRec(),
    'nydailynews--unknown.json': quoteRec({ url: 'https://www.nydailynews.com/2025/03/20/operation-mincemeat-review/' }),
  });
  assert.equal(r.read('nydailynews--unknown.json').crossOutletDuplicate, undefined);
  assert.equal(r.included, 2);
});

test('rebuild: a quote is not hidden behind a keeper the rebuild itself drops (wrongProduction)', { skip: !haveShow && 'data/shows.json lacks the fixture show' }, () => {
  const r = rebuild({
    'nytimes--jesse-green.json': { ...fullRec(), wrongProduction: true, wrongProductionReason: 'test: other production' },
    'nydailynews--unknown.json': quoteRec(),
  });
  assert.equal(r.read('nydailynews--unknown.json').crossOutletDuplicate, undefined, r.out.slice(-800));
});

test('rebuild: one keeper absorbing quotes from 2+ outlets is held and logged, nothing flagged', { skip: !haveShow && 'data/shows.json lacks the fixture show' }, () => {
  const r = rebuild({
    'nytimes--jesse-green.json': fullRec(),
    'nydailynews--unknown.json': quoteRec(),
    'nypost--unknown.json': quoteRec({ outlet: 'New York Post', outletId: 'nypost' }),
  });
  assert.match(r.out, /\[EXCERPT CONTAINMENT HELD\] operation-mincemeat-2025\/nytimes--jesse-green\.json/);
  assert.equal(r.read('nydailynews--unknown.json').crossOutletDuplicate, undefined);
  assert.equal(r.read('nypost--unknown.json').crossOutletDuplicate, undefined);
});

test('rebuild: fan-out hold spans runs (second outlet\'s quote arrives in a later run)', { skip: !haveShow && 'data/shows.json lacks the fixture show' }, () => {
  const r1 = rebuild({ 'nytimes--jesse-green.json': fullRec(), 'nydailynews--unknown.json': quoteRec() });
  assert.equal(r1.read('nydailynews--unknown.json').crossOutletDuplicate, true, r1.out.slice(-800));
  const r2 = rebuild({ 'nypost--unknown.json': quoteRec({ outlet: 'New York Post', outletId: 'nypost' }) }, r1.root);
  assert.equal(r2.read('nypost--unknown.json').crossOutletDuplicate, undefined, 'the later quote is held, not flagged');
  assert.match(r2.out, /\[EXCERPT CONTAINMENT HELD\] operation-mincemeat-2025\/nytimes--jesse-green\.json.*already flagged: nydailynews--unknown\.json/);
});

test('rebuild: a containment-flagged quote goes live again when its keeper is excluded later', { skip: !haveShow && 'data/shows.json lacks the fixture show' }, () => {
  const r1 = rebuild({ 'nytimes--jesse-green.json': fullRec(), 'nydailynews--unknown.json': quoteRec() });
  assert.equal(r1.included, 1);
  assert.equal(r1.read('nydailynews--unknown.json').crossOutletDuplicate, true);
  const r2 = rebuild({ 'nytimes--jesse-green.json': { ...fullRec(), wrongProduction: true, wrongProductionReason: 'test: other production' } }, r1.root);
  assert.equal(r2.included, 1, 'the quote ships once its keeper no longer does: ' + r2.out.slice(-800));
});

test('rebuild: a containment-flagged quote goes live again when its keeper file is gone', { skip: !haveShow && 'data/shows.json lacks the fixture show' }, () => {
  const r1 = rebuild({ 'nytimes--jesse-green.json': fullRec(), 'nydailynews--unknown.json': quoteRec() });
  fs.rmSync(path.join(r1.root, 'review-texts', SHOW, 'nytimes--jesse-green.json'));
  const r2 = rebuild({}, r1.root);
  assert.equal(r2.included, 1, r2.out.slice(-800));
});
