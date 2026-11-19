/**
 * Sentry noise filter for cut-off script downloads (BRO-7809, Sentry
 * BROADWAY-SCORECARD-37).
 *
 * A first-party chunk under /_next/static/ is compiled by the build before it
 * ships, so it can never contain a real syntax error. When a client throws a
 * SyntaxError inside one, the file reached that client cut off or altered: a
 * scraper or proxy that stops reading the response, a flaky network, a
 * tampering middlebox. The live file is intact (325,207 bytes, parses, same
 * md5 on every fetch) and the error positions varied from column 1,059 to
 * 176,576 across 51 events from 51 IPs in ~20 countries, all Chrome 133 on
 * Windows, with three different SyntaxError messages.
 *
 * A real broken deploy would fail every page load and trip the build and
 * uptime checks long before Sentry, so these events carry no signal.
 */

interface ChunkErrorEvent {
  exception?: {
    values?: Array<{
      type?: string;
      stacktrace?: { frames?: Array<{ filename?: string }> };
    }>;
  };
}

// "/_next/static/chunks/b468fba8.47bfaad1005addc2.js", with or without the origin.
const NEXT_STATIC_ASSET = /(^|\/\/[^/]+)\/_next\/static\/[^?#]*\.js(\?|#|$)/;

/** True for a SyntaxError raised in a built /_next/static script. */
export function isTruncatedChunkError(event: ChunkErrorEvent | null | undefined): boolean {
  const values = event?.exception?.values;
  if (!values || values.length === 0) return false;
  return values.every(v => {
    if (v?.type !== 'SyntaxError') return false;
    const frames = v.stacktrace?.frames;
    if (!frames || frames.length === 0) return false;
    return frames.every(f => typeof f.filename === 'string' && NEXT_STATIC_ASSET.test(f.filename));
  });
}
