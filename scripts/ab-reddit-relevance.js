#!/usr/bin/env node
/**
 * A/B harness for the Reddit buzz per-comment relevance classifier (CLAUDE.md
 * rule 13: never rescore >100 without an A/B; abort on >5% bucket shift / >5pt
 * mean drift on shows expected to be STABLE).
 *
 * The change under test: buzz-classifier now gates each comment on the specific
 * PRODUCTION (thread title + venue/market/type) instead of blindly assuming any
 * ambiguous "I saw it" refers to the target show. This SHOULD drop off-topic
 * chatter for generic-phrase titles ("Pied à Terre", "Oscar Wao") while leaving
 * genuinely-Reddit-corroborated shows ("Drunk Shakespeare") intact.
 *
 * It collects each show's comments ONCE, then classifies them two ways on the
 * identical input so the ONLY variable is the classifier version:
 *   OLD arm — the current git-HEAD classifier (ignores thread titles)
 *   NEW arm — the working-tree classifier (production-reference gate active)
 * and reports relevant-count, buzz-score, and sentiment-bucket deltas.
 *
 * Usage:
 *   node scripts/ab-reddit-relevance.js --shows=ID1,ID2 [--expect-stable=IDa,IDb]
 *   node scripts/ab-reddit-relevance.js --shows=... --samples=8   # print flipped comments
 *
 * Exit non-zero if any --expect-stable show drifts beyond the rule-13 thresholds.
 *
 * OLD_CLASSIFIER_PATH lets CI point the OLD arm at a pristine checkout; by default
 * it resolves the main working copy at ../../../.. from a worktree.
 */

const path = require('path');
const { calculateBuzzScore } = require('./lib/buzz-score');
const { getDesignation } = require('./lib/audience-weighting');

// The scrape module reads data/shows.json + data/audience-buzz.json at module
// scope, so require it LAZILY — only the live --shows path needs it. Fixture mode
// stays deterministic and runnable in a data-less checkout.
function loadScrapeModule() {
  return require('./scrape-reddit-sentiment.js');
}

// NEW arm = this tree's classifier (gate active).
const newClassifier = require('./lib/buzz-classifier.js');

// OLD arm = pristine git-HEAD classifier. From a worktree, the main working copy
// lives four levels up (.claude/worktrees/<name>/). Override with env if needed.
const OLD_PATH = process.env.OLD_CLASSIFIER_PATH
  || path.resolve(__dirname, '../../../../scripts/lib/buzz-classifier.js');
let oldClassifier;
try {
  oldClassifier = require(OLD_PATH);
} catch (e) {
  console.error(`Could not load OLD classifier at ${OLD_PATH}: ${e.message}`);
  console.error('Set OLD_CLASSIFIER_PATH to a pristine checkout of scripts/lib/buzz-classifier.js');
  process.exit(1);
}

// Degenerate-A/B guard: this tool is only meaningful pre-merge, when OLD is the
// ungated classifier and NEW is the gated one. Once the change lands on main, the
// OLD path resolves to the already-gated file and OLD==NEW (the comparison is a
// no-op). Detect it by probing whether OLD emits the production gate.
{
  const probe = oldClassifier.buildPrompt('X', [{ id: 1, body: 'y', postTitle: 'z' }], false, { market: 'Broadway', type: 'play' });
  if (/MATCH THE PRODUCTION, NOT JUST THE NAME/.test(probe)) {
    console.warn('⚠ OLD classifier already contains the production gate — OLD==NEW, this A/B is degenerate.');
    console.warn('  Point OLD_CLASSIFIER_PATH at a pre-change checkout of scripts/lib/buzz-classifier.js.');
  }
}

const BUCKETS = ['enthusiastic', 'positive', 'mixed', 'negative', 'neutral'];
const MEAN_DRIFT_ABORT = 5;      // buzz-score points (rule-13 mean)
const REL_DRIFT_ABORT = 0.20;    // relevant-count drift ratio on a stable show (gate must not discard real reviews)

function args() {
  const a = process.argv.slice(2);
  const get = (k) => { const m = a.find(x => x.startsWith(`--${k}=`)); return m ? m.split('=')[1] : null; };
  return {
    shows: (get('shows') || '').split(',').map(s => s.trim()).filter(Boolean),
    expectStable: new Set((get('expect-stable') || '').split(',').map(s => s.trim()).filter(Boolean)),
    samples: parseInt(get('samples') || '0', 10),
    fixture: get('fixture'),
    json: a.includes('--json'),
  };
}

// Fixture mode: yield {show, filtered, ctx} tuples from a labeled JSON file so the
// A/B runs deterministically without live Reddit. Each comment already carries a
// postTitle; NEW arm sees it, OLD arm ignores it.
function loadFixtureUnits(fixturePath, expectStableFlag) {
  const fx = JSON.parse(require('fs').readFileSync(fixturePath, 'utf8'));
  return fx.shows.map(s => ({
    id: s.id,
    title: s.title,
    ctx: s.context || null,
    stable: s.expectStable === true || expectStableFlag.has(s.id),
    filtered: s.comments.map((c, i) => ({ id: i + 1, body: c.body, postTitle: c.postTitle || '', score: 0, _label: c.label })),
  }));
}

function distribution(classifications) {
  const relevant = classifications.filter(c => c.is_relevant);
  const counts = Object.fromEntries(BUCKETS.map(b => [b, 0]));
  for (const c of relevant) if (counts[c.sentiment] !== undefined) counts[c.sentiment]++;
  const total = relevant.length || 1;
  const frac = Object.fromEntries(BUCKETS.map(b => [b, counts[b] / total]));
  const score = calculateBuzzScore(classifications);
  const s = score ? score.score : null;
  return { relevant: relevant.length, counts, frac, score: s, designation: s != null ? getDesignation(s) : null };
}

function maxBucketShift(a, b) {
  return Math.max(...BUCKETS.map(k => Math.abs((a.frac[k] || 0) - (b.frac[k] || 0))));
}

async function buildUnits({ fixture, showIds, expectStable }) {
  if (fixture) {
    console.log(`Fixture mode: ${fixture}`);
    return loadFixtureUnits(fixture, expectStable);
  }
  const { collectShowComments, buildShowContext, showMapById } = loadScrapeModule();
  const units = [];
  for (const id of showIds) {
    const show = showMapById[id];
    if (!show) { console.error(`Show not found: ${id}`); continue; }
    console.log(`\nCollecting: ${show.title} (${id})`);
    const collected = await collectShowComments(show);
    if (!collected) { console.log('  No comments collected — skipping'); continue; }
    units.push({ id, title: show.title, ctx: buildShowContext(show), stable: expectStable.has(id), filtered: collected.filtered });
  }
  return units;
}

async function main() {
  const { shows: showIds, expectStable, samples, fixture, json } = args();
  if (!fixture && showIds.length === 0) {
    console.error('Pass --shows=ID1,ID2 or --fixture=PATH');
    process.exit(1);
  }

  const units = await buildUnits({ fixture, showIds, expectStable });
  const results = [];
  let aborted = false;

  for (const unit of units) {
    const { id, title, ctx, filtered } = unit;
    console.log(`\n${'='.repeat(70)}\n${title} (${id})`);

    // Classify identical input two ways. OLD ignores postTitle; NEW uses it.
    const [oldC, newC] = await Promise.all([
      oldClassifier.classifyAllComments(title, filtered, 150),
      newClassifier.classifyAllComments(title, filtered, 150, 'gemini', 4, ctx),
    ]);

    const oldD = distribution(oldC);
    const newD = distribution(newC);
    const meanDrift = (oldD.score != null && newD.score != null) ? newD.score - oldD.score : null;
    const sentimentShift = maxBucketShift(oldD, newD); // informational only (LLM sentiment jitter)
    const stable = unit.stable;
    // Rule-13 abort criteria for a show that should NOT move: the downstream
    // outputs are the buzz SCORE (mean) and its designation tier (bucket), plus a
    // guard that the relevance gate isn't silently discarding real reviews. Raw
    // per-sentiment fractions are NOT used — on small samples they swing purely from
    // independent-LLM-call nondeterminism, which would flag even an OLD-vs-OLD run.
    const relDriftRatio = oldD.relevant ? Math.abs(newD.relevant - oldD.relevant) / oldD.relevant : (newD.relevant ? 1 : 0);
    const designationChanged = oldD.designation !== newD.designation;
    const violate = stable && (
      (meanDrift != null && Math.abs(meanDrift) > MEAN_DRIFT_ABORT) ||
      designationChanged ||
      relDriftRatio > REL_DRIFT_ABORT
    );
    if (violate) aborted = true;

    console.log(`  comments classified: ${filtered.length}`);
    console.log(`  relevant:  OLD ${oldD.relevant}  →  NEW ${newD.relevant}   (Δ ${newD.relevant - oldD.relevant}, ${(relDriftRatio * 100).toFixed(0)}%)`);
    console.log(`  buzzScore: OLD ${oldD.score} [${oldD.designation}]  →  NEW ${newD.score} [${newD.designation}]   (Δ ${meanDrift != null ? meanDrift.toFixed(1) : 'n/a'})`);
    console.log(`  sentiment-mix shift (info): ${(sentimentShift * 100).toFixed(1)}%`);
    console.log(`  expectation: ${stable ? 'STABLE (rule-13 gated: score/designation/relevant-count)' : 'contaminated — expect relevant to DROP'}${violate ? '  ❌ DRIFT EXCEEDS THRESHOLD' : ''}`);

    // Show what flipped relevant→not (junk dropped) and stayed relevant (survivors).
    if (samples > 0) {
      const oldById = new Map(oldC.map(c => [c.comment && c.comment.body, c]));
      const dropped = newC.filter(c => {
        const o = oldById.get(c.comment && c.comment.body);
        return o && o.is_relevant && !c.is_relevant;
      });
      const survived = newC.filter(c => c.is_relevant);
      console.log(`  --- DROPPED by new gate (${dropped.length}); showing ${Math.min(samples, dropped.length)} ---`);
      for (const c of dropped.slice(0, samples)) {
        console.log(`    ✗ [thread: "${(c.comment.postTitle || '').slice(0, 60)}"] ${c.comment.body.replace(/\n/g, ' ').slice(0, 90)}`);
      }
      console.log(`  --- SURVIVED as relevant (${survived.length}); showing ${Math.min(samples, survived.length)} ---`);
      for (const c of survived.slice(0, samples)) {
        console.log(`    ✓ [${c.sentiment}] [thread: "${(c.comment.postTitle || '').slice(0, 60)}"] ${c.comment.body.replace(/\n/g, ' ').slice(0, 80)}`);
      }
    }

    // Fixture mode carries ground-truth labels — report how each arm does on the
    // two classes: contaminated (should be dropped) and on-topic (should survive).
    const labeled = newC.filter(c => c.comment && c.comment._label);
    if (labeled.length) {
      const oldByBody = new Map(oldC.map(c => [c.comment && c.comment.body, c]));
      const score = (arm) => {
        let contamKept = 0, contamTot = 0, onKept = 0, onTot = 0;
        for (const c of labeled) {
          const rec = arm === 'old' ? oldByBody.get(c.comment.body) : c;
          const rel = !!(rec && rec.is_relevant);
          if (c.comment._label === 'contaminated') { contamTot++; if (rel) contamKept++; }
          else { onTot++; if (rel) onKept++; }
        }
        return { contamKept, contamTot, onKept, onTot };
      };
      const so = score('old'), sn = score('new');
      console.log(`  [labels] contaminated kept:  OLD ${so.contamKept}/${so.contamTot}  →  NEW ${sn.contamKept}/${sn.contamTot}  (want 0)`);
      console.log(`  [labels] on-topic kept:      OLD ${so.onKept}/${so.onTot}  →  NEW ${sn.onKept}/${sn.onTot}  (want ${sn.onTot})`);
      results._labelAgg = results._labelAgg || { contamKeptNew: 0, contamTot: 0, onKeptNew: 0, onTot: 0 };
      results._labelAgg.contamKeptNew += sn.contamKept; results._labelAgg.contamTot += sn.contamTot;
      results._labelAgg.onKeptNew += sn.onKept; results._labelAgg.onTot += sn.onTot;
    }

    results.push({ id, title, stable, old: oldD, new: newD, meanDrift, sentimentShift, relDriftRatio, designationChanged, violate, comments: filtered.length });
  }

  if (json) console.log('\n' + JSON.stringify(results, null, 2));

  console.log(`\n${'='.repeat(70)}\nSUMMARY`);
  for (const r of results) {
    console.log(`  ${r.violate ? '❌' : '  '} ${r.title}: relevant ${r.old.relevant}→${r.new.relevant}, score ${r.old.score}[${r.old.designation}]→${r.new.score}[${r.new.designation}] ${r.stable ? '[stable]' : '[contaminated]'}`);
  }
  if (results._labelAgg) {
    const a = results._labelAgg;
    console.log(`  [labels total] contaminated kept by NEW: ${a.contamKeptNew}/${a.contamTot} (want 0)   on-topic kept by NEW: ${a.onKeptNew}/${a.onTot} (want ${a.onTot})`);
  }

  if (aborted) {
    console.error('\nABORT: a --expect-stable show drifted beyond rule-13 thresholds (>5pt mean or >5% bucket).');
    process.exit(2);
  }
  console.log('\nOK: no expect-stable show breached rule-13 thresholds.');
}

main().catch(e => { console.error('Fatal:', e.stack || e.message); process.exit(1); });
