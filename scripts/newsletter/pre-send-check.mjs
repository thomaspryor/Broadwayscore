// Pre-send validation for the weekly newsletter.
// Catches the class of issues found during the 2026-06-07 newsletter session.
//
// Two tiers:
//   HARD (exit 1, workflow stops): would embarrass us if sent to all subscribers
//     - Missing unsubscribe link
//     - Zero BSC links have UTMs (total tracking blackout)
//   SOFT (warning banner injected into draft HTML): owner sees issues in the
//     preview email and decides whether to fix before broadcasting
//     - Non-empty <title> tag
//     - Pill spans missing inline margin-right
//     - Subject too long / contains em dash / has banned prefix
//     - Lede contains em dash
//     - Too few sections fired / no opening section
//     - Missing preheader
//
// Runs AFTER generate.mjs, BEFORE send-test.mjs in newsletter-draft.yml.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const weekStart = process.argv[2] || (() => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
})();

const outDir = process.env.NEWSLETTER_OUT_DIR
  || path.join(process.env.HOME || '', 'Documents/claude-outputs/newsletter-mocks');
const htmlPath = path.join(outDir, `A-${weekStart}.html`);
const metaPath = path.join(outDir, `A-${weekStart}.meta.json`);

if (!fs.existsSync(htmlPath) || !fs.existsSync(metaPath)) {
  console.error(`pre-send-check: missing HTML or meta for week ${weekStart}`);
  process.exit(1);
}

let html = fs.readFileSync(htmlPath, 'utf8');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

const hardFailures = [];  // stop the workflow entirely
const softIssues = [];    // inject into draft banner so owner sees them

// ── HARD: unsubscribe placeholder ────────────────────────────────────────────
if (!html.includes('{{{RESEND_UNSUBSCRIBE_URL}}}')) {
  hardFailures.push('Unsubscribe placeholder {{{RESEND_UNSUBSCRIBE_URL}}} is missing — subscribers cannot opt out');
}

// ── HARD: UTM tracking ────────────────────────────────────────────────────────
const bscLinks = [...html.matchAll(/href="(https:\/\/broadwayscorecard\.com[^"]+)"/g)].map(m => m[1]);
const withUtm = bscLinks.filter(u => u.includes('utm_source'));
if (bscLinks.length > 0 && withUtm.length === 0) {
  hardFailures.push('No BSC links have UTM params — total tracking blackout');
} else {
  const missingUtm = bscLinks.filter(u => !u.includes('utm_source') && !u.includes('unsubscribe'));
  if (missingUtm.length > 0) {
    softIssues.push(`${missingUtm.length} BSC link(s) missing UTMs: ${missingUtm.slice(0, 2).map(u => u.replace('https://broadwayscorecard.com', '')).join(', ')}`);
  }
}

// ── SOFT: <title> tag ─────────────────────────────────────────────────────────
const titleMatch = html.match(/<title>([^<]*)<\/title>/);
if (titleMatch && titleMatch[1].trim()) {
  softIssues.push(`<title> is non-empty ("${titleMatch[1].trim()}") — Gmail renders it as visible text`);
}

// ── SOFT: pill inline styles ──────────────────────────────────────────────────
const pillSpans = html.match(/<span class="gp"[^>]*>/g) || [];
const pillsMissingMargin = pillSpans.filter(s => !s.includes('margin-right'));
if (pillsMissingMargin.length > 0) {
  softIssues.push(`${pillsMissingMargin.length} pill span(s) missing inline margin-right — PLAY+REVIVAL will squish`);
}

// ── SOFT: subject checks ──────────────────────────────────────────────────────
const subject = meta.subject || '';
if (!subject) {
  softIssues.push('Subject line is empty');
} else {
  if (subject.length > 80) softIssues.push(`Subject too long: ${subject.length} chars (max 80)`);
  if (subject.includes('—') || subject.includes('—')) softIssues.push('Subject contains em dash');
  if (/^scorecard weekly:/i.test(subject)) softIssues.push('Subject has banned "Scorecard Weekly:" prefix');
}

// ── SOFT: lede checks ─────────────────────────────────────────────────────────
const ledeRaw = html.match(/border-left:2px solid #d4a574[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
const ledeText = ledeRaw.replace(/<[^>]+>/g, '').trim();
if (!ledeText) {
  softIssues.push('Lede appears empty');
} else if (ledeText.includes('—') || ledeText.includes('—')) {
  softIssues.push('Lede contains em dash — use comma, period, or parentheses');
}

// ── SOFT: section sanity ──────────────────────────────────────────────────────
const fired = meta.sections.filter(s => s.fired);
if (fired.length < 6) softIssues.push(`Only ${fired.length} sections fired (expected ≥ 6)`);
const hasOpening = meta.sections.some(s =>
  ['broadway-openings', 'offbroadway-openings', 'london-openings'].includes(s.name) && s.fired);
if (!hasOpening) softIssues.push('No opening section fired — newsletter has no main story');

// ── SOFT: preheader ───────────────────────────────────────────────────────────
if (!html.includes('display:none !important') || !html.includes('max-height:0')) {
  softIssues.push('Preheader hidden div appears missing — inbox preview text will be wrong');
}

// ── Hard fail: stop the workflow ──────────────────────────────────────────────
if (hardFailures.length > 0) {
  console.error(`\n🛑 Pre-send HARD FAILURE — workflow stopped:\n`);
  for (const f of hardFailures) console.error(`   · ${f}`);
  process.exit(1);
}

// ── Soft issues: inject warning banner into the draft HTML ────────────────────
if (softIssues.length > 0) {
  console.warn(`\n⚠️  Pre-send issues found (${softIssues.length}) — injecting banner into draft:`);
  for (const i of softIssues) console.warn(`   · ${i}`);
  console.warn('   Owner will see these in the preview email.\n');

  // Emit GitHub Actions annotations so they appear in the workflow summary
  for (const i of softIssues) console.warn(`::warning::Pre-send: ${i}`);

  const issueList = softIssues.map(i => `<li style="margin:2px 0;">${i}</li>`).join('');
  const banner = `
<div style="background:#7c2d12;color:#fef2f2;font-family:monospace;font-size:12px;padding:12px 16px;margin:0 0 0 0;border-bottom:2px solid #dc2626;">
  <strong>⚠️ PRE-SEND ISSUES — fix before broadcasting to subscribers:</strong>
  <ul style="margin:6px 0 0 0;padding-left:20px;">${issueList}</ul>
</div>`;

  // Insert banner right after <body ...>
  html = html.replace(/(<body[^>]*>)/, `$1${banner}`);
  fs.writeFileSync(htmlPath, html);
  console.warn('   Banner injected into draft HTML.\n');
}

// ── All clear ─────────────────────────────────────────────────────────────────
console.log(`\n✓ Pre-send check OK for week ${weekStart}`);
console.log(`  Subject (${subject.length} chars): ${subject}`);
console.log(`  ${fired.length} sections fired`);
if (softIssues.length > 0) console.log(`  ⚠️  ${softIssues.length} soft issue(s) flagged in draft banner`);
process.exit(0);
