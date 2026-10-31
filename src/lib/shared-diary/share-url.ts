import { SITE_URL } from '@/lib/site-url';

/** The public diary link for a share token. Always the live site, never demo. */
export function diaryShareUrl(token: string): string {
  return `${SITE_URL}/seen/${token}`;
}
