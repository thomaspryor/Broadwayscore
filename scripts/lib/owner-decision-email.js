'use strict';
/**
 * owner-decision-email.js (BRO-6147): the ONE-email-per-decision body, with a
 * tap-to-answer button per option and a "reply in my own words" button. Pure:
 * scripts/send-owner-decision-emails.js does the I/O. Copy follows the
 * owner-facing rules: plain English, no em dashes, no card ids in the text.
 */

const { displayQuestion, parseDecisionBlock, answerChoices, signToken, signListToken, questionHash, unescapeMarkdown, collapseSelfLinks, mockupLinks, isVisualQuestion } = require('../../src/lib/owner-decision-link.js');
const { pickEmailImage, fullUrlForThumb } = require('./visual-approval.js');

const BASE_URL = 'https://broadwayscorecard.com';
const SUBJECT_MAX = 90;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// The owner wants no em dashes in email copy; card text sometimes carries them.
function noDash(s) { return unescapeMarkdown(collapseSelfLinks(String(s == null ? '' : s))).replace(/\s*[—–]\s*/g, ', '); }

function answerUrl(token, key, baseUrl = BASE_URL) {
  return `${baseUrl}/api/owner-decision?t=${encodeURIComponent(token)}&o=${encodeURIComponent(key)}`;
}

function listUrl(secret, { now = Date.now(), baseUrl = BASE_URL } = {}) {
  return `${baseUrl}/api/owner-decision/list?t=${encodeURIComponent(signListToken({ secret, now }))}`;
}

function button(href, label, primary) {
  const bg = primary ? '#1a1208' : '#ffffff';
  const fg = primary ? '#ffffff' : '#1a1208';
  return `<a href="${esc(href)}" style="display:block;text-align:center;text-decoration:none;font-weight:700;font-size:16px;padding:14px 16px;border-radius:10px;border:2px solid #1a1208;background:${bg};color:${fg};margin:8px 0;">${esc(noDash(label))}</a>`;
}

/**
 * decision: { identifier, title, url, question }, description: the card text,
 * secret: signing secret. Returns { subject, html, tokenHash }.
 */
function buildDecisionEmail({ decision, description, related = [], secret, now = Date.now(), baseUrl = BASE_URL, reminder = false }) {
  const seeHtml = contextLinksHtml({ decision, links: mockupLinks(description, ...related) });
  const hash = questionHash(decision.question || decision.title);
  const token = signToken({ id: decision.identifier, hash, secret, now });
  const block = parseDecisionBlock(description);
  const choices = answerChoices(description);
  const question = noDash(displayQuestion(decision.question || decision.title));
  const subjectText = question.length > SUBJECT_MAX ? `${question.slice(0, SUBJECT_MAX - 1)}…` : question;
  // BRO-6654: Owner step lines make this a task the owner does by hand, then taps Done.
  const task = block.task;
  const subject = `${reminder ? 'Still waiting: ' : task ? 'Task for you: ' : 'Decision needed: '}${subjectText}`;
  if (task) return { subject, html: taskHtml({ decision, block, choices, question, token, secret, now, baseUrl, reminder, seeHtml }), tokenHash: hash };

  const optionHtml = block.options.length >= 2
    ? block.options.map((o) => `<div style="margin:14px 0 4px;"><div style="font-weight:700;">${esc(o.label)}: ${esc(noDash(o.name))}</div>`
      + (o.upside ? `<div style="color:#2e7d32;">Upside: ${esc(noDash(o.upside))}</div>` : '')
      + (o.downside ? `<div style="color:#b3261e;">Downside: ${esc(noDash(o.downside))}</div>` : '')
      + `</div>${button(answerUrl(token, o.key, baseUrl), `Choose ${o.label}`, true)}`).join('')
    : choices.map((c, i) => button(answerUrl(token, c.key, baseUrl), c.label, i === 0)).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.5;color:#222;">
<div style="max-width:520px;margin:0 auto;">
<p style="margin:0 0 6px;color:#666;font-size:14px;">${reminder ? 'Still waiting on you' : 'Waiting on you'}. Work on this is paused until you answer.</p>
<h2 style="margin:0 0 12px;font-size:20px;line-height:1.3;">${esc(question)}</h2>
${decision.title && decision.title !== decision.question ? `<p style="margin:0 0 12px;color:#666;font-size:14px;">About: ${esc(noDash(displayQuestion(decision.title)))}</p>` : ''}
${seeHtml}
${evidenceHtml(block.evidence)}
${block.why ? `<p style="margin:0 0 12px;"><strong>Why this is your call:</strong> ${esc(noDash(block.why))}</p>` : ''}
${optionHtml}
${block.recommendation ? `<p style="margin:16px 0 6px;"><strong>My recommendation:</strong> ${esc(noDash(block.recommendation))}</p>` : ''}
${block.defaultText ? `<p style="margin:0 0 12px;"><strong>If you do not answer:</strong> ${esc(noDash(block.defaultText))}</p>` : ''}
${button(answerUrl(token, 'own', baseUrl), 'Reply in my own words', false)}
<p style="margin:16px 0 0;color:#666;font-size:13px;">Each button asks you to confirm before anything is saved. This link works for 14 days. If you already answered this in a Claude chat, tell that chat 'record my answer' and it will be saved here.</p>
<p style="margin:10px 0 0;font-size:14px;"><a href="${esc(listUrl(secret, { now, baseUrl }))}" style="color:#1a1208;">See everything waiting on you</a></p>
</div></body></html>`;
  return { subject, html, tokenHash: hash };
}

// BRO-7578: the mockups and the card sit right under the question, above every
// answer button, so the owner sees what they are deciding before deciding it.
function contextLinksHtml({ decision, links }) {
  // Gold and labelled "opens a picture" so it never reads as an answer button.
  const shots = (links || []).map((u, i) => `<a href="${esc(u)}" style="display:block;text-align:center;text-decoration:none;font-weight:700;font-size:16px;padding:14px 16px;border-radius:10px;border:2px solid #d4a574;background:#fbf4ea;color:#1a1208;margin:8px 0;">${links.length > 1 ? `See the mockups (${i + 1})` : 'See the mockups'} <span style="font-weight:400;font-size:14px;">(opens a picture)</span></a>`).join('');
  const card = decision && decision.url ? `<p style="margin:4px 0 14px;font-size:15px;"><a href="${esc(decision.url)}" style="color:#1a1208;font-weight:600;">Open the card for the full background</a></p>` : '';
  return shots + card;
}

/**
 * BRO-7578: a question about how something looks is not emailed without a
 * picture (an Evidence screenshot) or a mockup link on the card or a card it
 * names. Returns a plain reason when it must wait, else null.
 */
// After a day of asking on the card with no picture added, it is emailed anyway: a
// blind question still beats one the owner never hears about.
const PICTURE_WAIT_MS = 24 * 60 * 60 * 1000;
function pictureHold({ question, description, related = [], askedAt = null, now = Date.now() }) {
  if (!isVisualQuestion(question)) return null;
  if (askedAt && now - Date.parse(askedAt) > PICTURE_WAIT_MS) return null;
  if (parseDecisionBlock(description).evidence.length) return null;
  if (mockupLinks(description, ...related).length) return null;
  return 'a question about how something looks, with no screenshot and no mockup link on the card or the cards it names';
}

// BRO-6876 / BRO-7491: ONE small picture plus at most two text links. The card's Evidence URLs are
// thumbnails (thumb_<shot>.jpg, under 300 KB: Gmail's image proxy drops huge or octet-stream files);
// the picture and the links open the full-size shot sitting beside the thumbnail.
const EMAIL_MAX_LINKS = 2;
function evidenceHtml(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  if (!list.length) return '';
  const first = pickEmailImage(list);
  const rest = list.filter((e) => e !== first).slice(0, EMAIL_MAX_LINKS);
  const big = (e) => fullUrlForThumb(e.url) || e.url;
  return `<p style="margin:0 0 10px;"><a href="${esc(big(first))}"><img src="${esc(first.url)}" alt="${esc(noDash(first.label))}" width="280" style="display:block;width:100%;max-width:280px;height:auto;border:1px solid #ddd;border-radius:8px;"></a><span style="font-size:13px;color:#666;">${esc(noDash(first.label))}. Tap to enlarge.</span></p>`
    + (rest.length ? `<p style="margin:0 0 12px;font-size:13px;color:#666;">Also: ${rest.map((e) => `<a href="${esc(big(e))}" style="color:#666;">${esc(noDash(e.label))}</a>`).join(', ')}</p>` : '');
}

// The task body: why it needs the owner, the numbered steps, then Done /
// could-not-do-it. Tapping Done records the answer and sends the card back to
// the work queue, so the work carries on without the owner finding the chat.
function taskHtml({ decision, block, choices, question, token, secret, now, baseUrl, reminder, seeHtml = '' }) {
  const steps = block.steps.map((s) => `<li style="margin:0 0 10px;">${esc(noDash(s))}</li>`).join('');
  const buttons = choices.map((c, i) => button(answerUrl(token, c.key, baseUrl), c.label, i === 0)).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.5;color:#222;">
<div style="max-width:520px;margin:0 auto;">
<p style="margin:0 0 6px;color:#666;font-size:14px;">${reminder ? 'Still waiting on you' : 'A task for you'}. Work on this is paused until you tap Done.</p>
<h2 style="margin:0 0 12px;font-size:20px;line-height:1.3;">${esc(question)}</h2>
${decision.title && decision.title !== decision.question ? `<p style="margin:0 0 12px;color:#666;font-size:14px;">About: ${esc(noDash(displayQuestion(decision.title)))}</p>` : ''}
${seeHtml}
${block.why ? `<p style="margin:0 0 12px;"><strong>Why Claude cannot do this itself:</strong> ${esc(noDash(block.why))}</p>` : ''}
<ol style="padding-left:22px;margin:12px 0 16px;">${steps}</ol>
${buttons}
${button(answerUrl(token, 'own', baseUrl), 'Reply in my own words', false)}
<p style="margin:16px 0 0;color:#666;font-size:13px;">When you tap Done, the work goes back in the queue and carries on by itself. You do not need to find the Claude chat. Each button asks you to confirm first. This link works for 14 days.</p>
<p style="margin:10px 0 0;font-size:14px;"><a href="${esc(listUrl(secret, { now, baseUrl }))}" style="color:#1a1208;">See everything waiting on you</a></p>
</div></body></html>`;
}

// One reminder email for decisions still open after a few days: a short list,
// each with its own signed link to the answer page.
function buildRoundupEmail({ decisions, secret, now = Date.now(), baseUrl = BASE_URL }) {
  const n = decisions.length;
  const subject = `${n} ${n === 1 ? 'decision is' : 'decisions are'} still waiting on you`;
  const rows = decisions.map((d) => {
    const hash = questionHash(d.question || d.title);
    const token = signToken({ id: d.identifier, hash, secret, now });
    return `<div style="margin:0 0 14px;"><div style="font-weight:600;">${esc(noDash(displayQuestion(d.question || d.title)))}</div>${button(answerUrl(token, 'none', baseUrl), 'Open and answer', true)}</div>`;
  }).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.5;color:#222;"><div style="max-width:520px;margin:0 auto;">
<p style="margin:0 0 14px;">${n === 1 ? 'This decision has' : 'These decisions have'} been waiting a few days. Work on ${n === 1 ? 'it is' : 'them is'} paused until you answer.</p>${rows}
</div></body></html>`;
  return { subject, html };
}

// ONE email for a pile of never-announced decisions: the question list with a
// single link to the list page, where the answer buttons live.
function buildBacklogEmail({ decisions, secret, now = Date.now(), baseUrl = BASE_URL }) {
  const n = decisions.length;
  const subject = `${n} ${n === 1 ? 'decision is' : 'decisions are'} waiting on you`;
  const rows = decisions.slice(0, 25).map((d) => `<li style="margin:0 0 8px;">${esc(noDash(displayQuestion(d.question || d.title)))}</li>`).join('');
  const more = n > 25 ? `<p style="margin:0 0 14px;color:#666;">And ${n - 25} more on the page.</p>` : '';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.5;color:#222;"><div style="max-width:520px;margin:0 auto;">
<p style="margin:0 0 14px;">${n === 1 ? 'One decision is' : `${n} decisions are`} waiting on you. Work on ${n === 1 ? 'it is' : 'them is'} paused until you answer. Everything is on one page, each with its options and an answer button.</p>
${button(listUrl(secret, { now, baseUrl }), 'See and answer everything', true)}
<ol style="padding-left:20px;margin:16px 0;">${rows}</ol>${more}
<p style="margin:16px 0 0;color:#666;font-size:13px;">Each answer button asks you to confirm before anything is saved. This link works for 3 days; the morning digest carries a fresh one.</p>
</div></body></html>`;
  return { subject, html };
}

module.exports = { pictureHold, PICTURE_WAIT_MS, contextLinksHtml, buildDecisionEmail, buildRoundupEmail, buildBacklogEmail, answerUrl, listUrl, BASE_URL };
