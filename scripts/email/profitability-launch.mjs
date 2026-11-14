#!/usr/bin/env node
// One-off launch email for the Profitability Scorecard (BRO-6772 follow-up,
// owner 2026-11-01). Writes <OUT_DIR>/profitability-launch.html + .meta.json in
// the shape scripts/newsletter/send-test.mjs reads, so the owner preview goes
// out through the existing transactional path:
//
//   node scripts/email/profitability-launch.mjs
//   NEWSLETTER_SLUG=profitability-launch NEWSLETTER_OUT_DIR=<dir> \
//     NEWSLETTER_SUBJECT_PREFIX='[DRAFT]' node scripts/newsletter/send-test.mjs
//
// The owner sends the real thing to their list from Resend. This script never
// calls the broadcast API (CLAUDE.md §17).
//
// Screenshots live in public/email/profitability-launch/ (captured from the
// live site 2026-11-01, unlocked). Every number in the copy is read off those
// pages on that date; re-capture and re-check before a later send.
//
// Links carry ?subscriber=1 (applyUtm listLink:true) so the owner's list opens
// the scorecard without its sign-up.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isMainModule } from '../lib/is-main-module.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const { applyUtm } = require(path.join(repo, 'scripts/lib/email-utm.js'));

const SITE = 'https://broadwayscorecard.com';
const IMG = `${SITE}/email/profitability-launch`;
export const SUBJECT = 'Which Broadway shows made money';
export const PREHEADER = 'Since the reopening, 6 of 54 original musicals have paid back their investors.';
export const IMAGES = ['money-hero.png', 'money-show.png', 'money-season.png', 'money-bars.png'];

const GOLD = '#d4a574';
const p = (html, extra = '') => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#d1d5db;${extra}">${html}</p>`;
const a = (href, text) => `<a href="${SITE}${href}" style="color:${GOLD};text-decoration:underline;">${text}</a>`;

function shot(file, alt, href, height) {
  return `<a href="${SITE}${href}" style="display:block;text-decoration:none;"><img src="${IMG}/${file}" alt="${alt}" width="528" height="${height}" style="display:block;width:100%;max-width:528px;height:auto;border:1px solid rgba(255,255,255,0.08);border-radius:12px;background:#1a1a24;"></a>`;
}

function section({ eyebrow, title, image, body }) {
  return `<tr><td style="padding:0 0 12px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" style="background:#1a1a24;border-radius:16px;border:1px solid rgba(255,255,255,0.05);">
    <tr><td style="padding:20px 16px 6px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${GOLD};">${eyebrow}</div>
      <div style="font-size:19px;font-weight:700;color:#fff;line-height:1.3;margin-top:6px;">${title}</div>
    </td></tr>
    <tr><td style="padding:12px 16px 4px;">${image}</td></tr>
    <tr><td style="padding:12px 16px 6px;">${body}</td></tr>
  </table>
</td></tr>`;
}

function button(href, label) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center"><tr><td align="center" bgcolor="${GOLD}" style="border-radius:10px;background:${GOLD};">
  <a href="${SITE}${href}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:700;color:#0f0f14;text-decoration:none;border-radius:10px;">${label}</a>
</td></tr></table>`;
}

function finding(href, big, text) {
  return `<tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
  <a href="${SITE}${href}" style="text-decoration:none;display:block;">
    <div style="font-size:16px;font-weight:700;color:#fff;line-height:1.35;">${big}</div>
    <div style="font-size:13px;color:#9ca3af;margin-top:3px;line-height:1.5;">${text} <span style="color:${GOLD};">&rarr;</span></div>
  </a>
</td></tr>`;
}

export function buildHtml() {
  const body = `
<tr><td style="padding:8px 4px 18px;">
  <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${GOLD};">New on Broadway Scorecard</div>
  <div style="font-size:28px;font-weight:800;color:#fff;line-height:1.2;letter-spacing:-0.02em;margin-top:8px;">The Profitability Scorecard</div>
  <div style="font-size:16px;color:#9ca3af;margin-top:6px;">Who made money on Broadway, and who lost it</div>
</td></tr>
<tr><td style="padding:0 4px 6px;">
  ${p('Since Broadway reopened in September 2021, 54 original musicals have opened. Six have paid back their investors.', 'font-size:17px;color:#fff;font-weight:600;')}
  ${p('Box office alone tells you very little. A show can gross a fortune every week and still lose money. The real numbers are scattered across SEC filings, tax credit applications and trade press, so I pulled them into one place and built a model to fill the gaps. Where you see an estimate, it&rsquo;s ours, and it&rsquo;s marked.')}
</td></tr>
<tr><td style="padding:4px 0 14px;">${shot('money-hero.png', 'Broadway Profitability Scorecard: 403 productions tracked, $2.5B in disclosed capitalization, 96 recoupments on record', '/biz', 298)}</td></tr>
<tr><td style="padding:4px 4px 22px;">
  ${button('/biz', 'See who made money')}
</td></tr>
${section({
  eyebrow: 'On every show page',
  title: 'What it cost, what it costs to run, and whether it paid back',
  image: shot('money-show.png', 'Profitability Scorecard for Oh, Mary!: recouped, $4.5M capitalization, about $300K weekly cost', '/show/oh-mary', 360),
  body: p(`<em>Oh, Mary!</em> raised $4.5M and recouped in November 2024, with the Playbill report linked as the source. For shows still running, you get our estimate of how much they&rsquo;ve paid back so far. Look up any Broadway show and scroll down.`, 'margin:0 0 10px;'),
})}
${section({
  eyebrow: 'Season by season',
  title: 'How much went in, and how much has come back',
  image: shot('money-season.png', '2025-2026 season: 5 of 15 commercial shows recouped, about $72M back of $230M in', '/biz/season/2025-2026', 257),
  body: p(`Last season, 5 of 15 commercial shows have recouped so far, and about $72M of the $230M invested has come back. Every season since 2014-15 has a page like this, with every show in it. ${a('/biz/season/2025-2026', 'See 2025-26')}.`, 'margin:0 0 10px;'),
})}
${section({
  eyebrow: 'What Broadway is betting on',
  title: 'Revivals took over last season',
  image: shot('money-bars.png', 'Production mix by season: original musicals, musical revivals, original plays and play revivals', '/biz', 154),
  body: p(`Revivals were 56% of last season&rsquo;s productions, against 34% in the ten seasons before it. Money is flowing to what looks safe: star revivals, familiar titles, proven creative teams. The data says that isn&rsquo;t paying off, and the hits often come out of nowhere.`, 'margin:0 0 10px;'),
})}
<tr><td style="padding:0 0 12px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" style="background:#1a1a24;border-radius:16px;border:1px solid rgba(255,255,255,0.05);">
    <tr><td style="padding:20px 16px 4px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${GOLD};">Three places to start</div>
    </td></tr>
    <tr><td style="padding:2px 16px 12px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      ${finding('/biz/fastest-recoups', 'Glengarry Glen Ross recouped in about 6 weeks', 'The fastest payback of any show since the reopening.')}
      ${finding('/biz/biggest-flops', 'Death Becomes Her raised $31.5M and did not pay it back', 'The biggest flop since the reopening, ranked by capital raised.')}
      ${finding('/biz/reviews-and-money', '6 of 17 new musicals with 5+ Tony nominations recouped', 'What critics, audiences and Tony voters predict about the money.')}
    </table></td></tr>
  </table>
</td></tr>
<tr><td style="padding:14px 4px 6px;">
  ${p('It&rsquo;s free. You&rsquo;re on my list, so every link in this email opens the whole thing, no sign-up.')}
  ${p('Spot an error, or have numbers you can share? Just reply.')}
  ${p('Tom', 'color:#fff;font-weight:600;margin:4px 0 0;')}
</td></tr>`;

  const html = `<!DOCTYPE html>
<!-- SUBJECT: ${SUBJECT} -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark only">
<meta name="supported-color-schemes" content="dark only">
<title>${SUBJECT}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  :root, body { color-scheme: dark only !important; supported-color-schemes: dark only !important; }
  body, html { background:#0f0f14 !important; }
  [data-ogsc] [bgcolor="#0f0f14"], [data-ogsb] [bgcolor="#0f0f14"], [bgcolor="#0f0f14"] { background-color:#0f0f14 !important; }
  [data-ogsc] [bgcolor="#1a1a24"], [data-ogsb] [bgcolor="#1a1a24"], [bgcolor="#1a1a24"] { background-color:#1a1a24 !important; }
  u + #body, u + #body .gmail-dark-bg { background:#0f0f14 !important; }
  @media (prefers-color-scheme: light) { body, html { background-color:#0f0f14 !important; color:#f3f4f6 !important; } }
  @media (max-width: 480px) { .wrap { padding:16px 10px !important; } }
</style>
</head>
<u></u>
<body id="body" class="gmail-dark-bg" style="margin:0;padding:0;background:#0f0f14;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f3f4f6;-webkit-font-smoothing:antialiased;">
<div style="display:none !important;max-height:0;overflow:hidden;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;color:transparent;opacity:0;">${PREHEADER}${'&zwnj; &nbsp; '.repeat(40)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#0f0f14" class="gmail-dark-bg"><tr><td align="center" bgcolor="#0f0f14" class="wrap" style="padding:24px 16px;background-color:#0f0f14;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
<tr><td align="center" style="padding:0 4px 18px;">
  <a href="${SITE}/" style="text-decoration:none;color:inherit;display:inline-block;"><span style="font-size:22px;font-weight:700;color:#fff;letter-spacing:-0.02em;">Broadway</span><span style="font-size:22px;font-weight:700;color:${GOLD};letter-spacing:-0.02em;">Scorecard</span><span style="font-size:9px;color:#6b7280;font-weight:400;vertical-align:super;margin-left:1px;">&trade;</span></a>
</td></tr>
${body}
<tr><td align="center" style="padding:32px 4px 8px;">
  <div style="border-top:1px solid rgba(255,255,255,0.05);padding-top:22px;">
    <div style="font-size:13px;color:#9ca3af;">Every show. Every review. One score.</div>
    <div style="font-size:11px;color:#6b7280;margin-top:14px;">
      <a href="${SITE}/methodology" style="color:#9ca3af;text-decoration:none;">How we measure</a> &nbsp;&middot;&nbsp;
      <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#9ca3af;text-decoration:none;">Unsubscribe</a>
    </div>
    <div style="font-size:10px;color:#4b5563;margin-top:14px;">&copy; 2026 Broadway Scorecard&trade; LLC</div>
  </div>
</td></tr>
</table>
</td></tr></table>
</body>
</html>`;
  return applyUtm(html, { source: 'newsletter', campaign: 'profitability-launch', listLink: true });
}

if (isMainModule(import.meta.url)) {
  const outDir = process.env.NEWSLETTER_OUT_DIR || path.join(os.tmpdir(), 'profitability-launch');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'profitability-launch.html'), buildHtml());
  fs.writeFileSync(path.join(outDir, 'profitability-launch.meta.json'), JSON.stringify({ subject: SUBJECT, preheader: PREHEADER, edition: 'broadway' }, null, 2));
  console.log(`wrote ${outDir}/profitability-launch.html`);
}
