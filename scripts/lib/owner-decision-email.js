'use strict';
/**
 * owner-decision-email.js (BRO-6147): the ONE-email-per-decision body, with a
 * tap-to-answer button per option and a "reply in my own words" button. Pure:
 * scripts/send-owner-decision-emails.js does the I/O. Copy follows the
 * owner-facing rules: plain English, no em dashes, no card ids in the text.
 */

const { parseDecisionBlock, answerChoices, signToken, signListToken, questionHash, unescapeMarkdown, collapseSelfLinks } = require('../../src/lib/owner-decision-link.js');

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
function buildDecisionEmail({ decision, description, secret, now = Date.now(), baseUrl = BASE_URL, reminder = false }) {
  const hash = questionHash(decision.question || decision.title);
  const token = signToken({ id: decision.identifier, hash, secret, now });
  const block = parseDecisionBlock(description);
  const choices = answerChoices(description);
  const question = noDash(decision.question || decision.title);
  const subjectText = question.length > SUBJECT_MAX ? `${question.slice(0, SUBJECT_MAX - 1)}…` : question;
  // BRO-6654: Owner step lines make this a task the owner does by hand, then taps Done.
  const task = block.task;
  const subject = `${reminder ? 'Still waiting: ' : task ? 'Task for you: ' : 'Decision needed: '}${subjectText}`;
  if (task) return { subject, html: taskHtml({ decision, block, choices, question, token, secret, now, baseUrl, reminder }), tokenHash: hash };

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
${decision.title && decision.title !== decision.question ? `<p style="margin:0 0 12px;color:#666;font-size:14px;">About: ${esc(noDash(decision.title))}</p>` : ''}
${(block.evidence || []).map((e) => `<p style="margin:0 0 10px;"><a href="${esc(e.url)}"><img src="${esc(e.url)}" alt="${esc(noDash(e.label))}" style="display:block;width:100%;max-width:520px;height:auto;border:1px solid #ddd;border-radius:8px;"></a><span style="font-size:13px;color:#666;">${esc(noDash(e.label))}</span></p>`).join('')}
${block.why ? `<p style="margin:0 0 12px;"><strong>Why this is your call:</strong> ${esc(noDash(block.why))}</p>` : ''}
${optionHtml}
${block.recommendation ? `<p style="margin:16px 0 6px;"><strong>My recommendation:</strong> ${esc(noDash(block.recommendation))}</p>` : ''}
${block.defaultText ? `<p style="margin:0 0 12px;"><strong>If you do not answer:</strong> ${esc(noDash(block.defaultText))}</p>` : ''}
${button(answerUrl(token, 'own', baseUrl), 'Reply in my own words', false)}
<p style="margin:16px 0 0;color:#666;font-size:13px;">Each button opens a page that asks you to confirm before anything is saved. You can also answer on the card by starting a comment with ANSWER:${decision.url ? ` <a href="${esc(decision.url)}" style="color:#666;">Open the card</a>.` : ''} This link works for 14 days.</p>
<p style="margin:8px 0 0;color:#666;font-size:13px;">If you already answered this in a Claude chat, tell that chat 'record my answer' and it will be saved here.</p>
<p style="margin:10px 0 0;font-size:14px;"><a href="${esc(listUrl(secret, { now, baseUrl }))}" style="color:#1a1208;">See everything waiting on you</a></p>
</div></body></html>`;
  return { subject, html, tokenHash: hash };
}

// The task body: why it needs the owner, the numbered steps, then Done /
// could-not-do-it. Tapping Done records the answer and sends the card back to
// the work queue, so the work carries on without the owner finding the chat.
function taskHtml({ decision, block, choices, question, token, secret, now, baseUrl, reminder }) {
  const steps = block.steps.map((s) => `<li style="margin:0 0 10px;">${esc(noDash(s))}</li>`).join('');
  const buttons = choices.map((c, i) => button(answerUrl(token, c.key, baseUrl), c.label, i === 0)).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.5;color:#222;">
<div style="max-width:520px;margin:0 auto;">
<p style="margin:0 0 6px;color:#666;font-size:14px;">${reminder ? 'Still waiting on you' : 'A task for you'}. Work on this is paused until you tap Done.</p>
<h2 style="margin:0 0 12px;font-size:20px;line-height:1.3;">${esc(question)}</h2>
${decision.title && decision.title !== decision.question ? `<p style="margin:0 0 12px;color:#666;font-size:14px;">About: ${esc(noDash(decision.title))}</p>` : ''}
${block.why ? `<p style="margin:0 0 12px;"><strong>Why Claude cannot do this itself:</strong> ${esc(noDash(block.why))}</p>` : ''}
<ol style="padding-left:22px;margin:12px 0 16px;">${steps}</ol>
${buttons}
${button(answerUrl(token, 'own', baseUrl), 'Reply in my own words', false)}
<p style="margin:16px 0 0;color:#666;font-size:13px;">When you tap Done, the work picks back up on its own within about two hours. You do not need to find the Claude chat. Each button asks you to confirm first.${decision.url ? ` <a href="${esc(decision.url)}" style="color:#666;">Open the card</a>.` : ''} This link works for 14 days.</p>
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
    return `<div style="margin:0 0 14px;"><div style="font-weight:600;">${esc(noDash(d.question || d.title))}</div>${button(answerUrl(token, 'none', baseUrl), 'Open and answer', true)}</div>`;
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
  const rows = decisions.slice(0, 25).map((d) => `<li style="margin:0 0 8px;">${esc(noDash(d.question || d.title))}</li>`).join('');
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

module.exports = { buildDecisionEmail, buildRoundupEmail, buildBacklogEmail, answerUrl, listUrl, BASE_URL };
