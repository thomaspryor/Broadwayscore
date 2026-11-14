#!/usr/bin/env node
/**
 * content-verifier-eval.js
 *
 * Accuracy eval for scripts/lib/content-verifier.js. Runs the real LLM
 * verifier against a golden fixture mined from production data (review-texts
 * where contentVerification.isValid was later contradicted by human flags:
 * wrongProduction, wrongShow, isRoundupArticle, wrongArticle).
 *
 * Reports:
 *   - Overall accuracy
 *   - False-positive rate (garbage called valid — the 33% production problem)
 *   - False-negative rate (clean called invalid)
 *   - Confusion matrix + per-failure drilldown
 *
 * Exits non-zero below thresholds. Calls real LLM (Gemini → OpenAI → Claude
 * fallback chain). 30 cases ≈ $0.01 in Gemini Flash tokens.
 *
 * Usage:
 *   node scripts/evals/content-verifier-eval.js
 *   node scripts/evals/content-verifier-eval.js --json
 *   node scripts/evals/content-verifier-eval.js --min-precision 0.90 --min-recall 0.80
 *   node scripts/evals/content-verifier-eval.js --fixture PATH
 */

const fs = require('fs');
const path = require('path');
const { verifyContent } = require('../lib/content-verifier');

const DEFAULT_FIXTURE = path.join(
  __dirname, '..', '..',
  'tests', 'fixtures', 'content-verifier-golden', 'real-world-fixtures.json'
);

function parseArgs(argv) {
  // Precision = among LLM "valid" claims, fraction actually clean.
  //   The documented 33% FP rate means precision is ~67% — we want to raise it.
  // Recall = among actually-clean pages, fraction the LLM called valid.
  //   A too-strict LLM that rejects lots of real reviews hurts coverage.
  const args = {
    json: false,
    minPrecision: 0.80,
    minRecall: 0.70,
    fixture: DEFAULT_FIXTURE,
    concurrency: 3,
  };
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--json') args.json = true;
    else if (a === '--fixture') args.fixture = list[++i];
    else if (a === '--min-precision') args.minPrecision = parseFloat(list[++i]);
    else if (a === '--min-recall') args.minRecall = parseFloat(list[++i]);
    else if (a === '--concurrency') args.concurrency = parseInt(list[++i]);
    else if (a === '--help') {
      console.log('Usage: content-verifier-eval.js [--fixture PATH] [--json] [--min-precision F] [--min-recall F] [--concurrency N]');
      process.exit(0);
    }
  }
  return args;
}

async function runOne(caseObj) {
  const { input, expected } = caseObj;
  const result = await verifyContent(input);
  const predValid = !!result.isValid;
  return { caseObj, result, predValid, expectedValid: !!expected.isValid };
}

async function runWithConcurrency(cases, concurrency) {
  const out = [];
  let idx = 0;
  async function worker() {
    while (idx < cases.length) {
      const i = idx++;
      process.stderr.write(`[${i + 1}/${cases.length}] ${cases[i].id}...\n`);
      out[i] = await runOne(cases[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const fixture = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));
  const cases = fixture.cases;

  if (!args.json) console.log(`Running ${cases.length} cases (concurrency=${args.concurrency})…`);

  const results = await runWithConcurrency(cases, args.concurrency);

  // Confusion matrix
  let tp = 0, tn = 0, fp = 0, fn = 0;
  const fpList = [];
  const fnList = [];
  for (const r of results) {
    if (r.expectedValid && r.predValid) tp++;
    else if (!r.expectedValid && !r.predValid) tn++;
    else if (!r.expectedValid && r.predValid) { fp++; fpList.push(r); }
    else { fn++; fnList.push(r); }
  }

  const precision = (tp + fp) ? tp / (tp + fp) : 1;
  const recall = (tp + fn) ? tp / (tp + fn) : 1;
  const accuracy = (tp + tn) / results.length;
  const fpRate = (fp + tn) ? fp / (fp + tn) : 0;

  const precPass = precision >= args.minPrecision;
  const recallPass = recall >= args.minRecall;

  const summary = {
    totalCases: cases.length,
    truePositives: tp,
    trueNegatives: tn,
    falsePositives: fp,
    falseNegatives: fn,
    precision, recall, accuracy, fpRate,
    precisionPass: precPass,
    recallPass,
    thresholds: args,
  };

  if (args.json) {
    console.log(JSON.stringify({
      summary,
      falsePositives: fpList.map(r => ({
        id: r.caseObj.id,
        garbageFlags: r.caseObj.garbage_flags,
        llm_claimed: r.caseObj.llm_claimed,
        predicted_now: r.result,
        excerpt: r.caseObj.input.scrapedText.slice(0, 200),
      })),
      falseNegatives: fnList.map(r => ({
        id: r.caseObj.id,
        predicted_now: r.result,
        excerpt: r.caseObj.input.scrapedText.slice(0, 200),
      })),
    }, null, 2));
  } else {
    console.log('\n' + '='.repeat(60));
    console.log('Content Verifier Eval');
    console.log('='.repeat(60));
    console.log(`Cases:            ${summary.totalCases}`);
    console.log(`TP / TN / FP / FN: ${tp} / ${tn} / ${fp} / ${fn}`);
    console.log(`Precision:        ${(precision * 100).toFixed(1)}%  [threshold ${(args.minPrecision * 100).toFixed(0)}%]  ${precPass ? 'PASS' : 'FAIL'}`);
    console.log(`Recall:           ${(recall * 100).toFixed(1)}%  [threshold ${(args.minRecall * 100).toFixed(0)}%]  ${recallPass ? 'PASS' : 'FAIL'}`);
    console.log(`Accuracy:         ${(accuracy * 100).toFixed(1)}%`);
    console.log(`FP rate on garbage: ${(fpRate * 100).toFixed(1)}%  ← the production problem`);

    if (fpList.length > 0) {
      console.log('\nFALSE POSITIVES (LLM said valid on known garbage)');
      console.log('-'.repeat(60));
      for (const r of fpList) {
        console.log(`\n[${r.caseObj.id}]`);
        console.log(`  human flags: ${JSON.stringify(r.caseObj.garbage_flags)}`);
        console.log(`  LLM now says: isValid=${r.result.isValid}, wrongProd=${r.result.wrongProduction}, wrongArticle=${r.result.wrongArticle}`);
        console.log(`  reasoning:   ${(r.result.reasoning || '').slice(0, 140)}`);
      }
    }

    if (fnList.length > 0) {
      console.log('\nFALSE NEGATIVES (LLM said invalid on known-clean review)');
      console.log('-'.repeat(60));
      for (const r of fnList) {
        console.log(`\n[${r.caseObj.id}]`);
        console.log(`  LLM now says: isValid=${r.result.isValid}`);
        console.log(`  issues: ${JSON.stringify(r.result.issues)}`);
      }
    }
    console.log('');
  }

  process.exit(precPass && recallPass ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Eval failed:', err.message);
    console.error(err.stack);
    process.exit(2);
  });
}

module.exports = { parseArgs, main };
