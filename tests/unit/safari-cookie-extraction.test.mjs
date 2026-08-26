// tests/unit/safari-cookie-extraction.test.mjs — BRO-135 / task #779.
//
// Root cause: macOS Tahoe stopped persisting httpOnly cookies to Safari's
// Cookies.binarycookies (confirmed via extract-safari-cookies.py --dry-run
// across all ~30 DOMAIN_GROUPS) — the auth cookies that matter (WSJ's `sso`,
// NYT's `NYT-S`, etc.) are always httpOnly, so the file can still contain
// plenty of cookies and still be useless for subscriber recovery. The fix
// shipped for #779 was to stop depending on Safari entirely (wsj-otp-login.js,
// generalized to NYT/New Yorker in #831). What was never covered by an
// automated test is the extractor's own parsing/filtering logic — so a
// regression there (e.g. the Tahoe container-path fix silently reverting)
// would go unnoticed until the next live outage.
//
// This test builds a synthetic Cookies.binarycookies file byte-for-byte (per
// the binary layout extract-safari-cookies.py's own parser expects — see
// parse_cookie_record/parse_cookie_page/parse_binary_cookies) and drives the
// REAL Python module through it via importlib, so a change to the parser,
// the domain matcher, the expiry filter, or the Tahoe path candidates fails
// this test instead of shipping silently. No real Safari/macOS cookie store
// is touched, so this runs the same on CI's ubuntu-latest as on a Mac.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXTRACTOR_PATH = path.join(REPO, 'scripts', 'extract-safari-cookies.py');

// Python harness: imports the real extractor module (hyphenated filename,
// so plain `import` can't reach it — importlib.util is the standard way to
// load a module from an arbitrary path), builds a synthetic binarycookies
// file matching the module's own parser expectations, and prints one JSON
// object with everything the assertions below need. Runs as a single
// subprocess so one importlib load buys every assertion.
const HARNESS = `
import importlib.util
import json
import os
import struct
import sys
import tempfile
import datetime

spec = importlib.util.spec_from_file_location("extract_safari_cookies", ${JSON.stringify(EXTRACTOR_PATH)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

MAC_EPOCH_OFFSET = mod.MAC_EPOCH_OFFSET


def unix_to_mac(unix_ts):
    return unix_ts - MAC_EPOCH_OFFSET


def encode_record(domain, name, path_, value, http_only, secure, expiry_unix):
    flags = 0
    if secure:
        flags |= 0x1
    if http_only:
        flags |= 0x4

    strings = [domain, name, path_, value]
    encoded = [s.encode("utf-8") + b"\\x00" for s in strings]

    HEADER_LEN = 56
    offsets = []
    running = HEADER_LEN
    for chunk in encoded:
        offsets.append(running)
        running += len(chunk)
    total_len = running

    header = bytearray(HEADER_LEN)
    struct.pack_into("<I", header, 0, total_len)       # size
    struct.pack_into("<I", header, 4, flags)            # flags
    # bytes 8-15: padding, left zero
    struct.pack_into("<I", header, 16, offsets[0])       # url/domain offset
    struct.pack_into("<I", header, 20, offsets[1])       # name offset
    struct.pack_into("<I", header, 24, offsets[2])       # path offset
    struct.pack_into("<I", header, 28, offsets[3])       # value offset
    # bytes 32-39: padding, left zero
    struct.pack_into("<d", header, 40, float(unix_to_mac(expiry_unix)))
    struct.pack_into("<d", header, 48, 0.0)              # creation date

    return bytes(header) + b"".join(encoded)


def encode_page(records):
    n = len(records)
    offsets_block_len = 8 + n * 4
    offsets = []
    running = offsets_block_len
    for r in records:
        offsets.append(running)
        running += len(r)

    page = bytearray()
    page += struct.pack("<I", 0x00000100)  # page header magic
    page += struct.pack("<I", n)
    for off in offsets:
        page += struct.pack("<I", off)
    for r in records:
        page += r
    return bytes(page)


def encode_file(pages):
    out = bytearray()
    out += b"cook"
    out += struct.pack(">I", len(pages))
    for p in pages:
        out += struct.pack(">I", len(p))
    for p in pages:
        out += p
    out += b"\\x00" * 8  # footer checksum, unread by the parser
    return bytes(out)


# Relative to actual run time (never a hardcoded date) so this test can't
# turn into a year-bomb once "FAR_FUTURE" becomes the past.
NOW = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
FAR_FUTURE = NOW + 50 * 365 * 86400
PAST = NOW - 86400

records = [
    # The auth cookie that actually matters — httpOnly, the kind Tahoe drops.
    encode_record(".wsj.com", "sso", "/", "auth-token-abc", True, True, FAR_FUTURE),
    # A non-auth cookie Tahoe still happily persists (this is exactly why a
    # --dry-run can show "N cookies found" for wsj and still be useless).
    encode_record(".wsj.com", "ab_uuid", "/", "12345", False, False, FAR_FUTURE),
    # Expired NYT auth cookie — must be filtered out regardless of httpOnly.
    encode_record(".nytimes.com", "NYT-S", "/", "expired-token", True, True, PAST),
    # Unrelated domain that happens to end with "wsj.com" as a substring but
    # is NOT a subdomain — must not match via a sloppy suffix check.
    encode_record("evilwsj.com", "tracker", "/", "x", False, False, FAR_FUTURE),
    # A genuine wsj.com subdomain — must match via the leading-dot rule.
    encode_record("sub.wsj.com", "region", "/", "us", False, False, FAR_FUTURE),
]

page = encode_page(records)
file_bytes = encode_file([page])

# A SEPARATE fixture that actually reproduces the Tahoe failure mode: the
# auth (httpOnly) cookie is entirely absent, only the non-auth cookie Tahoe
# still persists survives. This is what a real Tahoe Cookies.binarycookies
# looks like for wsj — "N cookies found" is true and useless at the same time.
tahoe_records = [
    encode_record(".wsj.com", "ab_uuid", "/", "12345", False, False, FAR_FUTURE),
]
tahoe_file_bytes = encode_file([encode_page(tahoe_records)])

with tempfile.NamedTemporaryFile(suffix=".binarycookies", delete=False) as f:
    f.write(file_bytes)
    tmp_path = f.name

with tempfile.NamedTemporaryFile(suffix=".binarycookies", delete=False) as f:
    f.write(tahoe_file_bytes)
    tahoe_tmp_path = f.name

try:
    all_cookies = mod.parse_binary_cookies(tmp_path)
    tahoe_cookies = mod.parse_binary_cookies(tahoe_tmp_path)
finally:
    # Fixtures are scratch — don't leak them into the system temp dir on
    # every run (5 tests share this harness, each invocation would otherwise
    # leave 2 files behind).
    os.unlink(tmp_path)
    os.unlink(tahoe_tmp_path)

wsj_filtered = mod.filter_cookies_for_group(all_cookies, mod.DOMAIN_GROUPS["wsj"])
nytimes_filtered = mod.filter_cookies_for_group(all_cookies, mod.DOMAIN_GROUPS["nytimes"])
tahoe_wsj_filtered = mod.filter_cookies_for_group(tahoe_cookies, mod.DOMAIN_GROUPS["wsj"])

result = {
    "all_cookies": [
        {"name": c["name"], "domain": c["domain"], "httpOnly": c["httpOnly"], "secure": c["secure"]}
        for c in all_cookies
    ],
    "wsj_filtered_names": sorted(c["name"] for c in wsj_filtered),
    "wsj_httponly_count": sum(1 for c in wsj_filtered if c["httpOnly"]),
    "nytimes_filtered_names": [c["name"] for c in nytimes_filtered],
    "cookie_file_candidates": mod.COOKIE_FILE_CANDIDATES,
    "domain_matches_subdomain": mod.domain_matches("sub.wsj.com", [".wsj.com"]),
    "domain_matches_suffix_false_positive": mod.domain_matches("evilwsj.com", [".wsj.com"]),
    "tahoe_wsj_filtered_names": sorted(c["name"] for c in tahoe_wsj_filtered),
    "tahoe_wsj_httponly_count": sum(1 for c in tahoe_wsj_filtered if c["httpOnly"]),
}
print(json.dumps(result))
`;

function runHarness() {
  const tmpScript = path.join(os.tmpdir(), `safari-cookie-extraction-harness-${process.pid}.py`);
  fs.writeFileSync(tmpScript, HARNESS);
  try {
    // -B: don't write __pycache__ — importlib-loading extract-safari-cookies.py
    // by path would otherwise dirty its tracked .pyc cache file on every run.
    const stdout = execFileSync('python3', ['-B', tmpScript], { encoding: 'utf8', timeout: 30_000 });
    return JSON.parse(stdout);
  } finally {
    fs.rmSync(tmpScript, { force: true });
  }
}

test('extract-safari-cookies.py: extractor module loads and file exists', () => {
  assert.ok(fs.existsSync(EXTRACTOR_PATH), `expected ${EXTRACTOR_PATH} to exist`);
});

test('extract-safari-cookies.py: parses httpOnly flag correctly (round-trip)', () => {
  const result = runHarness();
  const sso = result.all_cookies.find((c) => c.name === 'sso');
  const abUuid = result.all_cookies.find((c) => c.name === 'ab_uuid');
  assert.ok(sso, 'sso cookie should have been parsed');
  assert.equal(sso.httpOnly, true, 'sso (auth cookie) must round-trip as httpOnly');
  assert.equal(sso.secure, true);
  assert.ok(abUuid, 'ab_uuid cookie should have been parsed');
  assert.equal(abUuid.httpOnly, false, 'ab_uuid (non-auth cookie) must round-trip as NOT httpOnly');
});

test('extract-safari-cookies.py: filter_cookies_for_group excludes expired cookies', () => {
  const result = runHarness();
  assert.deepEqual(result.nytimes_filtered_names, [], 'expired NYT-S must be filtered out regardless of httpOnly');
});

test('extract-safari-cookies.py: domain_matches matches real subdomains, not suffix look-alikes', () => {
  const result = runHarness();
  assert.equal(result.domain_matches_subdomain, true, 'sub.wsj.com must match .wsj.com');
  assert.equal(
    result.domain_matches_suffix_false_positive,
    false,
    'evilwsj.com must NOT match .wsj.com — a naive .endswith("wsj.com") would wrongly match this'
  );
});

test('extract-safari-cookies.py: pre-Tahoe fixture — httpOnly auth cookie is counted correctly', () => {
  const result = runHarness();
  assert.deepEqual(result.wsj_filtered_names, ['ab_uuid', 'region', 'sso']);
  assert.equal(result.wsj_httponly_count, 1, 'exactly one httpOnly cookie (sso) should be counted for wsj');
});

test('extract-safari-cookies.py: the Tahoe failure mode — a real zero-httpOnly extraction still "finds" cookies', () => {
  // This is the actual bug this ticket is about, reproduced directly: on
  // Tahoe the binarycookies file still contains ordinary (non-httpOnly)
  // cookies, so `filter_cookies_for_group` returns a non-empty match — the
  // extractor's own "N cookies found" success path is exactly as true and
  // exactly as useless as it is in production. Anything downstream that
  // reads wsj.json and doesn't check httpOnly count separately from total
  // count would wrongly conclude the session is usable.
  const result = runHarness();
  assert.deepEqual(result.tahoe_wsj_filtered_names, ['ab_uuid'], 'the non-auth cookie alone still matches the wsj domain group');
  assert.equal(result.tahoe_wsj_httponly_count, 0, 'zero httpOnly cookies — the auth token Tahoe silently dropped');
});

test('extract-safari-cookies.py: COOKIE_FILE_CANDIDATES includes the Tahoe sandboxed container path', () => {
  const result = runHarness();
  const hasLegacyPath = result.cookie_file_candidates.some((p) => p.endsWith('/Library/Cookies/Cookies.binarycookies'));
  const hasTahoeContainerPath = result.cookie_file_candidates.some((p) =>
    p.includes('/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies')
  );
  assert.ok(hasLegacyPath, 'must still check the pre-Tahoe path (older macOS versions)');
  assert.ok(hasTahoeContainerPath, 'must check the Tahoe sandboxed container path (regression guard for the #779 path fix)');
});
