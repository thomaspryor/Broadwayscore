/**
 * reddit-post-email.js (BRO-4360): pure builders for the Reddit opening-post
 * draft email. scripts/send-reddit-post-email.js does the sending; this lives
 * in scripts/lib so its tests run with the rest of scripts/lib.
 */

'use strict';

const { TOKENS, esc } = require('./email-components');
const { activeDrafts } = require('./reddit-opening-post');

const REMIND_AFTER_HOURS = 20;

function isComplete(d) {
  return !!(d && d.title && d.body && d.subreddit && d.submitUrl && d.showTitle && typeof d.score === 'number');
}

/** Which drafts get an email now, and which kind. */
function dueEmails(drafts, nowMs) {
  const out = [];
  for (const d of activeDrafts(drafts, nowMs)) {
    if (!isComplete(d)) continue;
    if (!d.emailedAt) out.push({ draft: d, kind: 'new' });
    else if (!d.reminderAt && (nowMs - Date.parse(d.emailedAt)) / 3600000 >= REMIND_AFTER_HOURS) out.push({ draft: d, kind: 'reminder' });
  }
  return out;
}

/**
 * The owner asked for specific drafts again ("resend the unposted ones from
 * the last week"). Sent as fresh 'new' emails whatever their age or earlier
 * stamps; a posted, missing or incomplete draft is never resent.
 * Returns { due: [{draft, kind}], skipped: [{showId, reason}] }.
 */
function resendEmails(drafts, ids) {
  const all = (drafts && drafts.drafts) || {};
  const due = [];
  const skipped = [];
  for (const id of new Set(ids)) {
    const d = all[id];
    if (!d) skipped.push({ showId: id, reason: 'no draft' });
    else if (d.status !== 'ready') skipped.push({ showId: id, reason: d.status === 'posted' ? 'already posted' : `status ${d.status}` });
    else if (!isComplete(d)) skipped.push({ showId: id, reason: 'incomplete draft' });
    else due.push({ draft: d, kind: 'new' });
  }
  return { due, skipped };
}

function buildSubject(d, kind) {
  const lead = kind === 'reminder' ? 'Still ready to post' : 'Reddit post ready';
  return `${lead}: ${d.showTitle} (${d.score}/100) for r/${d.subreddit}`;
}

function textBlock(s) {
  return esc(s).replace(/\n/g, '<br>');
}

/**
 * images: [{ cid, label }] already attached to the email (see
 * send-reddit-post-email.js). Shown inline so they can be long-pressed and
 * saved straight to Photos for the Reddit post.
 */
function buildHtml(d, kind, images = []) {
  // Only when both old numbers are known: an older draft without them would
  // print "was undefined".
  const known = [d.previousReviewCount, d.previousScore, d.reviewCount, d.score].every(Number.isFinite);
  const moved = kind === 'reminder' && d.refreshedAt && known && (d.previousReviewCount !== d.reviewCount || d.previousScore !== d.score)
    ? ` The numbers moved since the first email, so I updated them: now ${esc(d.reviewCount)} reviews and ${esc(d.score)}/100 (was ${esc(d.previousReviewCount)} and ${esc(d.previousScore)}).`
    : '';
  const intro = kind === 'reminder'
    ? `Reviews for ${esc(d.showTitle)} are still fresh. Here's the draft again in case yesterday got away from you.${moved} This is the last nudge for this one.`
    : `Reviews are in for ${esc(d.showTitle)}. Tap the button, give it a read, hit Post. These stop once your post shows up on Reddit.`;
  const shots = images.length
    ? `<div style="margin-top:18px;">
      <div style="color:${TOKENS.text};font-size:14px;font-weight:700;">Screenshots for the post</div>
      <div style="color:${TOKENS.textMuted};font-size:13px;line-height:1.5;margin:4px 0 10px 0;">Taken at phone width, so the Reddit app won't crop them. Press and hold to save, then add them as images in the post. They're attached too.</div>
      ${images.map(im => `<div style="margin:0 0 12px 0;"><img src="cid:${esc(im.cid)}" alt="${esc(im.label)}" width="320" style="display:block;width:320px;max-width:100%;height:auto;border-radius:8px;border:1px solid ${TOKENS.borderSubtle};"></div>`).join('\n      ')}
    </div>`
    : '';
  const note = (label, text) => text
    ? `<div style="margin-top:12px;color:${TOKENS.textMuted};font-size:14px;line-height:1.5;"><strong style="color:${TOKENS.text};">${label}</strong> ${text}</div>`
    : '';
  const personal = (d.personalLines || []).length
    ? note('Different ending?', `Swap the last line for one of these, if it fits how you feel:<br>${d.personalLines.map(l => `&bull; ${esc(l)}`).join('<br>')}`)
    : '';
  const pushback = d.expectedPushback
    ? note('If someone says:', `${esc(d.expectedPushback)}<br><strong style="color:${TOKENS.text};">You could reply:</strong> ${esc(d.suggestedReply)}`)
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${TOKENS.surface};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:${TOKENS.text};">
  <div style="max-width:600px;margin:0 auto;padding:24px 18px;background:${TOKENS.surfaceRaised};border:1px solid ${TOKENS.border};">
    <div style="font-size:11px;letter-spacing:0.10em;text-transform:uppercase;color:${TOKENS.brand};font-weight:600;">Reddit post ready · r/${esc(d.subreddit)}</div>
    <h1 style="margin:6px 0 8px 0;font-size:22px;line-height:1.25;color:${TOKENS.text};">${esc(d.showTitle)} · ${esc(d.score)}/100 from ${esc(d.reviewCount)} reviews</h1>
    <div style="color:${TOKENS.textMuted};font-size:14px;line-height:1.5;">${intro}</div>
    <div style="margin:18px 0 6px 0;">
      <a href="${esc(d.submitUrl)}" style="display:inline-block;background:${TOKENS.brand};color:#1a1a1a;text-decoration:none;font-weight:800;font-size:16px;padding:13px 20px;border-radius:8px;">Open Reddit with this post filled in</a>
    </div>
    ${d.crosspostSubreddit && d.crosspostSubmitUrl ? `<div style="margin:10px 0 6px 0;"><a href="${esc(d.crosspostSubmitUrl)}" style="display:inline-block;border:1px solid ${TOKENS.brand};color:${TOKENS.brand};text-decoration:none;font-weight:700;font-size:14px;padding:10px 16px;border-radius:8px;">Also post to r/${esc(d.crosspostSubreddit)}</a> <span style="color:${TOKENS.textDim};font-size:12px;">${d.market === 'off-broadway' ? 'The bigger crowd: your Off-Broadway posts have done well there too.' : 'It has a Broadway production too, so it plays there as well.'}</span></div>` : ''}
    <div style="color:${TOKENS.textDim};font-size:12px;">Form comes up empty? Try the <a href="${esc(d.oldRedditSubmitUrl)}" style="color:${TOKENS.textMuted};">old Reddit version</a>, or copy the text below.</div>
    <div style="margin-top:16px;padding:14px 16px;background:${TOKENS.surface};border-radius:8px;border:1px solid ${TOKENS.borderSubtle};">
      <div style="color:${TOKENS.text};font-size:16px;font-weight:700;line-height:1.35;">${esc(d.title)}</div>
      <div style="margin-top:10px;color:${TOKENS.text};font-size:15px;line-height:1.55;">${textBlock(d.body)}</div>
    </div>
    ${shots}
    ${note('Why it should land:', esc(d.why))}
    ${pushback}
    ${personal}
  </div>
</body></html>`;
}

module.exports = { resendEmails, dueEmails, buildSubject, buildHtml, REMIND_AFTER_HOURS };
