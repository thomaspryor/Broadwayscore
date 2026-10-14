// BRO-2747: audit-outlet-registry.js rewrote the git-tracked
// data/audit/outlet-registry-gaps.json on EVERY run, --strict included, with
// machine-absolute paths (~3,000 changed lines when run from a worktree).
// BRO-2726: write-guard-quarantined copies (duplicateOf an existing canonical
// sibling) kept their scraper-mangled outletIds in the missing-outlet scan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { relativizeRepoPaths, shouldSaveAuditResults } = require('./lib/outlet-registry-gaps-output.js');
const { isQuarantinedDuplicateOfCanonical } = require('./lib/outlet-registry-audit-exclusions.js');

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAPS = path.join(REPO, 'data/audit/outlet-registry-gaps.json');

test('absolute paths inside the repo become repo-relative, everything else is untouched', () => {
  const root = '/Users/x/Broadwayscore/.claude/worktrees/job-1';
  const out = relativizeRepoPaths({
    missingOutlets: [{ outletId: 'a', exampleFile: `${root}/data/review-texts/show/a--b.json`, count: 2 }],
    displayNameMismatches: [{ files: [`${root}/data/review-texts/s/x.json`, '/elsewhere/y.json'] }],
    note: 'Broadwayscore',
    nested: { n: null, ok: true },
  }, root);
  assert.equal(out.missingOutlets[0].exampleFile, 'data/review-texts/show/a--b.json');
  assert.equal(out.missingOutlets[0].count, 2);
  assert.deepEqual(out.displayNameMismatches[0].files, ['data/review-texts/s/x.json', '/elsewhere/y.json']);
  assert.equal(out.note, 'Broadwayscore');
  assert.deepEqual(out.nested, { n: null, ok: true });
});

test('a sibling directory sharing the repo name as a prefix is not relativized', () => {
  const out = relativizeRepoPaths({ f: '/r/Broadwayscore-old/data/x.json' }, '/r/Broadwayscore');
  assert.equal(out.f, '/r/Broadwayscore-old/data/x.json');
});

test('only plain report mode writes the gaps file', () => {
  assert.equal(shouldSaveAuditResults({}), true);
  assert.equal(shouldSaveAuditResults({ strict: true }), false);
  assert.equal(shouldSaveAuditResults({ reportOnly: true }), false);
});

test('--strict leaves the tracked gaps file byte-identical', () => {
  const hash = () => (fs.existsSync(GAPS) ? crypto.createHash('sha256').update(fs.readFileSync(GAPS)).digest('hex') : null);
  const before = hash();
  const r = spawnSync(process.execPath, ['scripts/audit-outlet-registry.js', '--strict'], { cwd: REPO, encoding: 'utf8', timeout: 180000 });
  assert.ok(r.status === 0 || r.status === 1, `unexpected exit ${r.status}: ${r.stderr}`);
  assert.equal(hash(), before, 'audit-outlet-registry.js --strict modified data/audit/outlet-registry-gaps.json');
});

test('a duplicateOf copy of an existing canonical sibling is skipped', () => {
  const siblings = { 'timeout-london--andrzej-lukowski.json': { outletId: 'timeout-london', humanReviewScore: 80 } };
  const read = name => siblings[name] || null;
  assert.equal(isQuarantinedDuplicateOfCanonical({ outletId: 'time-ou', duplicateOf: 'timeout-london--andrzej-lukowski.json' }, read), true);
});

test('dangling, chained, path-like or absent duplicateOf stays in scope', () => {
  const siblings = { 'b.json': { duplicateOf: 'c.json' } };
  const read = name => siblings[name] || null;
  assert.equal(isQuarantinedDuplicateOfCanonical({ duplicateOf: 'gone.json' }, read), false);
  assert.equal(isQuarantinedDuplicateOfCanonical({ duplicateOf: 'b.json' }, read), false);
  assert.equal(isQuarantinedDuplicateOfCanonical({ duplicateOf: '../other-show/b.json' }, () => ({})), false);
  assert.equal(isQuarantinedDuplicateOfCanonical({ duplicateOf: null }, read), false);
  assert.equal(isQuarantinedDuplicateOfCanonical({}, read), false);
});

// BRO-2716: one-time sweep of registered outlets against today's
// non-review domain predicates (scripts/audit-registry-nonreview-outlets.js).
const { nonReviewHostReasons, findNonReviewRegistryOutlets } = require('./audit-registry-nonreview-outlets.js');

test('venue, ticketing and PR hosts are flagged; real review outlets are not', () => {
  assert.ok(nonReviewHostReasons('www.broadway.com').includes('isBlockedReviewUrl'));
  assert.ok(nonReviewHostReasons('scorebig.com').length > 0);
  assert.deepEqual(nonReviewHostReasons('nytimes.com'), []);
  // The census's bare .org catch-all is not evidence a registered outlet is a venue.
  assert.deepEqual(nonReviewHostReasons('wnyc.org'), []);
  assert.deepEqual(nonReviewHostReasons(null), []);
});

test('report rows: flagged host, or most review urls blocked; clean outlets omitted', () => {
  const registry = { outlets: {
    _meta: {},
    nytimes: { displayName: 'NYT', tier: 1, domain: 'nytimes.com' },
    scorebig: { displayName: 'scorebig', tier: 3, domain: 'scorebig.com' },
    blogx: { displayName: 'Blog X', tier: 4 },
  } };
  const urls = new Map([
    ['nytimes', ['https://www.nytimes.com/2026/01/01/theater/x-review.html']],
    ['blogx', ['https://www.facebook.com/a/posts/1', 'https://www.facebook.com/a/posts/2', 'https://blogx.com/review-y/']],
  ]);
  const hits = findNonReviewRegistryOutlets(registry, urls);
  assert.deepEqual(hits.map(h => h.outletId), ['blogx', 'scorebig']);
  const blog = hits.find(h => h.outletId === 'blogx');
  assert.equal(blog.reviewFiles, 3);
  assert.equal(blog.blockedUrls, 2);
});

test('a copy of an EXCLUDED sibling stays in scope (the rebuild recovers such copies)', () => {
  const read = () => ({ outletId: 'timeout-london', humanReviewScore: 80 });
  assert.equal(isQuarantinedDuplicateOfCanonical({ duplicateOf: 'x.json' }, read), true);
  assert.equal(isQuarantinedDuplicateOfCanonical({ duplicateOf: 'x.json' }, read, () => false), false);
  const unscored = () => ({ outletId: 'timeout-london' });
  assert.equal(isQuarantinedDuplicateOfCanonical({ duplicateOf: 'x.json' }, unscored), false);
  const blocked = () => ({ outletId: 'x', humanReviewScore: 80, url: 'https://www.facebook.com/a/posts/1' });
  assert.equal(isQuarantinedDuplicateOfCanonical({ duplicateOf: 'x.json' }, blocked), false);
});

// BRO-5261 retro-review of the BRO-2716 sweep: the host check composes the
// write path's own predicates, so every host rule they hold applies.
test('host rules other than ticketing-reseller are reported (named listing hosts)', () => {
  assert.deepEqual(nonReviewHostReasons('westend.com'), ['ticketing-listing']);
  assert.deepEqual(nonReviewHostReasons('abouttheartists.com'), ['production-database-listing']);
});

test('a subdomain of a blocked host is reported, as the write path refuses it', () => {
  assert.ok(nonReviewHostReasons('m.facebook.com').includes('isBlockedReviewUrl'));
  assert.ok(nonReviewHostReasons('uk.seatgeek.com').includes('isBlockedReviewUrl'));
});

test('real outlets, .org outlets and section-path rules are not reported', () => {
  assert.deepEqual(nonReviewHostReasons('nytimes.com'), []);
  assert.deepEqual(nonReviewHostReasons('wnyc.org'), [], 'the bare .org catch-all is a census heuristic');
  assert.deepEqual(nonReviewHostReasons('broadwayworld.com'), [], 'aggregator-internal-nav is a path rule');
  assert.deepEqual(nonReviewHostReasons('bestoftheatre.co.uk'), [], 'its product-page rule is a path rule');
});

test('a domainless outlet half on a ticket host is reported; one on a clean host is not', () => {
  const registry = { outlets: { x: { displayName: 'X', tier: 4, domain: null } } };
  const half = findNonReviewRegistryOutlets(registry, new Map([['x', ['https://broadway.com/a', 'https://realblog.com/r']]]));
  assert.deepEqual(half.map((h) => h.outletId), ['x']);
  const clean = findNonReviewRegistryOutlets(registry, new Map([['x', ['https://realblog.com/r']]]));
  assert.deepEqual(clean, []);
});

test('duplicateOf sibling include check passes the sibling filePath (BRO-5261)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./audit-outlet-registry.js', import.meta.url), 'utf8');
  const call = src.slice(src.indexOf('isQuarantinedDuplicateOfCanonical(review'), src.indexOf('findings.quarantinedDuplicatesSkipped++'));
  assert.match(call, /isIncludableForRebuild\(sibling, [^,]+,\s*path\.join\(path\.dirname\(reviewFile\.fullPath\), review\.duplicateOf\)\)/);
});
