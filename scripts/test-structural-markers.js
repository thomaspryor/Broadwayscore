#!/usr/bin/env node
/**
 * Test LLM extractor structural markers against archived aggregator pages.
 *
 * Expected behavior:
 * - DTLI pages should score DTLI markers=true, BWW markers=false
 * - BWW roundup pages should score BWW markers=true, DTLI markers=false
 * - Both detections should be highly accurate (>95%)
 */

const fs = require('fs');
const path = require('path');
const { hasStructuralMarkers, cleanHtmlForLLM } = require('./lib/llm-extractor');

function testDirectory(dir, expectedAggregator, sampleSize) {
  if (!fs.existsSync(dir)) {
    console.log(`✗ Directory not found: ${dir}`);
    return { total: 0, truePositive: 0, falseNegative: 0, falsePositive: 0 };
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.html') || f.endsWith('.json'));
  const sample = files.slice(0, sampleSize);

  let truePositive = 0;  // detects own aggregator correctly
  let falseNegative = 0; // fails to detect own aggregator
  let falsePositive = 0; // incorrectly detects OTHER aggregator
  const falseNegExamples = [];
  const falsePosExamples = [];

  const otherAggregator = expectedAggregator === 'dtli' ? 'bww' : 'dtli';

  for (const f of sample) {
    try {
      let content = fs.readFileSync(path.join(dir, f), 'utf8');
      // If JSON, might be wrapped — extract html field or use as-is
      if (f.endsWith('.json')) {
        try {
          const parsed = JSON.parse(content);
          content = parsed.html || parsed.body || content;
        } catch { /* use raw */ }
      }

      const detectsOwn = hasStructuralMarkers(content, expectedAggregator);
      const detectsOther = hasStructuralMarkers(content, otherAggregator);

      if (detectsOwn) truePositive++;
      else {
        falseNegative++;
        if (falseNegExamples.length < 3) falseNegExamples.push({ file: f, size: content.length });
      }
      if (detectsOther) {
        falsePositive++;
        if (falsePosExamples.length < 3) falsePosExamples.push({ file: f, size: content.length });
      }
    } catch (e) {
      // skip unreadable files
    }
  }

  return { total: sample.length, truePositive, falseNegative, falsePositive, falseNegExamples, falsePosExamples };
}

function main() {
  const SAMPLE = parseInt(process.argv[2] || '100');
  const archiveBase = '/Users/tompryor/Broadwayscore/data/aggregator-archive';

  console.log(`Testing structural markers against ${SAMPLE} pages per aggregator\n`);

  console.log('=== DTLI pages ===');
  const dtli = testDirectory(path.join(archiveBase, 'dtli'), 'dtli', SAMPLE);
  const dtliAccuracy = dtli.total > 0 ? ((dtli.truePositive / dtli.total) * 100).toFixed(1) : '0';
  console.log(`  Total: ${dtli.total}`);
  console.log(`  True positive (detected as DTLI): ${dtli.truePositive} (${dtliAccuracy}%)`);
  console.log(`  False negative: ${dtli.falseNegative}`);
  console.log(`  False positive (detected as BWW): ${dtli.falsePositive}`);
  if (dtli.falseNegExamples && dtli.falseNegExamples.length > 0) {
    console.log('  FN examples:', dtli.falseNegExamples.slice(0,3).map(e => `${e.file} (${e.size}b)`).join(', '));
  }

  console.log('\n=== BWW roundup pages ===');
  const bww = testDirectory(path.join(archiveBase, 'bww-roundups'), 'bww', SAMPLE);
  const bwwAccuracy = bww.total > 0 ? ((bww.truePositive / bww.total) * 100).toFixed(1) : '0';
  console.log(`  Total: ${bww.total}`);
  console.log(`  True positive (detected as BWW): ${bww.truePositive} (${bwwAccuracy}%)`);
  console.log(`  False negative: ${bww.falseNegative}`);
  console.log(`  False positive (detected as DTLI): ${bww.falsePositive}`);
  if (bww.falseNegExamples && bww.falseNegExamples.length > 0) {
    console.log('  FN examples:', bww.falseNegExamples.slice(0,3).map(e => `${e.file} (${e.size}b)`).join(', '));
  }

  // Also test HTML cleaning truncation
  console.log('\n=== HTML cleaning ===');
  const sampleHtml = fs.readdirSync(path.join(archiveBase, 'dtli')).find(f => f.endsWith('.html'));
  if (sampleHtml) {
    const raw = fs.readFileSync(path.join(archiveBase, 'dtli', sampleHtml), 'utf8');
    const cleaned = cleanHtmlForLLM(raw);
    console.log(`  Raw: ${raw.length} chars → Cleaned: ${cleaned.length} chars (${(cleaned.length/raw.length*100).toFixed(0)}% retained)`);
    console.log(`  Sample cleaned start: ${cleaned.substring(0, 150)}`);
  }

  const anyFailures = dtli.falseNegative > 5 || bww.falseNegative > 5 || dtli.falsePositive > 0 || bww.falsePositive > 0;
  console.log(`\nOverall: ${anyFailures ? 'ISSUES FOUND' : 'PASS'}`);
  process.exit(anyFailures ? 1 : 0);
}

main();
