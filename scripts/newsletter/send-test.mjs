// Send the week's newsletter to thomas.pryor@gmail.com as a transactional email
// (NOT broadcast — per CLAUDE.md rule 16, never use broadcast API for test sends).
//
// The generator emits {{{RESEND_UNSUBSCRIBE_URL}}} as the unsubscribe link —
// that macro is substituted by Resend during BROADCAST sends. Transactional
// sends don't substitute it, so we expand it ourselves here using the
// canonical buildUnsubscribeUrl from scripts/lib/email-templates.js.
//
// Env vars:
//   RESEND_API_KEY               required
//   NEWSLETTER_TEST_RECIPIENT    default thomas.pryor@gmail.com
//   NEWSLETTER_SLUG              default A-<latest>; format A-YYYY-MM-DD
//   NEWSLETTER_OUT_DIR           where the generator wrote the HTML + meta;
//                                defaults match generate.mjs's resolution
//   NEWSLETTER_SUBJECT_PREFIX    optional prefix (e.g. "[DRAFT]") prepended
//                                to the subject from meta.json — used by the
//                                Saturday auto-draft workflow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
const cjsRequire = createRequire(import.meta.url);
const { buildUnsubscribeUrl, buildFromAddress, buildReplyToAddress, resolveNewsletterEdition } = cjsRequire(path.join(repo, 'scripts/lib/email-templates'));

const KEY = process.env.RESEND_API_KEY;
if (!KEY) { console.error('No RESEND_API_KEY'); process.exit(1); }

const RECIPIENT = process.env.NEWSLETTER_TEST_RECIPIENT || 'thomas.pryor@gmail.com';
// Edition drives the sender name + unsubscribe market so the WE preview looks
// exactly like the WE broadcast (from "West End Scorecard", WE unsubscribe).
const EDITION = resolveNewsletterEdition(process.env.NEWSLETTER_EDITION); // throws on typos/unknown editions
const FROM_EMAIL = buildFromAddress(EDITION);
// Same Reply-To as the real broadcast so the test email is a faithful preview
// of what subscribers get (including where a reply would land).
const REPLY_TO = buildReplyToAddress();
const SLUG = process.env.NEWSLETTER_SLUG || 'A-2026-05-18';
// Match generate.mjs's output resolution: env override > iCloud path > repo-local.
const OUT_DIR = process.env.NEWSLETTER_OUT_DIR
  || (fs.existsSync(path.join(process.env.HOME || '', 'Documents/claude-outputs'))
    ? path.join(process.env.HOME, 'Documents/claude-outputs/newsletter-mocks')
    : path.join(repo, 'data/newsletter-drafts'));
const htmlPath = `${OUT_DIR}/${SLUG}.html`;
const metaPath = `${OUT_DIR}/${SLUG}.meta.json`;

const htmlRaw = fs.readFileSync(htmlPath, 'utf8');
const unsubUrl = buildUnsubscribeUrl(RECIPIENT, EDITION);
const html = htmlRaw.replace(/\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/g, unsubUrl);

// Subject comes from the generator's meta.json sidecar (machine-readable,
// includes per-section fired/skipped report). Falls back to HTML-comment
// SUBJECT marker, then a static preview label.
let subject = 'Weekly Round-up · preview';
try {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (meta.subject) subject = meta.subject;
  // Same edition gate as create-broadcast-draft.mjs: a WE preview over stale
  // Broadway HTML (shared A-<week> slug) would send the owner a mislabeled
  // "West End Scorecard" email wrapping Broadway content — and get approved.
  // Legacy metas without the stamp are Broadway.
  const metaEdition = meta.edition || 'broadway';
  if (metaEdition !== EDITION) {
    console.error(`Generated HTML is the "${metaEdition}" edition but NEWSLETTER_EDITION=${EDITION} — re-run generate.mjs under this edition first.`);
    process.exit(1);
  }
} catch (e) {
  if (e && e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
  const subjMatch = htmlRaw.match(/<!--\s*SUBJECT:\s*(.+?)\s*-->/);
  if (subjMatch) subject = subjMatch[1];
}
// Optional prefix — used by the Saturday auto-draft workflow to tag the
// preview email "[DRAFT] …" so it reads as a draft, not a real send.
if (process.env.NEWSLETTER_SUBJECT_PREFIX) {
  subject = `${process.env.NEWSLETTER_SUBJECT_PREFIX} ${subject}`;
}

// Guard: never fire accidentally from local testing or regression runs.
// CI=true (GitHub Actions) allows the send; locally set NEWSLETTER_SEND=1
// or pass --force to override.
const ALLOW_SEND = process.env.CI === 'true'
  || process.env.NEWSLETTER_SEND === '1'
  || process.argv.includes('--force');
if (!ALLOW_SEND) {
  console.log('[DRY RUN] Would send to:', RECIPIENT);
  console.log('[DRY RUN] From:', FROM_EMAIL);
  console.log('[DRY RUN] Reply-To:', REPLY_TO);
  console.log('[DRY RUN] Subject:', subject);
  console.log('[DRY RUN] Set NEWSLETTER_SEND=1 or pass --force to actually send.');
  process.exit(0);
}

const body = {
  from: FROM_EMAIL,
  reply_to: REPLY_TO,
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
