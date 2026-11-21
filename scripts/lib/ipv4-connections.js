'use strict';
/**
 * Connect over IPv4 with one plain attempt per connection, process-wide (BRO-6872).
 *
 * Node 20+ "happy eyeballs" (net autoSelectFamily) gives each address 250 ms before moving to the next one. GitHub
 * runners get an IPv6 address for most sites and cannot reach it, so the next address fails at once and the whole
 * fetch fails with "fetch failed (ETIMEDOUT)" although the IPv4 server was answering. Any pause of the event loop
 * longer than 250 ms while connections are opening (parsing a large page is enough) ends that way. Five shadow
 * replays on 2026-11-04 lost 3 to 13 direct reads on every pass to it, all failing in the same millisecond after a
 * 2-7 s pause: the Guardian, The Stage, Theatrely and three blog feeds failed on nearly every read while curl reached
 * them in under a second. tests/unit/ipv4-connections.test.mjs reproduces it with a stalled loop.
 *
 * With the switch off a connection waits for the real handshake, bounded by the callers' own timeouts (undici's 10 s
 * connect timeout, fetchPage's 10 s direct cap). IPv4 first, because without happy eyeballs the first address is the
 * only one tried. Covers global fetch (undici) and http/https.get alike: both read the net defaults.
 *
 * Loaded by scraper.js and rss-discovery.js, so every fetch path in a process that uses them gets it, on GitHub Actions
 * only (GITHUB_ACTIONS=true), like cloud-proxy.js is gated to cloud sessions.
 * Kill switch: NET_AUTOSELECT_FAMILY=on leaves Node's defaults alone.
 */
const net = require('net');
const dns = require('dns');

function preferIpv4Connections(env = process.env) {
  // GitHub runners only: the Mac and cloud sessions have no unreachable IPv6 to fall into and keep Node's defaults.
  if (env.GITHUB_ACTIONS !== 'true') return false;
  if (String(env.NET_AUTOSELECT_FAMILY || '').toLowerCase() === 'on') return false;
  if (typeof net.setDefaultAutoSelectFamily === 'function') net.setDefaultAutoSelectFamily(false);
  if (typeof dns.setDefaultResultOrder === 'function') dns.setDefaultResultOrder('ipv4first');
  return true;
}

preferIpv4Connections();

module.exports = { preferIpv4Connections };
