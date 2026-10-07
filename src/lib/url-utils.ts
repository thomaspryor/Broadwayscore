/** Ensure URLs have https:// prefix (defense-in-depth for legacy data) */
export function ensureHttps(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  return 'https://' + url;
}
