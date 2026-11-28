/**
 * verify-social-ai-live-post.test.mjs: the RECHECK-AFTER acceptance command
 * for BRO-6959 ("AI-written score posts are live"). Like
 * verify-provider-spend-streak.test.mjs it reads LIVE repo data
 * (data/social-autopost-ledger.json, written by the hourly social-autopost
 * run) instead of a fixture, so scripts/autonomous-acceptance-recheck.js can
 * re-run it after the date below. A red run means the switch-on did not hold
 * in production (every score post since went out with the template wording).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(HERE, '..', 'data', 'social-autopost-ledger.json');
const SWITCHED_ON = '2026-11-04';
const CHECKABLE_FROM = Date.parse('2026-11-11T00:00:00Z');

test('at least one live score post since the switch-on was written by the AI writer', {
  skip: Date.now() < CHECKABLE_FROM && 'not checkable before 2026-11-11',
}, () => {
  const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  const since = (ledger.posts || []).filter(p => (p.type || 'score') === 'score' && String(p.date || '') >= SWITCHED_ON);
  assert.ok(since.length > 0, `no score posts in the ledger since ${SWITCHED_ON}, so nothing to judge yet`);
  const ai = since.filter(p => p.writer === 'ai');
  assert.ok(ai.length > 0, `${since.length} score posts since ${SWITCHED_ON}, none written by the AI writer: ${since.map(p => `${p.showId}=${p.writer || 'unrecorded'}${p.writerFallback ? ` (${p.writerFallback})` : ''}`).join(', ')}`);
});
