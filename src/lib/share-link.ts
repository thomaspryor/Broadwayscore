/**
 * Hand a link to the platform share sheet, or copy it when there isn't one.
 *
 * Phones (and Safari on Mac) have navigator.share → the native sheet with
 * Messages, WhatsApp, Mail… Desktop Chrome/Firefox usually don't → copy to
 * the clipboard so the caller can say "Link copied".
 *
 * Returns what happened so the caller can word its toast:
 *   'shared'    — the sheet completed
 *   'cancelled' — the person closed the sheet (do nothing, no error)
 *   'copied'    — no sheet, or it failed for another reason; link is on the clipboard
 *   'failed'    — neither worked; show the URL so they can copy it by hand
 */
export type ShareOutcome = 'shared' | 'cancelled' | 'copied' | 'failed';

export interface ShareEnv {
  share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
}

function browserEnv(): ShareEnv {
  if (typeof navigator === 'undefined') return {};
  return {
    share: typeof navigator.share === 'function' ? navigator.share.bind(navigator) : undefined,
    writeText: navigator.clipboard?.writeText ? navigator.clipboard.writeText.bind(navigator.clipboard) : undefined,
  };
}

// No `text`: some share targets (macOS Copy, some chat apps) join text and
// url into one string, and a friend who taps it lands on "<token> My theater
// plans…" → the not-shared page. The link preview already carries the title.
export async function shareOrCopy(
  data: { title: string; url: string },
  env: ShareEnv = browserEnv(),
): Promise<ShareOutcome> {
  if (env.share) {
    try {
      await env.share({ title: data.title, url: data.url });
      return 'shared';
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return 'cancelled';
      // NotAllowedError (no user gesture), unsupported data… fall through to copy.
    }
  }
  if (env.writeText) {
    try {
      await env.writeText(data.url);
      return 'copied';
    } catch {
      // fall through
    }
  }
  return 'failed';
}
