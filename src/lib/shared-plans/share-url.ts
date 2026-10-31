/**
 * Shared Plans owner-side helpers (BRO-4481). Pure; the iOS app ports the
 * same rules.
 */
import { SITE_URL } from '@/lib/site-url';

/** The public link for a share token. Always the live site, never demo. */
export function planShareUrl(token: string): string {
  return `${SITE_URL}/plans/${token}`;
}

export { SHARE_NAME_MAX, validateShareName, defaultShareName } from '@/lib/share-links/share-name';
