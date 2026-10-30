/**
 * excerpt-fingerprint-dedup.test.mjs — BRO-6628 item 4.
 *
 * A no-url, excerpt-only BWW roundup record survived rebuild next to its
 * byline-mangled twin (independent--bcaitlin-hornik vs independent--caitlin-hornik
 * on a-few-good-men-2026, same bwwExcerpt) and the review counted twice.
 * Runs the real rebuild on a fixture show dir (same harness as BRO-5901).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SHOW = 'operation-mincemeat-2025'; // opened show; the real case was a-few-good-men-2026, still in previews in some data snapshots
const showsJson = path.join(ROOT, 'data', 'shows.json');
const haveShow = fs.existsSync(showsJson) && fs.readFileSync(showsJson, 'utf8').includes(`"${SHOW}"`);

const EXCERPT = "A taut, polished revival that finds fresh urgency in Sorkin's courtroom drama, anchored by a commanding central performance.";
const rec = (critic, extra = {}) => ({
  showId: SHOW, outlet: 'The Independent', outletId: 'independent', criticName: critic,
  publishDate: '2025-03-21', source: 'bww-roundup', bwwExcerpt: EXCERPT,
  assignedScore: 80, bwwSentiment: 'positive', contentTier: 'excerpt', ...extra,
});

function rebuild(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6628-'));
  const texts = path.join(root, 'review-texts');
  const dir = path.join(texts, SHOW);
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, d] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), JSON.stringify(d, null, 2));
  const out = execFileSync('node', [path.join(ROOT, 'scripts', 'rebuild-all-reviews.js'), `--show=${SHOW}`], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, REBUILD_REVIEW_TEXTS_DIR: texts, REBUILD_EXCLUSION_AUDIT_DIR: path.join(root, 'audit') },
  });
  const included = Number((/(\d+) review\(s\) would be included/.exec(out) || [])[1]);
  return { included, out };
}

test('rebuild: byline-mangled twin with the same bwwExcerpt is collapsed to one review', { skip: !haveShow && 'data/shows.json lacks the fixture show' }, () => {
  const r = rebuild({
    'independent--caitlin-hornik.json': rec('Caitlin Hornik'),
    'independent--bcaitlin-hornik.json': rec('Bcaitlin Hornik'),
  });
  assert.match(r.out, /\[EXCERPT FINGERPRINT DEDUP\]/, r.out.slice(-600));
  assert.equal(r.included, 1);
});

test('rebuild: a different excerpt from the same outlet is NOT collapsed', { skip: !haveShow && 'data/shows.json lacks the fixture show' }, () => {
  const r = rebuild({
    'independent--caitlin-hornik.json': rec('Caitlin Hornik'),
    'independent--another-critic.json': rec('Another Critic', { bwwExcerpt: 'A muddled second act undercuts a handsome staging, and the central trial never builds the tension the script demands.' }),
  });
  assert.doesNotMatch(r.out, /\[EXCERPT FINGERPRINT DEDUP\]/);
  assert.equal(r.included, 2);
});
