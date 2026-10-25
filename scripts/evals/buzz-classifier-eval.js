#!/usr/bin/env node
/**
 * buzz-classifier-eval.js
 *
 * Accuracy eval for scripts/lib/buzz-classifier.js. Runs the real classifier
 * (same provider fallback chain as production) against a hand-labeled golden
 * fixture, then measures:
 *   - is_relevant accuracy (binary)
 *   - sentiment accuracy (5-class, only among relevant cases)
 *   - per-failure drilldown so prompt iteration is targeted
 *
 * Exits 0 if both accuracies clear their thresholds, non-zero otherwise.
 *
 * Usage:
 *   node scripts/evals/buzz-classifier-eval.js
 *   node scripts/evals/buzz-classifier-eval.js --fixture tests/fixtures/buzz-classifier-golden/is-relevant-cases.json
 *   node scripts/evals/buzz-classifier-eval.js --min-relevant-acc 0.9 --min-sentiment-acc 0.75
 *   node scripts/evals/buzz-classifier-eval.js --json
 *
 * Environment: same as buzz-classifier (OPENROUTER_API_KEY, GEMINI_API_KEY,
 * OPENAI_API_KEY, ANTHROPIC_API_KEY — falls through chain).
 */

const fs = require('fs');
const path = require('path');
const { classifyAllComments, validateClassifications } = require('../lib/buzz-classifier');

const DEFAULT_FIXTURE = path.join(
  __dirname, '..', '..',
  'tests', 'fixtures', 'buzz-classifier-golden', 'is-relevant-cases.json'
);

function parseArgs(argv) {
  const args = {
    json: false,
    minRelevantAcc: 0.90,
    minSentimentAcc: 0.70,
    fixture: DEFAULT_FIXTURE,
  };
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--json') args.json = true;
    else if (a === '--fixture') args.fixture = list[++i];
    else if (a === '--min-relevant-acc') args.minRelevantAcc = parseFloat(list[++i]);
    else if (a === '--min-sentiment-acc') args.minSentimentAcc = parseFloat(list[++i]);
    else if (a === '--help') {
      console.log('Usage: buzz-classifier-eval.js [--fixture PATH] [--json] [--min-relevant-acc F] [--min-sentiment-acc F]');
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const fixtureRaw = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));
  const showTitle = fixtureRaw._meta?.show || 'Wicked';
  const cases = fixtureRaw.cases;

  if (!args.json) console.log(`Running ${cases.length} cases against show="${showTitle}"…`);

  const comments = cases.map(c => ({ id: c.id, body: c.body }));
  const classifications = await classifyAllComments(showTitle, comments, 150);

  // Join predictions to labels by id.
  const predById = new Map();
  for (const p of classifications) predById.set(p.id, p);

  let relevantCorrect = 0;
  let relevantTotal = 0;
  let sentimentCorrect = 0;
  let sentimentTotal = 0;
  const failures = [];

  for (const c of cases) {
    const pred = predById.get(c.id);
    relevantTotal += 1;
    if (!pred) {
      failures.push({ id: c.id, body: c.body, kind: 'missing-prediction', expected: c.expected, rationale: c.rationale });
      continue;
    }

    const relOK = pred.is_relevant === c.expected.is_relevant;
    if (relOK) relevantCorrect += 1;
    else failures.push({
      id: c.id, body: c.body, kind: 'is_relevant',
      expected: c.expected, predicted: pred, rationale: c.rationale,
    });

    // Only score sentiment among cases labeled relevant AND predicted relevant.
    if (c.expected.is_relevant && pred.is_relevant) {
      sentimentTotal += 1;
      if (pred.sentiment === c.expected.sentiment) sentimentCorrect += 1;
      else failures.push({
        id: c.id, body: c.body, kind: 'sentiment',
        expected: c.expected, predicted: pred, rationale: c.rationale,
      });
    }
  }

  const relAcc = relevantTotal ? relevantCorrect / relevantTotal : 0;
  const sentAcc = sentimentTotal ? sentimentCorrect / sentimentTotal : 1;
  const relPass = relAcc >= args.minRelevantAcc;
  const sentPass = sentAcc >= args.minSentimentAcc;

  const summary = {
    totalCases: cases.length,
    relevantAccuracy: relAcc,
    sentimentAccuracy: sentAcc,
    relevantCorrect, relevantTotal,
    sentimentCorrect, sentimentTotal,
    relevantPass: relPass,
    sentimentPass: sentPass,
    thresholds: { minRelevantAcc: args.minRelevantAcc, minSentimentAcc: args.minSentimentAcc },
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, failures }, null, 2));
  } else {
    console.log('\n' + '='.repeat(60));
    console.log('Buzz Classifier Eval');
    console.log('='.repeat(60));
    console.log(`Cases:               ${summary.totalCases}`);
    console.log(`is_relevant acc:     ${(relAcc * 100).toFixed(1)}% (${relevantCorrect}/${relevantTotal})  [threshold ${(args.minRelevantAcc * 100).toFixed(0)}%]  ${relPass ? 'PASS' : 'FAIL'}`);
    console.log(`sentiment acc:       ${(sentAcc * 100).toFixed(1)}% (${sentimentCorrect}/${sentimentTotal})  [threshold ${(args.minSentimentAcc * 100).toFixed(0)}%]  ${sentPass ? 'PASS' : 'FAIL'}`);

    if (failures.length > 0) {
      console.log('\nFAILURES');
      console.log('-'.repeat(60));
      for (const f of failures) {
        console.log(`\n[case ${f.id}] kind=${f.kind}`);
        console.log(`  body:      ${f.body}`);
        console.log(`  expected:  ${JSON.stringify(f.expected)}`);
        if (f.predicted) console.log(`  predicted: ${JSON.stringify({is_relevant: f.predicted.is_relevant, sentiment: f.predicted.sentiment})}`);
        console.log(`  rationale: ${f.rationale}`);
      }
    }
    console.log('');
  }

  process.exit(relPass && sentPass ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Eval failed:', err.message);
    process.exit(2);
  });
}

module.exports = { parseArgs, main };
