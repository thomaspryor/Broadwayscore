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
 * Trade-off, accepted on purpose: a corrupted chunk served by one CDN edge or
 * one region would look the same as this noise and is now invisible in Sentry.
 * Compensating check: the post-deploy smoke test (tests/e2e/smoke.spec.ts, "no
 * first-party script fails to parse") fails if a clean browser cannot parse any
 * /_next/static script, so a chunk broken for every visitor still raises an alarm.
 * Revisit with sampling (keep 1 in N) if a regional-delivery incident ever needs
 * this signal back.
 */

interface ChunkErrorEvent {
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      stacktrace?: { frames?: Array<{ filename?: string }> };
    }>;
  };
}

// "/_next/static/chunks/b468fba8.47bfaad1005addc2.js", with or without the origin.
const NEXT_STATIC_ASSET = /(^|\/\/[^/]+)\/_next\/static\/[^?#]*\.js(\?|#|$)/;

// The messages a browser gives when it cannot parse a script that was cut off or
// altered (all three seen on BROADWAY-SCORECARD-37). An allowlist on purpose:
// a SyntaxError from our own code at runtime, such as JSON.parse on an HTML error
// page ("Unexpected token '<' ... is not valid JSON") or new RegExp(bad), also
// has frames in these chunks and must keep reporting.
const SCRIPT_PARSE_MESSAGE = /^(Unexpected end of input|Invalid or unexpected token|missing \) after argument list)$/;

/** True for a script-parse SyntaxError raised in a built /_next/static script. */
export function isTruncatedChunkError(event: ChunkErrorEvent | null | undefined): boolean {
  const values = event?.exception?.values;
  if (!values || values.length === 0) return false;
  return values.every(v => {
    if (v?.type !== 'SyntaxError' || typeof v.value !== 'string' || !SCRIPT_PARSE_MESSAGE.test(v.value)) return false;
    const frames = v.stacktrace?.frames;
    if (!frames || frames.length === 0) return false;
    return frames.every(f => typeof f.filename === 'string' && NEXT_STATIC_ASSET.test(f.filename));
  });
}
