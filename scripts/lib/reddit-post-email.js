/**
 * reddit-post-email.js (BRO-4360): pure builders for the Reddit opening-post
 * draft email. scripts/send-reddit-post-email.js does the sending; this lives
 * in scripts/lib so its tests run with the rest of scripts/lib.
 */

'use strict';

const { TOKENS, esc } = require('./email-components');
const { activeDrafts, numbersMoved, updateAllowed } = require('./reddit-opening-post');

const REMIND_AFTER_HOURS = 20;

function isComplete(d) {
  return !!(d && d.title && d.body && d.subreddit && d.submitUrl && d.showTitle && typeof d.score === 'number');
}

/**
 * Which drafts get an email now, and which kind. An emailed draft whose score
 * or review count moved since that email gets an 'update' (the redrafted text,
 * new screenshots) rather than a reminder; one email per draft per run
 * (BRO-5879).
 */
function dueEmails(drafts, nowMs) {
  const out = [];
  // An update says "use this one": not worth sending when the last run could
  // not check whether the owner already posted (BRO-5879).
  const canUpdate = !(drafts && drafts._meta && drafts._meta.postedDetection === 'skipped');
  for (const d of activeDrafts(drafts, nowMs)) {
    if (!isComplete(d)) continue;
    if (d.heldGap) continue; // BRO-6676: aggregator gap hold
    if (!d.emailedAt) out.push({ draft: d, kind: 'new' });
    else if (canUpdate && numbersMoved(d) && updateAllowed(d, nowMs)) out.push({ draft: d, kind: 'update' });
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
    else if (d.heldGap) skipped.push({ showId: id, reason: `held: ${d.heldGap.reason}` });
    else if (!isComplete(d)) skipped.push({ showId: id, reason: 'incomplete draft' });
    else due.push({ draft: d, kind: 'new' });
  }
  return { due, skipped };
}

/**
 * What a send writes back onto the draft: when it went out, the numbers it
 * carried (the baseline for the next "moved" check) and the update count.
 * A resend stamps both dates so tomorrow's run doesn't follow it with a
 * reminder; an update is a fresh copy, so it counts as the nudge too.
 */
function stampsFor(kind, draft, stamp, { resend = false } = {}) {
  const sent = { emailedScore: draft.score, emailedReviewCount: draft.reviewCount };
  if (resend) return { emailedAt: stamp, reminderAt: stamp, ...sent };
  if (kind === 'update') return { emailedAt: stamp, reminderAt: stamp, updateCount: (draft.updateCount || 0) + 1, ...sent };
  return { [kind === 'new' ? 'emailedAt' : 'reminderAt']: stamp, ...sent };
}

/** A send drops the refresh notes: this email is now the one the owner has. */
function afterSend(entry, stamps) {
  const out = { ...entry, ...stamps };
  for (const k of ['refreshedAt', 'previousReviewCount', 'previousScore']) delete out[k];
  // An update email carries the numbers earlier additions produced, so the "still
  // being scored" watch (lower update threshold) ends, unless the check that ran
  // just before this very send added more reviews: those are not live yet (BRO-5887).
  if (stamps.updateCount !== undefined && out.verification && out.verification.pendingScoring) {
    out.verification = { ...out.verification, pendingScoring: !!out.verification.addedThisCheck };
  }
  return out;
}

/**
 * Do the numbers on the live site match the draft's? The screenshots are of
 * the live page and the text comes from the repo's data, so a deploy that
 * lags the data commit would pair new text with old screenshots (BRO-5879).
 * Returns 'match', 'stale' (still behind after the retries) or 'unknown' (the
 * check itself failed: take the screenshots as before). fetchJson and sleep
 * are injectable for tests.
 */
async function liveMatchesDraft(draft, { fetchJson = defaultFetchJson, sleep = ms => new Promise(r => setTimeout(r, ms)), attempts = 3, waitMs = 45000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    let live;
    try {
      live = await fetchJson(`https://broadwayscorecard.com/data/shows/${encodeURIComponent(draft.showId)}.json`);
    } catch {
      return 'unknown';
    }
    const rc = live && (live.rc ?? (live.rv || []).length);
    if (!live || !Number.isFinite(live.cs) || !Number.isFinite(rc)) return 'unknown';
    if (Math.round(live.cs) === draft.score && rc === draft.reviewCount) return 'match';
    if (i < attempts - 1) await sleep(waitMs);
  }
  return 'stale';
}

async function defaultFetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'broadwayscorecard-draft-bot/1.0' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function buildSubject(d, kind) {
  const lead = kind === 'reminder' ? 'Still ready to post' : kind === 'update' ? 'Updated Reddit post' : 'Reddit post ready';
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
function buildHtml(d, kind, images = [], { siteBehind = false } = {}) {
  // Only when both old numbers are known: an older draft without them would
  // print "was undefined".
  const known = [d.previousReviewCount, d.previousScore, d.reviewCount, d.score].every(Number.isFinite);
  const moved = (kind === 'reminder' || kind === 'update') && d.refreshedAt && known && (d.previousReviewCount !== d.reviewCount || d.previousScore !== d.score)
    ? `now ${esc(d.reviewCount)} reviews and ${esc(d.score)}/100 (was ${esc(d.previousReviewCount)} and ${esc(d.previousScore)})`
    : '';
  const intro = kind === 'update'
    ? `The numbers for ${esc(d.showTitle)} moved since the last email${moved ? `: ${moved}` : ''}. I redrafted the post and retook the screenshots below, so use this one and skip the earlier email.`
    : kind === 'reminder'
      ? `Reviews for ${esc(d.showTitle)} are still fresh. Here's the draft again in case yesterday got away from you.${moved ? ` The numbers moved since the first email, so I updated them: ${moved}.` : ''} This is the last nudge for this one.`
      : `Reviews are in for ${esc(d.showTitle)}. Tap the button, give it a read, hit Post. These stop once your post shows up on Reddit.`;
  const shots = images.length
    ? `<div style="margin-top:18px;">
      <div style="color:${TOKENS.text};font-size:14px;font-weight:700;">Screenshots for the post</div>
      <div style="color:${TOKENS.textMuted};font-size:13px;line-height:1.5;margin:4px 0 10px 0;">Taken at phone width, so the Reddit app won't crop them. Press and hold to save, then add them as images in the post. They're attached too.</div>
      ${images.map(im => `<div style="margin:0 0 12px 0;"><img src="cid:${esc(im.cid)}" alt="${esc(im.label)}" width="320" style="display:block;width:320px;max-width:100%;height:auto;border-radius:8px;border:1px solid ${TOKENS.borderSubtle};"></div>`).join('\n      ')}
    </div>`
    : siteBehind
      ? `<div style="margin-top:18px;color:${TOKENS.textMuted};font-size:13px;line-height:1.5;"><strong style="color:${TOKENS.text};">No screenshots this time.</strong> The live page doesn't show the same numbers as this draft yet, so a picture would contradict the text. Open the show page in a few minutes and screenshot from there.</div>`
      : '';
  const note = (label, text) => text
    ? `<div style="margin-top:12px;color:${TOKENS.textMuted};font-size:14px;line-height:1.5;"><strong style="color:${TOKENS.text};">${label}</strong> ${text}</div>`
    : '';
  // Pre-send review check (BRO-5887). Lazy require: reddit-review-check requires this module.
  const checked = require('./reddit-review-check').describeVerification(d.verification, d);
  const banner = checked && checked.banner
    ? `<div style="margin:14px 0 0 0;padding:10px 12px;border-radius:8px;border:1px solid ${TOKENS.brand};color:${TOKENS.text};font-size:13px;line-height:1.5;"><strong>Heads up.</strong> ${esc(checked.banner)}</div>`
    : '';
  const reviewsChecked = checked && checked.lines.length
    ? note('Reviews checked:', checked.lines.map(l => esc(l)).join('<br>'))
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
    <div style="font-size:11px;letter-spacing:0.10em;text-transform:uppercase;color:${TOKENS.brand};font-weight:600;">Reddit post ${kind === 'update' ? 'updated' : 'ready'} · r/${esc(d.subreddit)}</div>
    <h1 style="margin:6px 0 8px 0;font-size:22px;line-height:1.25;color:${TOKENS.text};">${esc(d.showTitle)} · ${esc(d.score)}/100 from ${esc(d.reviewCount)} reviews</h1>
    <div style="color:${TOKENS.textMuted};font-size:14px;line-height:1.5;">${intro}</div>${banner}
    <div style="margin:18px 0 6px 0;">
      <a href="${esc(d.submitUrl)}" style="display:inline-block;background:${TOKENS.brand};color:#1a1a1a;text-decoration:none;font-weight:800;font-size:16px;padding:13px 20px;border-radius:8px;">Open Reddit with this post filled in</a>
    </div>
    ${d.crosspostSubreddit && d.crosspostSubmitUrl ? `<div style="margin:10px 0 6px 0;"><a href="${esc(d.crosspostSubmitUrl)}" style="display:inline-block;border:1px solid ${TOKENS.brand};color:${TOKENS.brand};text-decoration:none;font-weight:700;font-size:14px;padding:10px 16px;border-radius:8px;">Also post to r/${esc(d.crosspostSubreddit)}</a> <span style="color:${TOKENS.textDim};font-size:12px;">${d.market === 'off-broadway' ? 'The bigger crowd: your Off-Broadway posts have done well there too.' : 'It has a Broadway production too, so it plays there as well.'}</span></div>` : ''}
    <div style="color:${TOKENS.textDim};font-size:12px;">Form comes up empty? Try the <a href="${esc(d.oldRedditSubmitUrl)}" style="color:${TOKENS.textMuted};">old Reddit version</a>, or copy the text below.</div>
    <div style="margin-top:16px;padding:14px 16px;background:${TOKENS.surface};border-radius:8px;border:1px solid ${TOKENS.borderSubtle};">
      <div style="color:${TOKENS.text};font-size:16px;font-weight:700;line-height:1.35;">${esc(d.title)}</div>
      <div style="margin-top:10px;color:${TOKENS.text};font-size:15px;line-height:1.55;">${textBlock(d.body)}</div>
    </div>
    ${shots}${reviewsChecked}
    ${note('Why it should land:', esc(d.why))}
    ${pushback}
    ${personal}
  </div>
</body></html>`;
}

module.exports = { liveMatchesDraft, stampsFor, afterSend, resendEmails, dueEmails, buildSubject, buildHtml, REMIND_AFTER_HOURS };
