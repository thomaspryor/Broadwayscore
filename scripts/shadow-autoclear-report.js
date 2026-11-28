#!/usr/bin/env node
/**
 * shadow-autoclear-report.js — the S3-T4 48h shadow comparison report.
 *
 * Reads the live shadow log (data/audit/autoclear-shadow.jsonl, appended by the
 * hourly audit-t1-silent-gaps.js sweep — one entry per would-auto-clear
 * candidate observed), replays the two known cases (Grace = positive, Cyrano =
 * negative) through the SAME wouldAutoClear() logic to prove it agrees with
 * human triage, and prints the evidence verdict that S3-T5 consults.
 *
 * Verdict is 'clean' ONLY with ≥3 live observed candidates over ≥48h AND every
 * one human-reviewed 'agree' AND zero disagreements. Otherwise
 * 'insufficient-evidence' → auto-clear STAYS OFF (escalate-only). A human marks
 * each shadow-log entry's humanVerdict ('agree'/'disagree') during the window.
 *
 * Usage:
 *   node scripts/shadow-autoclear-report.js            # human-readable
 *   node scripts/shadow-autoclear-report.js --json     # machine verdict
 * Writes: data/audit/autoclear-shadow-report.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { wouldAutoClear, assessShadowEvidence } = require('./lib/autoclear-shadow');

const ROOT = process.env.BSC_DATA_ROOT || path.join(__dirname, '..');
const AUDIT_DIR = path.join(ROOT, 'data', 'audit');
const SHADOW_LOG = path.join(AUDIT_DIR, 'autoclear-shadow.jsonl');
const REPORT_PATH = path.join(AUDIT_DIR, 'autoclear-shadow-report.json');

const asJson = process.argv.includes('--json');

// Replay fixtures — the two documented cases the plan requires (S3-T4 VERIFY).
const REPLAY = {
  'grace (positive)': {
    file: { wrongProduction: true, wrongProductionFlaggedAt: '2026-04-15T19:50:55.444Z',
      contentVerification: { isValid: true, wrongProduction: false, wrongArticle: false,
        confidence: 'high', verifiedAt: '2026-06-06T06:04:00.397Z' } },
    expectClear: true,
  },
  'cyrano (negative)': {
    file: { wrongProduction: true, wrongProductionFlaggedAt: '2026-04-15T00:00:00.000Z',
      contentVerification: { isValid: false, wrongProduction: true, confidence: 'high',
        verifiedAt: '2026-06-06T00:00:00.000Z' } },
    expectClear: false,
  },
};

function readObservations() {
  try {
    return fs.readFileSync(SHADOW_LOG, 'utf8').split('\n')
      .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function windowHours(obs) {
  const ts = obs.map((o) => Date.parse(o.observedAt)).filter((n) => !Number.isNaN(n));
  if (ts.length < 2) return 0;
  return (Math.max(...ts) - Math.min(...ts)) / 3600000;
}

function main() {
  const observations = readObservations();

  // Replay validation — both known cases must classify correctly, else the
  // shadow logic itself is broken and the report fails loudly.
  const replay = {};
  let replayAllCorrect = true;
  for (const [name, { file, expectClear }] of Object.entries(REPLAY)) {
    const got = wouldAutoClear(file).clear;
    const correct = got === expectClear;
    if (!correct) replayAllCorrect = false;
    replay[name] = { expectClear, got, correct };
  }

  const evidence = assessShadowEvidence({ observations, windowHours: windowHours(observations) });

  const report = {
    generatedAt: new Date().toISOString(),
    liveObservations: observations.length,
    windowHours: Number(windowHours(observations).toFixed(2)),
    replay,
    replayAllCorrect,
    evidence,
    // The gate S3-T5 consults: enabling auto-clear requires BOTH clean evidence
    // AND correct replay. Anything else keeps auto-clear OFF (escalate-only).
    autoClearEnableAllowed: evidence.verdict === 'clean' && replayAllCorrect,
  };

  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  console.log('=== Auto-clear shadow report (S3-T4) ===');
  console.log(`Replay validation: ${replayAllCorrect ? '✅ both cases correct' : '❌ MISCLASSIFIED'}`);
  for (const [name, r] of Object.entries(replay)) {
    console.log(`  ${r.correct ? '✔' : '✗'} ${name}: would-clear=${r.got} (expected ${r.expectClear})`);
  }
  console.log(`\nLive observations: ${observations.length} over ${report.windowHours}h`);
  console.log(`Evidence verdict: ${evidence.verdict.toUpperCase()}`);
  if (evidence.reasons.length) evidence.reasons.forEach((r) => console.log(`   • ${r}`));
  console.log(`\nAuto-clear enable allowed? ${report.autoClearEnableAllowed ? 'YES' : 'NO — stay escalate-only'}`);
  console.log(`Report written: ${REPORT_PATH}`);
}

main();
