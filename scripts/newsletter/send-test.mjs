// Send the week's newsletter to thomas.pryor@gmail.com as a transactional email
// (NOT broadcast — per CLAUDE.md rule 16, never use broadcast API for test sends).
//
// The generator emits {{{RESEND_UNSUBSCRIBE_URL}}} as the unsubscribe link —
// that macro is substituted by Resend during BROADCAST sends. Transactional
// sends don't substitute it, so we have to expand it ourselves here using the
// canonical buildUnsubscribeUrl from scripts/lib/email-templates.js.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const cjsRequire = createRequire(import.meta.url);
const { buildUnsubscribeUrl } = cjsRequire('/Users/tompryor/Broadwayscore/scripts/lib/email-templates');

const KEY = process.env.RESEND_API_KEY;
if (!KEY) { console.error('No RESEND_API_KEY'); process.exit(1); }

const RECIPIENT = process.env.NEWSLETTER_TEST_RECIPIENT || 'thomas.pryor@gmail.com';
const SLUG = process.env.NEWSLETTER_SLUG || 'A-2026-05-18';
const OUT_DIR = '/Users/tompryor/Documents/claude-outputs/newsletter-mocks';
const htmlPath = `${OUT_DIR}/${SLUG}.html`;
const metaPath = `${OUT_DIR}/${SLUG}.meta.json`;

const htmlRaw = fs.readFileSync(htmlPath, 'utf8');
const unsubUrl = buildUnsubscribeUrl(RECIPIENT, 'broadway');
const html = htmlRaw.replace(/\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/g, unsubUrl);

// Subject comes from the generator's meta.json sidecar (machine-readable,
// includes per-section fired/skipped report). Falls back to HTML-comment
// SUBJECT marker, then a static preview label.
let subject = 'Weekly Round-up · preview';
try {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (meta.subject) subject = meta.subject;
} catch {
  const subjMatch = htmlRaw.match(/<!--\s*SUBJECT:\s*(.+?)\s*-->/);
  if (subjMatch) subject = subjMatch[1];
}

const body = {
  from: 'Broadway Scorecard <updates@broadwayscorecard.com>',
  to: [RECIPIENT],
  subject,
  html,
};

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify(body),
});
const json = await res.json();
if (!res.ok) { console.error('Send failed:', json); process.exit(1); }
console.log('Sent:', json.id);
