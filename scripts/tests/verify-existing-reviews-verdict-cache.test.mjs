// BRO-7536: verify-existing-reviews.js must remember verdicts that change
// nothing: low-confidence flag verdicts in VERIFY mode, and every RECOVER-mode
// read that leaves the flag in place (RECOVER had no skip at all).
//
// Drives the REAL script (CLAUDE.md §15: require()d, verifyContent swapped for
// a fake) over synthetic fixtures and asserts the second run makes zero
// verifier calls for judged files; errors stay retriable; changed text or
// prompt version re-queues. Revert the stamps or the skips and it fails.
//
// Fixtures are synthetic text written here; no real review text (private).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cache = require('../lib/llm-verdict-cache.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-verdict-cache-'));
const SHOW = 'verdict-cache-show-2026';
const DIR = path.join(ROOT, 'data', 'review-texts', SHOW);
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'shows.json'), JSON.stringify({ shows: [{ id: SHOW, title: 'The Synthetic Musical', openingDate: '2026-01-15', venue: 'Lantern Theatre' }] }));

const FILLER = 'The company moves through the evening with an even, practised energy and the band plays the score cleanly. ';
const body = (marker) => `${marker} ${FILLER.repeat(4)}`.trim();

const FIXTURES = {
  'outlet-a--verify-low.json': { fullText: body('MARK_VERIFY_LOW') },
  'outlet-b--verify-clean.json': { fullText: body('MARK_VERIFY_CLEAN') },
  'outlet-c--verify-error.json': { fullText: body('MARK_VERIFY_ERROR') },
  'outlet-d--recover-confirm.json': { fullText: body('MARK_RECOVER_CONFIRM'), wrongProduction: true, wrongProductionReason: 'synthetic' },
  'outlet-e--recover-low.json': { fullText: body('MARK_RECOVER_LOW'), wrongShow: true, wrongShowReason: 'synthetic' },
  // Heuristic fallbacks (LLM outage / parse failure): never stamped, always retried.
  'outlet-f--heur-verify.json': { fullText: body('MARK_HEUR_VERIFY') },
  'outlet-g--heur-recover.json': { fullText: body('MARK_HEUR_RECOVER'), wrongProduction: true, wrongProductionReason: 'synthetic' },
};
for (const [file, extra] of Object.entries(FIXTURES)) {
  const outletId = file.split('--')[0];
  fs.writeFileSync(path.join(DIR, file), JSON.stringify({ showId: SHOW, outletId, outlet: outletId, criticName: 'Test Critic', ...extra }, null, 2));
}

// The script checkpoints with git in cwd; make sure no git repo is ever found.
process.env.GIT_DIR = path.join(ROOT, 'no-such-git-dir');
process.env.GIT_CEILING_DIRECTORIES = path.dirname(ROOT);
delete process.env.REVIEW_TEXTS_TOKEN;
process.chdir(ROOT);
process.argv = [process.argv[0], 'verify-existing-reviews.js'];
const verifier = require('../verify-existing-reviews.js');

// Answer as the model this run would reach first, so its stamps are acceptable.
const PRIMARY = verifier.VERIFY_PRIMARY_PROVIDER || 'llm:claude-sonnet';
const asked = [];
verifier._setVerifyForTest(async ({ scrapedText }) => {
  const m = scrapedText.match(/MARK_[A-Z_]+/)[0];
  asked.push(m);
  const base = { verifiedBy: PRIMARY, reasoning: 'synthetic' };
  switch (m) {
    case 'MARK_HEUR_VERIFY': return { verifiedBy: 'heuristic', isValid: false, wrongArticle: true, confidence: 'low' };
    case 'MARK_HEUR_RECOVER': return { verifiedBy: 'heuristic', isValid: false, wrongArticle: true, confidence: 'medium' };
    case 'MARK_VERIFY_LOW': return { ...base, isValid: false, wrongArticle: true, confidence: 'low' };
    case 'MARK_VERIFY_CLEAN': return { ...base, isValid: true, confidence: 'high' };
    case 'MARK_VERIFY_ERROR': throw new Error('HTTP 500');
    case 'MARK_RECOVER_CONFIRM': return { ...base, isValid: false, wrongProduction: true, confidence: 'high' };
    case 'MARK_RECOVER_LOW': return { ...base, isValid: true, confidence: 'low' };
    default: throw new Error(`unexpected ${m}`);
  }
});

const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const write = (f, d) => fs.writeFileSync(path.join(DIR, f), JSON.stringify(d, null, 2));

async function run() {
  asked.length = 0;
  const log = console.log;
  console.log = () => {};
  try { await verifier.main(); } finally { console.log = log; }
  return [...asked].sort();
}

test('second run makes zero verifier calls for judged files; errors stay retriable', async () => {
  assert.deepEqual(await run(), ['MARK_HEUR_RECOVER', 'MARK_HEUR_VERIFY', 'MARK_RECOVER_CONFIRM', 'MARK_RECOVER_LOW', 'MARK_VERIFY_CLEAN', 'MARK_VERIFY_ERROR', 'MARK_VERIFY_LOW']);

  const low = read('outlet-a--verify-low.json');
  assert.equal(low[cache.VERIFY_FIELDS.reason], 'low-confidence-wrongArticle');
  assert.equal(low[cache.VERIFY_FIELDS.promptVersion], verifier.VERIFY_PROMPT_VERSION);
  assert.equal(low.wrongShow, undefined, 'low-confidence verdict must not flag');
  assert.equal(read('outlet-d--recover-confirm.json')[cache.RECOVER_FIELDS.reason], 'confirmed-wrongProduction');
  const rl = read('outlet-e--recover-low.json');
  assert.equal(rl[cache.RECOVER_FIELDS.reason], 'low-confidence-recover');
  assert.equal(rl.wrongShow, true, 'low-confidence recover keeps the flag');
  assert.equal(read('outlet-c--verify-error.json')[cache.VERIFY_FIELDS.at], undefined, 'errors are never stamped');
  assert.equal(read('outlet-f--heur-verify.json')[cache.VERIFY_FIELDS.at], undefined, 'heuristic VERIFY verdict must not be stamped');
  assert.equal(read('outlet-g--heur-recover.json')[cache.RECOVER_FIELDS.at], undefined, 'heuristic RECOVER verdict must not be stamped');
  assert.equal(low[cache.VERIFY_FIELDS.provider], PRIMARY, 'stamp names the model that answered');

  assert.deepEqual(await run(), ['MARK_HEUR_RECOVER', 'MARK_HEUR_VERIFY', 'MARK_VERIFY_ERROR'], 'judged files must make zero verifier calls on an unchanged second run');
});

test('changed text or an old prompt version re-queues; recovery stamp follows the text', async () => {
  const rc = read('outlet-d--recover-confirm.json');
  rc.fullText = body('MARK_RECOVER_CONFIRM') + ' A refetched closing line.';
  write('outlet-d--recover-confirm.json', rc);
  const low = read('outlet-a--verify-low.json');
  low[cache.VERIFY_FIELDS.promptVersion] = 'g0-oldprompt';
  write('outlet-a--verify-low.json', low);
  assert.deepEqual(await run(), ['MARK_HEUR_RECOVER', 'MARK_HEUR_VERIFY', 'MARK_RECOVER_CONFIRM', 'MARK_VERIFY_ERROR', 'MARK_VERIFY_LOW']);
  assert.deepEqual(await run(), ['MARK_HEUR_RECOVER', 'MARK_HEUR_VERIFY', 'MARK_VERIFY_ERROR']);
});

test('a new excerpt or a weaker stamped model re-queues', async () => {
  const rl = read('outlet-e--recover-low.json');
  rl.dtliExcerpt = 'A newly harvested aggregator excerpt that the verifier prompt will now carry.';
  write('outlet-e--recover-low.json', rl);
  const low = read('outlet-a--verify-low.json');
  low[cache.VERIFY_FIELDS.provider] = 'heuristic'; // as if an old stamp came from a non-LLM path
  write('outlet-a--verify-low.json', low);
  assert.deepEqual(await run(), ['MARK_HEUR_RECOVER', 'MARK_HEUR_VERIFY', 'MARK_RECOVER_LOW', 'MARK_VERIFY_ERROR', 'MARK_VERIFY_LOW']);
});

test('provider ranking: a cheaper model never stands in for a stronger primary', () => {
  assert.equal(cache.verifyProviderSatisfies('llm:gemini', 'llm:claude-haiku'), false);
  assert.equal(cache.verifyProviderSatisfies('llm:claude-haiku', 'llm:claude-haiku'), true);
  assert.equal(cache.verifyProviderSatisfies('llm:claude-sonnet', 'llm:claude-haiku-v5'), true);
  assert.equal(cache.verifyProviderSatisfies('heuristic', null), false);
  assert.equal(cache.verifyProviderSatisfies('llm:mystery', 'llm:gemini'), false);
  assert.equal(cache.isLlmVerdict({ verifiedBy: 'heuristic' }), false);
  assert.equal(cache.isLlmVerdict({ verifiedBy: 'skip-short' }), false);
  assert.equal(cache.isLlmVerdict({ verifiedBy: 'llm:gemini' }), true);
});

test('show metadata and override inputs are part of the judged input', () => {
  const r = { outlet: 'o', criticName: 'c', url: 'u' };
  const s = { title: 'A', openingDate: '2026-01-01' };
  const base = cache.verifierContext(r, s, { market: 'broadway' });
  for (const [label, ctx] of [
    ['openingDate', cache.verifierContext(r, { ...s, openingDate: '2027-01-01' }, { market: 'broadway' })],
    ['closingDate', cache.verifierContext(r, { ...s, closingDate: '2026-06-01' }, { market: 'broadway' })],
    ['priorRuns', cache.verifierContext(r, { ...s, priorRuns: [{ openingDate: '2001-01-01' }] }, { market: 'broadway' })],
    ['tourLegs', cache.verifierContext(r, { ...s, tourLegs: [{ startDate: '2003-01-01' }] }, { market: 'broadway' })],
    ['akaTitles', cache.verifierContext(r, { ...s, akaTitles: ['A2'] }, { market: 'broadway' })],
    ['market', cache.verifierContext(r, s, { market: 'west-end' })],
    ['long-runner', cache.verifierContext(r, s, { market: 'broadway', isLongRunningProduction: true })],
    ['excerpt', cache.verifierContext(r, s, { market: 'broadway', excerpt: 'quote' })],
  ]) assert.notEqual(ctx, base, `${label} must change the cache key`);
});

test('prompt version covers the market, long-runner, prior-run and excerpt branches', () => {
  const cv = require('../lib/content-verifier.js');
  const orig = cv.buildVerificationPrompt;
  const scriptPath = require.resolve('../verify-existing-reviews.js');
  const versionWith = (fn) => {
    cv.buildVerificationPrompt = fn;
    delete require.cache[scriptPath];
    try { return require(scriptPath).VERIFY_PROMPT_VERSION; } finally { cv.buildVerificationPrompt = orig; delete require.cache[scriptPath]; }
  };
  const base = versionWith(orig);
  assert.equal(base, verifier.VERIFY_PROMPT_VERSION);
  for (const [label, hit] of [
    ['west-end', (a) => a.market === 'west-end' && !a.isLongRunningProduction],
    ['opera', (a) => a.market === 'opera'],
    ['long-runner', (a) => a.isLongRunningProduction === true],
    ['priorRuns/tourLegs', (a) => Array.isArray(a.priorRuns)],
    ['excerpt', (a) => !!a.excerpt],
  ]) {
    const v = versionWith((a) => { const r = orig(a); return hit(a) ? { ...r, prompt: `${r.prompt} CHANGED` } : r; });
    assert.notEqual(v, base, `a change only in the ${label} prompt branch must move the version`);
  }
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
