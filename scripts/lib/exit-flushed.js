'use strict';
// Exit with `code` only after everything already written to stdout and stderr has
// reached the reader (BRO-7111).
//
// Why not plain process.exit(code): when stdout is a pipe the reader drains more slowly
// than the script writes (a parent's spawnSync capture, a `| tail`, the Actions runner),
// Node queues the writes and process.exit discards the queue. land-gate-delta.js lost
// ~75% of a 960KB verdict that way, including the FAIL line naming the one new failure.
//
// Why not `process.exitCode = main()` either: it waits for the event loop to empty, so an
// async main that leaves a socket or timer open never exits, and a reader that closes
// early (`| head`) turns the real code into an EPIPE crash (exit 1).
//
// exitCode is set first, so the code survives even if the process ends some other way
// before the flush callbacks run. The unref'd timer is a backstop for a reader that never
// drains: after 10s exit anyway rather than hang.
function exitFlushed(code, { timeoutMs = 10_000 } = {}) {
  // Same contract as process.exit(code): no code keeps an exitCode the script already set,
  // an integer string counts, anything else is a caller bug and throws (process.exit throws on it too).
  const c = code == null ? (process.exitCode ?? 0) : (typeof code === 'string' && /^-?\d+$/.test(code) ? Number(code) : code);
  if (!Number.isInteger(c)) throw new TypeError(`exitFlushed: exit code must be an integer, got ${typeof code}`);
  process.exitCode = c;
  let pending = 2;
  const done = () => { if (--pending === 0) process.exit(c); };
  for (const s of [process.stdout, process.stderr]) {
    s.on('error', () => {}); // EPIPE from a reader that closed early must not replace the code
    try { s.write('', done); } catch { done(); }
  }
  setTimeout(() => process.exit(c), timeoutMs).unref();
}

module.exports = { exitFlushed };
