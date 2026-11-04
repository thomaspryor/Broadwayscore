// BRO-6984: correction requests from a critic who owns their page ("Flag a
// problem" on one review, "Missing a review? Tell us"). This module turns a
// request body into one stored row and one email to the OWNER. I/O is passed
// in, so tests drive the real function with mocks (CLAUDE.md §15). It never
// reads or writes a score or a review, and it never emails the critic.
import { sanitizeFlagInput, sanitizeMissingReviewInput, FLAG_REASONS, type FlagReason } from './critic-claim';

export type CorrectionKind = 'score_flag' | 'review_flag' | 'missing_review';

export interface OwnReview { showTitle: string; outlet: string; reviewScore: number; url: string }

export interface CorrectionRow {
  critic_slug: string;
  user_id: string;
  kind: CorrectionKind;
  payload: Record<string, unknown>;
}

export interface CorrectionDeps {
  slug: string;
  criticName: string;
  user: { id: string; email: string };
  /** The critic's own reviews, keyed `${showSlug}-${getReviewKey(review)}`. */
  ownReviews: ReadonlyMap<string, OwnReview>;
  /** Stores one row; true when stored. */
  insert: (row: CorrectionRow) => Promise<boolean>;
  /** The owner-notification path shared with claims (critic-server emailOwner). */
  emailOwner: (subject: string, html: string, replyTo?: string) => Promise<boolean>;
}

export interface CorrectionResult { status: number; body: { ok: true } | { error: string } }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** wrong_score keeps the original 'score_flag' kind; every other reason is a 'review_flag'. */
export function kindForReason(reason: FlagReason): CorrectionKind {
  return reason === 'wrong_score' ? 'score_flag' : 'review_flag';
}

export async function submitCorrection(body: unknown, d: CorrectionDeps): Promise<CorrectionResult> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const footer = `<p>Account: ${esc(d.user.email)}. Reply to reach them. Nothing was changed.</p>`;

  if (b.kind === 'missing') {
    const input = sanitizeMissingReviewInput(b);
    if ('error' in input) return { status: 400, body: { error: input.error } };
    if (input.slug !== d.slug) return { status: 400, body: { error: 'Unknown page.' } };
    const stored = await d.insert({ critic_slug: d.slug, user_id: d.user.id, kind: 'missing_review', payload: { reviewUrl: input.reviewUrl, note: input.note } });
    if (!stored) return { status: 502, body: { error: 'Could not send that. Please try again.' } };
    await d.emailOwner(`Critic says a review is missing: ${d.criticName}`,
      `<p><b>${esc(d.criticName)}</b> says this review is missing from their page:</p>
<p><a href="${esc(input.reviewUrl)}">${esc(input.reviewUrl)}</a></p>
${input.note ? `<p>${esc(input.note)}</p>` : ''}
${footer}`, d.user.email);
    return { status: 200, body: { ok: true } };
  }

  const input = sanitizeFlagInput(b, new Set(d.ownReviews.keys()));
  if ('error' in input) return { status: 400, body: { error: input.error } };
  if (input.slug !== d.slug) return { status: 400, body: { error: 'Unknown page.' } };
  const review = d.ownReviews.get(input.reviewKey)!;
  const reasonLabel = FLAG_REASONS[input.reason];
  const stored = await d.insert({
    critic_slug: d.slug, user_id: d.user.id, kind: kindForReason(input.reason),
    payload: { reviewKey: input.reviewKey, reason: input.reason, note: input.note, show: review.showTitle, outlet: review.outlet, score: review.reviewScore, url: review.url },
  });
  if (!stored) return { status: 502, body: { error: 'Could not send that. Please try again.' } };
  await d.emailOwner(`Critic flagged a review (${reasonLabel.toLowerCase()}): ${d.criticName} on ${review.showTitle}`,
    `<p><b>${esc(d.criticName)}</b> flagged their review of <b>${esc(review.showTitle)}</b> (${esc(review.outlet)}), currently scored ${review.reviewScore}.</p>
<p>Problem: <b>${esc(reasonLabel)}</b></p>
${input.note ? `<p>${esc(input.note)}</p>` : ''}
${review.url ? `<p><a href="${esc(review.url)}">The review as we have it</a></p>` : ''}
${footer}`, d.user.email);
  return { status: 200, body: { ok: true } };
}
