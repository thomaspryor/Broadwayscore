/**
 * CommonJS mirror of parseRuntimeMinutes from src/lib/calendar/duration.ts.
 *
 * Why a mirror at all: the canonical parser lives in src/lib/calendar/, which
 * is TypeScript AND is vendored wholesale into the iOS app, so it must stay
 * free of any dependency a prebuild script could satisfy. The prebuild runs as
 * plain `node scripts/generate-show-lookup.js` with no TS loader, so it cannot
 * import the canonical copy.
 *
 * The two implementations are pinned together by tests/unit/parse-runtime-parity.test.ts,
 * which runs BOTH over the same fixture table and over every distinct runtime
 * string in data/shows.json. If you edit one, that test fails until you edit
 * the other. Do not "simplify" either copy in isolation.
 */

const DEFAULT_RUNTIME_MIN = 150;
const CURTAIN_BUFFER_MIN = 15;

function parseRuntimeMinutes(runtime) {
  if (!runtime) return null;
  const s = String(runtime).trim().toLowerCase();
  if (!s) return null;

  const colon = s.match(/^(\d{1,2}):([0-5]\d)$/);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);

  let total = 0;
  let matched = false;

  const hours = s.match(/(\d+(?:\.\d+)?)\s*(?:h(?:rs?|ours?)?)\b/);
  if (hours) {
    total += Math.round(parseFloat(hours[1]) * 60);
    matched = true;
  }

  const mins = s.match(/(\d+)\s*(?:m(?:ins?|inutes?)?)\b/);
  if (mins) {
    total += Number(mins[1]);
    matched = true;
  }

  if (!matched) return null;
  if (total <= 0 || total > 8 * 60) return null;
  return total;
}

function resolveDurationMin(runtime) {
  return (parseRuntimeMinutes(runtime) ?? DEFAULT_RUNTIME_MIN) + CURTAIN_BUFFER_MIN;
}

module.exports = {
  parseRuntimeMinutes,
  resolveDurationMin,
  DEFAULT_RUNTIME_MIN,
  CURTAIN_BUFFER_MIN,
};
