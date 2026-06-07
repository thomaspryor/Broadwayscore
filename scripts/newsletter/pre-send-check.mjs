// Pre-send validation for the weekly newsletter.
// Catches the class of issues found during the 2026-06-07 newsletter session —
// things that regression-test.mjs (fixture-based section checks) can't catch:
// HTML rendering bugs, content policy violations, missing tracking, etc.
//
// Runs AFTER generate.mjs, BEFORE send-test.mjs in newsletter-draft.yml.
// Exit 0 = all clear. Exit 1 = one or more failures (workflow stops, no email sent).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');

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

const html = fs.readFileSync(htmlPath, 'utf8');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

const failures = [];
const warnings = [];

// ── 1. Title tag must be empty ────────────────────────────────────────────────
// Gmail renders <title> content as preview text and sometimes as visible body
// text. Discovered 2026-06-07. Empty title = no bleed.
const titleMatch = html.match(/<title>([^<]*)<\/title>/);
if (titleMatch && titleMatch[1].trim()) {
  failures.push(`<title> is not empty — Gmail will render "${titleMatch[1].trim()}" as preview/body text`);
}

// ── 2. All broadwayscorecard.com links must have UTM params ──────────────────
const linkRe = /href="(https:\/\/broadwayscorecard\.com[^"]+)"/g;
let m;
const missingUtm = [];
while ((m = linkRe.exec(html)) !== null) {
  const url = m[1];
  if (!url.includes('utm_source') && !url.includes('unsubscribe')) {
    missingUtm.push(url.replace(/https:\/\/broadwayscorecard\.com/, ''));
  }
}
if (missingUtm.length > 0) {
  failures.push(`${missingUtm.length} BSC link(s) missing UTM params:\n    ${missingUtm.slice(0, 3).join('\n    ')}${missingUtm.length > 3 ? `\n    …+${missingUtm.length - 3} more` : ''}`);
}

// ── 3. Unsubscribe placeholder must be present ───────────────────────────────
if (!html.includes('{{{RESEND_UNSUBSCRIBE_URL}}}')) {
  failures.push('Unsubscribe placeholder {{{RESEND_UNSUBSCRIBE_URL}}} is missing');
}

// ── 4. Pills must have inline margin-right (CSS classes get stripped) ─────────
// Pill function must output display:inline-block + margin-right inline so
// adjacent pills (e.g. PLAY + REVIVAL) don't concatenate. Discovered 2026-06-07.
const pillSpans = html.match(/<span class="gp"[^>]*>/g) || [];
const pillsMissingMargin = pillSpans.filter(s => !s.includes('margin-right'));
if (pillsMissingMargin.length > 0) {
  failures.push(`${pillsMissingMargin.length} pill span(s) missing inline margin-right — will concatenate in email clients`);
}

// ── 5. Subject line checks ────────────────────────────────────────────────────
const subject = meta.subject || '';
if (!subject) {
  failures.push('Subject line is empty');
} else {
  if (subject.length > 80) {
    failures.push(`Subject too long: ${subject.length} chars (max 80). "${subject.slice(0, 60)}…"`);
  }
  if (subject.includes('—') || subject.includes('—')) {
    failures.push(`Subject contains em dash: "${subject}"`);
  }
  if (/^scorecard weekly:/i.test(subject)) {
    failures.push(`Subject starts with banned "Scorecard Weekly:" prefix`);
  }
}

// ── 6. Lede checks ────────────────────────────────────────────────────────────
// Extract lede from the blockquote-style div (border-left: amber)
const ledeMatch = html.match(/border-left:2px solid #d4a574[^>]*>([^<]+(?:<[^>]+>[^<]*<\/[^>]+>[^<]*)*)<\/div>/);
const ledeText = ledeMatch
  ? ledeMatch[0].replace(/<[^>]+>/g, '').trim()
  : '';

if (!ledeText) {
  warnings.push('Lede appears empty — check the editorial paragraph');
} else {
  if (ledeText.includes('—') || ledeText.includes('—')) {
    failures.push(`Lede contains em dash. Use comma, period or parentheses instead.`);
  }
  // Show titles should be italicized when they appear in the lede
  // (check for <em> tags in the raw lede HTML)
  const ledeRaw = html.match(/border-left:2px solid #d4a574[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  if (ledeRaw && !ledeRaw.includes('<em>') && ledeRaw.length > 80) {
    warnings.push('Lede has no italicized show titles — consider wrapping show names in <em>');
  }
}

// ── 7. Section sanity ─────────────────────────────────────────────────────────
const fired = meta.sections.filter(s => s.fired);
if (fired.length < 6) {
  failures.push(`Only ${fired.length} sections fired — expected ≥ 6. Something broke.`);
}

// At least one opening section must fire
const openingSections = ['broadway-openings', 'offbroadway-openings', 'london-openings'];
const hasOpening = meta.sections.some(s => openingSections.includes(s.name) && s.fired);
if (!hasOpening) {
  failures.push('No opening section fired (broadway-openings, offbroadway-openings, london-openings) — newsletter has no main story');
}

// ── 8. Preheader must be present and hidden ───────────────────────────────────
if (!html.includes('display:none !important') || !html.includes('max-height:0')) {
  failures.push('Preheader hidden div appears missing — inbox preview text will be wrong');
}

// ── Report ────────────────────────────────────────────────────────────────────
if (warnings.length > 0) {
  console.warn('\n⚠️  Pre-send warnings:');
  for (const w of warnings) console.warn(`   · ${w}`);
}

if (failures.length === 0) {
  console.log(`\n✓ Pre-send check passed for week ${weekStart}`);
  console.log(`  Subject (${subject.length} chars): ${subject}`);
  console.log(`  ${fired.length} sections fired`);
  process.exit(0);
}

console.error(`\n✗ Pre-send check FAILED for week ${weekStart} — ${failures.length} issue(s):`);
for (const f of failures) console.error(`   · ${f}`);
console.error('\nFix these before the email goes out. Workflow stopping.');
process.exit(1);
