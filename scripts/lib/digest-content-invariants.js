/**
 * digest-content-invariants.js — card #670.
 *
 * Card #634 shipped "Fix this" dispatch buttons in the morning digest with a
 * recorded ship-check verdict, and the buttons reached ZERO delivered emails
 * for a day: the renderer was fully unit-tested (attachHealthFixUrls given a
 * fixUrl draws a button), but nothing in the pipeline asserted that the
 * ASSEMBLED, about-to-send email actually carries the properties that
 * matter. monitor-scheduled-email-count.js only counts sends; it has never
 * looked at what's inside one.
 *
 * These are pure checks over the final {subject, html} pair — the same pair
 * scripts/send-morning-digest.js POSTs to Resend — so a caller gap (a
 * renderer that works but never gets invoked with the right input) is
 * exactly what these catch. Also wired as a fail-soft pre-send WARN in
 * send-morning-digest.js's main() (ship-check adversarial finding, codex
 * 2026-07-30: a CI-only test does not protect a bug introduced anywhere
 * other than composeDigestEmail() itself — a runtime check is defense in
 * depth for that gap, never a send-blocker per the "digest must always
 * send" rule already established in that file).
 */
'use strict';

const DISPATCH_HOST = 'broadwayscorecard.com';

// Matches href="...api/autonomous-action?..." attributes. esc() upstream
// (autonomous-email-render.js) turns '&' into '&amp;' in the attribute, so
// callers must unescape before URL-parsing (done in extractActionUrls).
const ACTION_HREF_RE = /href="([^"]*\/api\/autonomous-action\?[^"]*)"/g;

function extractActionUrls(html) {
  const urls = [];
  let m;
  ACTION_HREF_RE.lastIndex = 0;
  while ((m = ACTION_HREF_RE.exec(html))) {
    urls.push(m[1].replace(/&amp;/g, '&'));
  }
  return urls;
}

// Anchor-scoped, not a bare "Fix this" substring search (ship-check
// adversarial finding, codex 2026-07-30: a raw substring match would count
// plain prose containing the phrase as a button, and would not require it
// to actually be a link).
const FIX_THIS_BUTTON_RE = /<a\b[^>]*>\s*Fix this\b/gi;

function countFixThisButtons(html) {
  const m = html.match(FIX_THIS_BUTTON_RE);
  return m ? m.length : 0;
}

/**
 * Assert content invariants on an assembled digest email.
 * @param {string} html - the full email HTML about to be sent
 * @param {{health?: object|null, subject?: string, verifySecret?: string}} opts
 *   verifySecret, if given, upgrades the sig check from hex-shape-only to a
 *   real HMAC recheck via dispatch-link.js's verifyDispatchSignature — every
 *   dispatch URL's own conditionKey/title/description/exp params are
 *   sufficient to recompute it (ship-check adversarial finding, codex
 *   2026-07-30: shape-only checking would pass a well-formed but wrong sig).
 * @returns {{ok: boolean, violations: string[]}}
 */
function assertDigestInvariants(html, { health = null, subject, verifySecret } = {}) {
  const violations = [];

  if (typeof html !== 'string' || !html.trim()) {
    return { ok: false, violations: ['html is empty or not a string'] };
  }

  // Every health ERROR that attachHealthFixUrls would actually attach a
  // fixUrl to (it skips nameless entries — dispatch-link.js's own
  // `if (!e || !e.name) continue`) must carry a tappable "Fix this →"
  // button. Counting nameless entries here would flag correct fail-soft
  // behavior as a violation (ship-check adversarial finding, codex
  // 2026-07-30).
  // Digest v3 (owner mandate 2026-08-02): the email must NEVER ask. Zero
  // Fix-this buttons — auto-dispatch replaced them — and every named health
  // row must appear inside the "Automation queue" block with a status line
  // (renderAutofixBlock's header text; renamed from "Being fixed
  // automatically" by the BRO-286 honesty fix, task #1220/#1311 class —
  // keep this comment and the check below in sync with that literal).
  // Forbidden sections are the telemetry the owner called
  // unintelligible/useless; their headings reappearing is a regression.
  const fixCount = countFixThisButtons(html);
  if (fixCount !== 0) {
    violations.push(`Digest v3 renders NO Fix-this buttons (auto-dispatch replaced them) — found ${fixCount}`);
  }
  const FORBIDDEN_HEADINGS = ['Closing soon', 'Score drift', 'Backlog drain', 'T1 Coverage Scoreboard', 'Deployed coverage', 'Fixes &amp; features merged'];
  for (const h of FORBIDDEN_HEADINGS) {
    if (html.includes(h)) violations.push(`forbidden section "${h}" rendered — deleted by the 2026-08-02 owner mandate`);
  }
  // Owner mandate 2026-08-02: a "Needs your attention" section with zero
  // clickable action links is a prose-only ask — banned. (view links or
  // signed Dispatch-a-fix buttons both count; the sig checks below still
  // validate any dispatch URLs.)
  if (html.includes('Needs your attention')) {
    const block = html.slice(html.indexOf('Needs your attention'));
    if (!/<a\b[^>]*href=/.test(block)) {
      violations.push('"Needs your attention" section has no clickable action — prose-only asks are banned (owner mandate 2026-08-02)');
    }
  }

  const { selectHealthRows } = require('./autonomous-email-render.js');
  const namedRows = health
    ? selectHealthRows({ errors: health.errors, warns: health.warns }).rows.filter((r) => r && r.name)
    : [];
  if (namedRows.length > 0 && !html.includes('Automation queue')) {
    violations.push(`health has ${namedRows.length} named issue(s) but no "Automation queue" block — the email is asking or hiding instead of fixing`);
  }

  // Every dispatch action URL must be a live, correctly-signed link — a
  // malformed baseUrl/secret must not produce a button that 404s or, worse,
  // silently verifies against the wrong host.
  for (const url of extractActionUrls(html)) {
    let u;
    try { u = new URL(url); } catch { violations.push(`unparseable action URL: ${url}`); continue; }
    if (u.protocol !== 'https:') violations.push(`action URL is not https: ${url}`);
    if (u.hostname !== DISPATCH_HOST) violations.push(`action URL host is "${u.hostname}", expected "${DISPATCH_HOST}": ${url}`);
    const sig = u.searchParams.get('sig');
    if (!sig || !/^[0-9a-f]{64}$/.test(sig)) {
      violations.push(`action URL missing/invalid 64-hex sig: ${url}`);
    } else if (verifySecret) {
      const { verifyDispatchSignature } = require('./dispatch-link.js');
      const valid = verifyDispatchSignature({
        conditionKey: u.searchParams.get('conditionKey') || '',
        title: u.searchParams.get('title') || '',
        description: u.searchParams.get('description') || '',
        exp: u.searchParams.get('exp') || '',
        secret: verifySecret,
        sig,
      });
      if (!valid) violations.push(`action URL sig does not verify against the given secret: ${url}`);
    }
  }

  // Unrendered template artifacts — the classic symptom of a broken
  // interpolation (`${x}` where x is undefined/NaN, or an object stringified
  // by accident). Bounded to a bare tag-delimited text node so a legitimate
  // error message that happens to CONTAIN the word "undefined" (e.g. a
  // stack trace snippet) doesn't false-positive.
  if (/>(?:undefined|NaN)</.test(html)) {
    violations.push('unrendered template artifact (bare "undefined"/"NaN" text node) found in html');
  }
  if (html.includes('[object Object]')) {
    violations.push('literal "[object Object]" found in rendered html');
  }

  if (subject !== undefined) {
    if (typeof subject !== 'string' || !subject.trim()) violations.push('subject is empty');
    else if (subject.length >= 120) violations.push(`subject is ${subject.length} chars, must be < 120`);
  }

  return { ok: violations.length === 0, violations };
}

module.exports = { assertDigestInvariants, extractActionUrls, countFixThisButtons, DISPATCH_HOST };
