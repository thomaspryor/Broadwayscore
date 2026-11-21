// BRO-7087: what happens when an account becomes the owner of a critic page,
// shared by the email Approve link (api/critics/decide) and invite links
// (api/critics/accept-invite). All I/O is passed in, so tests run the real
// logic with mocks and never touch Supabase or send email.
import { verifyInvite, inviteErrorMessage } from './critic-invite';

export interface GrantDeps {
  /** sbAdmin from critic-server (service role REST call). */
  sbAdmin: (path: string, init?: RequestInit & { prefer?: string }) => Promise<Response>;
  revalidateTag: (tag: string) => void;
  revalidatePath: (path: string) => void;
  now?: () => Date;
}

/**
 * Marks `userId` as the verified owner of `slug`: upserts the public profile
 * row (idempotent, so a retry repairs a half-done approval) and refreshes the
 * cached critic page and list. Returns false when the profile row failed.
 */
export async function grantOwnership(slug: string, userId: string, d: GrantDeps): Promise<boolean> {
  const prof = await d.sbAdmin('/rest/v1/critic_profiles?on_conflict=critic_slug', {
    method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify({ critic_slug: slug, user_id: userId, verified_at: (d.now ? d.now() : new Date()).toISOString() }),
  });
  if (!prof.ok) return false;
  d.revalidateTag(`critic-profile:${slug}`);
  d.revalidateTag('critic-profiles');
  d.revalidatePath(`/critics/${slug}`);
  d.revalidatePath('/critics');
  return true;
}

export type RecordResult = 'ok' | 'conflict' | 'error';

export interface AcceptDeps {
  secret: string | undefined;
  now: number;
  user: { id: string; email: string };
  /** Display name for a critic page, or null when the page does not exist. */
  criticName: (slug: string) => string | null;
  /** user_id of the page's approved owner, null when none, 'error' when the lookup failed. */
  currentOwner: (slug: string) => Promise<string | null | 'error'>;
  /** Writes the approved critic_claims row for this account ('conflict' = the one-owner rule refused it). */
  recordApproval: (slug: string, userId: string, email: string) => Promise<RecordResult>;
  /** grantOwnership bound to real I/O. */
  grant: (slug: string, userId: string) => Promise<boolean>;
  emailOwner: (subject: string, html: string) => Promise<boolean>;
  escHtml: (s: string) => string;
  site: string;
}

export interface AcceptResult { status: number; body: { ok: true; state: 'owner' } | { error: string } }

const OWNED = 'This page already has an owner.';

/**
 * Invite acceptance. The token must verify and name the same page as the
 * request. A page with a different approved owner is refused; the same owner
 * accepting twice is fine (and repairs the profile row). The owner gets a
 * short FYI email; the critic is never emailed.
 */
export async function acceptInvite(body: unknown, d: AcceptDeps): Promise<AcceptResult> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const v = verifyInvite(d.secret, b.token, d.now);
  if (!v.ok) return { status: v.reason === 'expired' ? 410 : v.reason === 'no-secret' ? 503 : 400, body: { error: inviteErrorMessage(v.reason) } };
  if (b.slug !== v.slug) return { status: 400, body: { error: 'This invite link is for a different page.' } };
  const name = d.criticName(v.slug);
  if (!name) return { status: 404, body: { error: 'Unknown critic page.' } };

  const owner = await d.currentOwner(v.slug);
  if (owner === 'error') return { status: 502, body: { error: 'Something went wrong. Please try again in a minute.' } };
  if (owner && owner !== d.user.id) return { status: 409, body: { error: OWNED } };

  let fresh = false;
  if (!owner) {
    const rec = await d.recordApproval(v.slug, d.user.id, d.user.email);
    if (rec === 'conflict') {
      // Lost a race with another approval: fine only if that one was this account.
      const again = await d.currentOwner(v.slug);
      if (again !== d.user.id) return { status: 409, body: { error: OWNED } };
    } else if (rec === 'error') {
      return { status: 502, body: { error: 'Something went wrong. Please try again in a minute.' } };
    } else {
      fresh = true;
    }
  }

  if (!(await d.grant(v.slug, d.user.id))) return { status: 502, body: { error: 'Your page is almost ready. Please open the link again in a minute.' } };

  if (fresh) {
    const url = `${d.site}/critics/${v.slug}`;
    await d.emailOwner(`${name} accepted your invite`,
      `<p>${d.escHtml(name)} accepted your invite and now owns their page: <a href="${url}">${url}</a></p><p style="color:#888;font-size:12px">Signed in as ${d.escHtml(d.user.email)}.</p>`);
  }
  return { status: 200, body: { ok: true, state: 'owner' } };
}
