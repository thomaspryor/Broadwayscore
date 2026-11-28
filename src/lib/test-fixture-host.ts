// Hosts allowed to render the /test/* fixture pages (BRO-4525).
//
// TestGuard used to rely on the userAccounts flag being off in production.
// Once accounts launch that flag is on everywhere, so the gate keys on where
// the page is served instead: local dev/CI servers and the demo site only.
const TEST_FIXTURE_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  'demo.broadwayscorecard.com',
]);

export function isTestFixtureHost(hostname: string): boolean {
  return TEST_FIXTURE_HOSTS.has(hostname.toLowerCase());
}
