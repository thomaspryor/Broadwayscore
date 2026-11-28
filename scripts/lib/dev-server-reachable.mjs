// BRO-7849: the one dev-server health check shared by scripts/visual-qa.mjs and scripts/cloud-visual-qa.mjs.
// A cold `next dev` compile of "/" can take well over 5s, so a single short fetch reports "not reachable" while the
// server is just compiling. Retry until the deadline; each attempt waits up to attemptMs for the response.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function devServerReachable(url, { totalMs = 90000, attemptMs = 30000, pauseMs = 2000, fetchImpl = fetch, shouldAbort = () => false } = {}) {
  const end = Date.now() + totalMs;
  let last = { ok: false, reason: 'not attempted' };
  do {
    if (shouldAbort()) return { ok: false, reason: 'dev server process exited' };
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(attemptMs) });
      if (!res.ok) last = { ok: false, reason: `HTTP ${res.status}` };
      else {
        const body = await res.text();
        if (body.length < 1024) last = { ok: false, reason: `response too small (${body.length} bytes)` };
        else if (!/<html|<!doctype/i.test(body)) last = { ok: false, reason: 'response not HTML' };
        else return { ok: true, bytes: body.length };
      }
    } catch (err) {
      last = { ok: false, reason: err?.message || String(err) };
    }
    if (Date.now() + pauseMs >= end) break;
    await sleep(pauseMs);
  } while (Date.now() < end);
  return last;
}
