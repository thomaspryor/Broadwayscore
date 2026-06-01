#!/usr/bin/env python3
"""
Extract Safari cookies for WSJ, New Yorker, and NYT.

Reads ~/Library/Cookies/Cookies.binarycookies (Safari's cookie store),
filters for relevant domains, and saves Playwright-compatible JSON files.

Requirements: macOS, Python 3.6+, Full Disk Access for the terminal app.
No pip packages needed - stdlib only.
"""

import struct
import os
import sys
import json
import base64
import datetime
import pathlib

# Mac epoch: Jan 1, 2001 00:00:00 UTC
# Unix epoch: Jan 1, 1970 00:00:00 UTC
# Difference in seconds
MAC_EPOCH_OFFSET = 978307200

# macOS <15: ~/Library/Cookies/Cookies.binarycookies
# macOS 15+ (Tahoe): sandboxed container path
COOKIE_FILE_CANDIDATES = [
    os.path.expanduser("~/Library/Cookies/Cookies.binarycookies"),
    os.path.expanduser("~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies"),
]
COOKIE_FILE = next((p for p in COOKIE_FILE_CANDIDATES if os.path.isfile(p) and os.path.getsize(p) > 0), COOKIE_FILE_CANDIDATES[0])

# Domain groups: which domains map to which output file
DOMAIN_GROUPS = {
    "newspapers": {
        # newspapers.com is "by Ancestry" — session/auth cookies live on both
        # newspapers.com and ancestry.com after an Ancestry SSO login.
        "domains": [".newspapers.com", "newspapers.com", ".ancestry.com", "ancestry.com"],
        "output": "newspapers.json",
        "secret_name": "NEWSPAPERS_COOKIES",
    },
    "wsj": {
        "domains": [".wsj.com", ".dowjones.com", "wsj.com", "dowjones.com"],
        "output": "wsj.json",
        "secret_name": "WSJ_COOKIES",
    },
    "newyorker": {
        "domains": [".newyorker.com", ".condenast.com", "newyorker.com", "condenast.com"],
        "output": "newyorker.json",
        "secret_name": "NEWYORKER_COOKIES",
    },
    "nytimes": {
        "domains": [".nytimes.com", "nytimes.com"],
        "output": "nytimes.json",
        "secret_name": "NYT_COOKIES",
    },
    "wapo": {
        "domains": [".washingtonpost.com", "washingtonpost.com"],
        "output": "wapo.json",
        "secret_name": "WAPO_COOKIES",
    },
    "ft": {
        "domains": [".ft.com", "ft.com"],
        "output": "ft.json",
        "secret_name": "FT_COOKIES",
    },
    "timeout": {
        "domains": [".timeout.com", "timeout.com"],
        "output": "timeout.json",
        "secret_name": "TIMEOUT_COOKIES",
    },
    "nypost": {
        "domains": [".nypost.com", "nypost.com"],
        "output": "nypost.json",
        "secret_name": "NYPOST_COOKIES",
    },
    "nydailynews": {
        "domains": [".nydailynews.com", "nydailynews.com"],
        "output": "nydailynews.json",
        "secret_name": "NYDAILYNEWS_COOKIES",
    },
    "deadline": {
        "domains": [".deadline.com", "deadline.com", ".pmc.com", "pmc.com"],
        "output": "deadline.json",
        "secret_name": "DEADLINE_COOKIES",
    },
    "observer": {
        "domains": [".observer.com", "observer.com"],
        "output": "observer.json",
        "secret_name": "OBSERVER_COOKIES",
    },
    "hollywoodreporter": {
        "domains": [".hollywoodreporter.com", "hollywoodreporter.com", ".pmc.com"],
        "output": "hollywoodreporter.json",
        "secret_name": "THR_COOKIES",
    },
    "variety": {
        "domains": [".variety.com", "variety.com", ".pmc.com"],
        "output": "variety.json",
        "secret_name": "VARIETY_COOKIES",
    },
    "indiewire": {
        "domains": [".indiewire.com", "indiewire.com", ".pmc.com"],
        "output": "indiewire.json",
        "secret_name": "INDIEWIRE_COOKIES",
    },
    "ew": {
        "domains": [".ew.com", "ew.com"],
        "output": "ew.json",
        "secret_name": "EW_COOKIES",
    },
    "vulture": {
        "domains": [".vulture.com", "vulture.com", ".nymag.com", "nymag.com"],
        "output": "vulture.json",
        "secret_name": "VULTURE_COOKIES",
    },
    "theatermania": {
        "domains": [".theatermania.com", "theatermania.com"],
        "output": "theatermania.json",
        "secret_name": "THEATERMANIA_COOKIES",
    },
    "huffpost": {
        "domains": [".huffpost.com", "huffpost.com", ".huffingtonpost.com", "huffingtonpost.com"],
        "output": "huffpost.json",
        "secret_name": "HUFFPOST_COOKIES",
    },
    "usatoday": {
        "domains": [".usatoday.com", "usatoday.com", ".gannett.com", "gannett.com"],
        "output": "usatoday.json",
        "secret_name": "USATODAY_COOKIES",
    },
    "northjersey": {
        "domains": [".northjersey.com", "northjersey.com", ".gannett.com"],
        "output": "northjersey.json",
        "secret_name": "NORTHJERSEY_COOKIES",
    },
    "bloomberg": {
        "domains": [".bloomberg.com", "bloomberg.com"],
        "output": "bloomberg.json",
        "secret_name": "BLOOMBERG_COOKIES",
    },
    "thestage": {
        "domains": [".thestage.co.uk", "thestage.co.uk"],
        "output": "thestage.json",
        "secret_name": "THESTAGE_COOKIES",
    },
    "talkinbroadway": {
        "domains": [".talkinbroadway.com", "talkinbroadway.com"],
        "output": "talkinbroadway.json",
        "secret_name": "TALKINBROADWAY_COOKIES",
    },
    "backstage": {
        "domains": [".backstage.com", "backstage.com"],
        "output": "backstage.json",
        "secret_name": "BACKSTAGE_COOKIES",
    },
    "amny": {
        "domains": [".amny.com", "amny.com"],
        "output": "amny.json",
        "secret_name": "AMNY_COOKIES",
    },
    "curtainup": {
        "domains": [".curtainup.com", "curtainup.com"],
        "output": "curtainup.json",
        "secret_name": "CURTAINUP_COOKIES",
    },
    "theaterscene": {
        "domains": [".theaterscene.net", "theaterscene.net"],
        "output": "theaterscene.json",
        "secret_name": "THEATERSCENE_COOKIES",
    },
    "frontmezzjunkies": {
        "domains": [".frontmezzjunkies.com", "frontmezzjunkies.com"],
        "output": "frontmezzjunkies.json",
        "secret_name": "FRONTMEZZJUNKIES_COOKIES",
    },
    "telegraph": {
        "domains": [".telegraph.co.uk", "telegraph.co.uk"],
        "output": "telegraph.json",
        "secret_name": "TELEGRAPH_COOKIES",
    },
    "thetimes": {
        "domains": [".thetimes.co.uk", "thetimes.co.uk", ".thetimes.com", "thetimes.com"],
        "output": "thetimes.json",
        "secret_name": "THETIMES_COOKIES",
    },
    "chicagotribune": {
        "domains": [".chicagotribune.com", "chicagotribune.com"],
        "output": "chicagotribune.json",
        "secret_name": "CHICAGOTRIBUNE_COOKIES",
    },
    "thewrap": {
        "domains": [".thewrap.com", "thewrap.com"],
        "output": "thewrap.json",
        "secret_name": "THEWRAP_COOKIES",
    },
    "nbcnewyork": {
        "domains": [".nbcnewyork.com", "nbcnewyork.com", ".nbcnews.com", "nbcnews.com"],
        "output": "nbcnewyork.json",
        "secret_name": "NBCNEWYORK_COOKIES",
    },
    "standard": {
        "domains": [".standard.co.uk", "standard.co.uk"],
        "output": "standard.json",
        "secret_name": "STANDARD_COOKIES",
    },
    "independent": {
        "domains": [".independent.co.uk", "independent.co.uk"],
        "output": "independent.json",
        "secret_name": "INDEPENDENT_COOKIES",
    },
    "newsday": {
        "domains": [".newsday.com", "newsday.com"],
        "output": "newsday.json",
        "secret_name": "NEWSDAY_COOKIES",
    },
}

# Project root (where data/ lives)
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
# If running from /tmp, try to find the Broadwayscore project
if "/tmp" in PROJECT_ROOT or not os.path.isdir(os.path.join(PROJECT_ROOT, "data")):
    candidate = os.path.expanduser("~/Broadwayscore")
    if os.path.isdir(os.path.join(candidate, "data")):
        PROJECT_ROOT = candidate
    else:
        # Fall back to cwd
        PROJECT_ROOT = os.getcwd()


def mac_epoch_to_unix(mac_timestamp):
    """Convert Mac absolute time (seconds since 2001-01-01) to Unix timestamp."""
    if mac_timestamp == 0:
        return 0
    return mac_timestamp + MAC_EPOCH_OFFSET


def read_null_terminated_string(data, offset):
    """Read a null-terminated string from binary data at the given offset."""
    end = data.index(b"\x00", offset)
    return data[offset:end].decode("utf-8", errors="replace")


def parse_cookie_record(data):
    """
    Parse a single cookie record from binary data.

    Cookie record layout:
      0-3:   cookie size (4 bytes, little-endian uint32)
      4-7:   flags (4 bytes, little-endian uint32)
             bit 0 = secure, bit 2 = httpOnly
      8-11:  padding / unknown (4 bytes)
      12-15: url (domain) offset (4 bytes LE)
      16-19: name offset (4 bytes LE)
      20-23: path offset (4 bytes LE)
      24-27: value offset (4 bytes LE)
      28-35: comment/padding (8 bytes)
      36-43: expiry date (8 bytes, little-endian double, Mac epoch)
      44-51: creation date (8 bytes, little-endian double, Mac epoch)
      52+:   null-terminated strings (domain, name, path, value)
    """
    if len(data) < 52:
        return None

    (size,) = struct.unpack_from("<I", data, 0)
    (flags,) = struct.unpack_from("<I", data, 4)
    (url_offset,) = struct.unpack_from("<I", data, 16)
    (name_offset,) = struct.unpack_from("<I", data, 20)
    (path_offset,) = struct.unpack_from("<I", data, 24)
    (value_offset,) = struct.unpack_from("<I", data, 28)
    (expiry,) = struct.unpack_from("<d", data, 40)
    (creation,) = struct.unpack_from("<d", data, 48)

    is_secure = bool(flags & 0x1)
    is_http_only = bool(flags & 0x4)

    try:
        domain = read_null_terminated_string(data, url_offset)
        name = read_null_terminated_string(data, name_offset)
        path = read_null_terminated_string(data, path_offset)
        value = read_null_terminated_string(data, value_offset)
    except (ValueError, IndexError):
        return None

    expiry_unix = mac_epoch_to_unix(expiry)

    return {
        "name": name,
        "value": value,
        "domain": domain,
        "path": path,
        "httpOnly": is_http_only,
        "secure": is_secure,
        "sameSite": "None" if is_secure else "Lax",
        "expires": expiry_unix,
    }


def parse_cookie_page(page_data):
    """
    Parse a single page of cookies.

    Page layout:
      0-3:   page header (4 bytes, should be 0x00000100)
      4-7:   number of cookies (4 bytes, little-endian uint32)
      8+:    cookie offsets (num_cookies * 4 bytes, little-endian uint32 each)
      then:  cookie records at those offsets
    """
    cookies = []

    if len(page_data) < 8:
        return cookies

    (header,) = struct.unpack_from("<I", page_data, 0)
    # Header should be 0x00000100 (256 in LE)
    # Some files may have slight variations, so we don't strictly enforce

    (num_cookies,) = struct.unpack_from("<I", page_data, 4)

    if num_cookies > 10000:
        # Sanity check
        return cookies

    offsets = []
    for i in range(num_cookies):
        offset_pos = 8 + (i * 4)
        if offset_pos + 4 > len(page_data):
            break
        (offset,) = struct.unpack_from("<I", page_data, offset_pos)
        offsets.append(offset)

    for offset in offsets:
        if offset >= len(page_data):
            continue
        cookie_data = page_data[offset:]
        cookie = parse_cookie_record(cookie_data)
        if cookie:
            cookies.append(cookie)

    return cookies


def parse_binary_cookies(filepath):
    """
    Parse Safari's Cookies.binarycookies file.

    File layout:
      0-3:     magic "cook" (4 bytes)
      4-7:     number of pages (4 bytes, big-endian uint32)
      8+:      page sizes (num_pages * 4 bytes, big-endian uint32 each)
      then:    page data blocks (each of the sizes listed above)
      footer:  checksum (8 bytes) -- we ignore this
    """
    with open(filepath, "rb") as f:
        data = f.read()

    if len(data) < 8:
        print("Error: Cookie file is too small or empty.")
        sys.exit(1)

    magic = data[0:4]
    if magic != b"cook":
        print(f"Error: Not a valid binarycookies file (magic: {magic!r}, expected b'cook').")
        sys.exit(1)

    (num_pages,) = struct.unpack(">I", data[4:8])

    # Read page sizes (big-endian)
    page_sizes = []
    for i in range(num_pages):
        offset = 8 + (i * 4)
        (page_size,) = struct.unpack(">I", data[offset : offset + 4])
        page_sizes.append(page_size)

    # Read pages
    all_cookies = []
    page_start = 8 + (num_pages * 4)

    for page_size in page_sizes:
        page_data = data[page_start : page_start + page_size]
        cookies = parse_cookie_page(page_data)
        all_cookies.extend(cookies)
        page_start += page_size

    return all_cookies


def domain_matches(cookie_domain, target_domains):
    """Check if a cookie's domain matches any of the target domains."""
    cd = cookie_domain.lower().strip(".")
    for td in target_domains:
        td_clean = td.lower().strip(".")
        if cd == td_clean or cd.endswith("." + td_clean):
            return True
    return False


def filter_cookies_for_group(all_cookies, group):
    """Filter cookies matching a domain group, removing expired ones."""
    now = datetime.datetime.now(datetime.timezone.utc).timestamp()
    matched = []
    for cookie in all_cookies:
        if domain_matches(cookie["domain"], group["domains"]):
            # Keep cookies that haven't expired (expires=0 means session cookie)
            if cookie["expires"] == 0 or cookie["expires"] > now:
                matched.append(cookie)
    return matched


def main():
    print("=" * 60)
    print("  Safari Cookie Extractor")
    print("  For: WSJ, New Yorker, NYT")
    print("=" * 60)
    print()

    # Check file exists
    if not os.path.exists(COOKIE_FILE):
        print(f"Error: Cookie file not found at:")
        print(f"  {COOKIE_FILE}")
        print()
        print("Make sure you're running this on macOS with Safari installed.")
        sys.exit(1)

    # Try to read
    try:
        all_cookies = parse_binary_cookies(COOKIE_FILE)
    except PermissionError:
        print("=" * 60)
        print("  PERMISSION DENIED")
        print("=" * 60)
        print()
        print("Your terminal doesn't have permission to read Safari cookies.")
        print()
        print("To fix this:")
        print("  1. Open System Settings")
        print("  2. Go to Privacy & Security > Full Disk Access")
        print("  3. Add your terminal app (Warp) and toggle it ON")
        print("  4. QUIT and REOPEN your terminal")
        print("  5. Run this script again")
        sys.exit(1)
    except Exception as e:
        print(f"Error reading cookie file: {e}")
        sys.exit(1)

    print(f"Read {len(all_cookies)} total cookies from Safari.")
    print()

    # Create output directory
    output_dir = os.path.join(PROJECT_ROOT, "data", "cookies")
    os.makedirs(output_dir, exist_ok=True)

    # Dry-run shorthand: short-circuit FS-mutating side effects (quarantine,
    # sidecar write) before they run. Bundle generation + --push still happen
    # below if explicitly requested; dry-run dampens THIS pass's mutations.
    dry_run_mode = "--dry-run" in sys.argv

    # Load existing extraction metadata sidecar (per-outlet timestamps).
    # Keeps a record of when each outlet was last successfully extracted, so
    # check-cookie-health can warn about stale bundles even when the cookies
    # in them are still technically "alive."
    meta_path = os.path.join(output_dir, "_extracted-at.json")
    meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path) as f:
                meta = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            print(f"WARNING: existing {meta_path} unreadable ({e}); starting fresh")
            meta = {}

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    now_unix = int(datetime.datetime.now(datetime.timezone.utc).timestamp())

    gh_commands = []
    any_found = False
    stale_outlets = []

    for group_name, group in DOMAIN_GROUPS.items():
        matched = filter_cookies_for_group(all_cookies, group)
        output_path = os.path.join(output_dir, group["output"])

        if not matched:
            print(f"  {group_name}: No cookies found.")
            print(f"    -> Make sure you're logged into {group['domains'][0].strip('.')} in Safari")

            # If a stale local file exists, quarantine it so the loader can't
            # pretend the outlet is still healthy. The bundle in GitHub
            # secrets may still be alive; that's reported separately by
            # the staleness check in check-cookie-health.
            if os.path.exists(output_path):
                if dry_run_mode:
                    print(f"    -> [dry-run] would quarantine stale local file → {os.path.basename(output_path)}.stale")
                else:
                    stale_path = output_path + ".stale"
                    try:
                        os.replace(output_path, stale_path)
                        print(f"    -> Quarantined stale local file → {os.path.basename(stale_path)}")
                        stale_outlets.append(group_name)
                    except OSError as e:
                        print(f"    -> WARNING: could not quarantine {output_path}: {e}")
            print()
            continue

        any_found = True

        # Count httpOnly cookies (the important auth ones)
        http_only_count = sum(1 for c in matched if c["httpOnly"])

        if dry_run_mode:
            print(f"  {group_name}: {len(matched)} cookies ({http_only_count} httpOnly) [dry-run, not saved]")
        else:
            # Save as Playwright-compatible JSON
            with open(output_path, "w") as f:
                json.dump(matched, f, indent=2)

            # Clear any prior quarantine — we just got a fresh successful
            # extraction for this outlet, so the .stale sibling is obsolete.
            stale_path = output_path + ".stale"
            if os.path.exists(stale_path):
                try:
                    os.remove(stale_path)
                except OSError:
                    pass

            # Stamp this outlet's extraction time in the sidecar.
            meta[group_name] = {"extractedAt": now_iso, "extractedAtUnix": now_unix}

            print(f"  {group_name}: {len(matched)} cookies ({http_only_count} httpOnly)")
            print(f"    -> Saved to {output_path}")

        # Generate base64 for GitHub secret
        cookie_json = json.dumps(matched)
        cookie_b64 = base64.b64encode(cookie_json.encode("utf-8")).decode("utf-8")

        gh_commands.append({
            "name": group["secret_name"],
            "b64": cookie_b64,
            "group_name": group_name,
            "count": len(matched),
            "_cookies": matched,  # Raw cookies for bundle bin-packing
        })

        print()

    if not any_found:
        print()
        print("No matching cookies found for any site.")
        print("Make sure you're logged into these sites in Safari first.")
        sys.exit(1)

    # Persist sidecar metadata (skip in dry-run — no filesystem mutation).
    # Atomic write: tmp file + rename. Two parallel runs can still
    # last-writer-wins, but neither leaves the sidecar half-written.
    if not dry_run_mode:
        try:
            tmp_meta_path = meta_path + ".tmp"
            with open(tmp_meta_path, "w") as f:
                json.dump(meta, f, indent=2, sort_keys=True)
            os.replace(tmp_meta_path, meta_path)
        except OSError as e:
            print(f"WARNING: failed to write {meta_path}: {e}")

    # Loud summary for any outlet whose local file was quarantined this run.
    if stale_outlets:
        print()
        print("=" * 60)
        print(f"  ⚠ {len(stale_outlets)} outlet(s) had no fresh Safari cookies — quarantined")
        print("=" * 60)
        for o in stale_outlets:
            print(f"  - {o}: log into {DOMAIN_GROUPS[o]['domains'][0].strip('.')} in Safari, then re-run")

    # Also note the gitignore
    gitignore_path = os.path.join(output_dir, ".gitignore")
    if not os.path.exists(gitignore_path):
        with open(gitignore_path, "w") as f:
            f.write("# Never commit cookies\n*.json\n")
        print(f"Created {gitignore_path} (cookies will not be committed to git)")

    # Auto-push to GitHub secrets if --push flag is set
    auto_push = "--push" in sys.argv
    dry_run = "--dry-run" in sys.argv

    if auto_push or dry_run:
        import subprocess
        import tempfile

        # ---- Build bundles (bin-pack outlets into ≤48KB chunks) ----
        MAX_BUNDLE_SIZE = 46 * 1024  # 46KB with headroom (GitHub limit is 48KB)

        # Build per-outlet cookie data keyed by fileKey
        outlet_cookies = {}
        for cmd in gh_commands:
            # Find the fileKey for this group (from DOMAIN_GROUPS)
            for group_name, group in DOMAIN_GROUPS.items():
                if group["secret_name"] == cmd["name"]:
                    file_key = group["output"].replace(".json", "")
                    outlet_cookies[file_key] = cmd["_cookies"]
                    break

        # Bin-pack into bundles. Each bundle gets a _meta entry so
        # check-cookie-health can flag stale extractions even when the
        # local data/cookies/ files aren't present (i.e. in CI).
        # cookie-loader.js already ignores non-array entries when loading
        # bundles, so _meta is safely skipped by consumers.
        def empty_bundle():
            return {"_meta": {"extractedAt": now_iso, "extractedAtUnix": now_unix}}

        bundles = []
        current_bundle = empty_bundle()
        for file_key, cookies in sorted(outlet_cookies.items()):
            test_bundle = {**current_bundle, file_key: cookies}
            test_json = json.dumps(test_bundle)
            test_b64_size = len(base64.b64encode(test_json.encode("utf-8")))

            # Bundle full if adding this outlet exceeds size AND we already
            # have at least one outlet in it (i.e. more than just _meta).
            outlet_count = len([k for k in current_bundle if not k.startswith("_")])
            if test_b64_size > MAX_BUNDLE_SIZE and outlet_count > 0:
                bundles.append(current_bundle)
                current_bundle = {**empty_bundle(), file_key: cookies}
            else:
                current_bundle = test_bundle

        outlet_count = len([k for k in current_bundle if not k.startswith("_")])
        if outlet_count > 0:
            bundles.append(current_bundle)

        # Print bundle plan
        print()
        print("=" * 60)
        print(f"  Cookie Bundles: {len(bundles)} bundles from {len(outlet_cookies)} outlets")
        print("=" * 60)
        print()

        for i, bundle in enumerate(bundles, 1):
            raw = json.dumps(bundle)
            b64 = base64.b64encode(raw.encode("utf-8"))
            size_kb = len(b64) / 1024
            warn = " ⚠ >40KB" if size_kb > 40 else ""
            outlets = [k for k in bundle.keys() if not k.startswith("_")]
            print(f"  COOKIES_BUNDLE_{i}: {len(outlets)} outlets, {size_kb:.1f} KB{warn}")
            print(f"    → {', '.join(outlets)}")

        if dry_run:
            print()
            print("Dry run — no secrets pushed.")
            print()
            print("Done! Cookies saved locally.")
            return

        # ---- Push bundles ----
        print()
        print("=" * 60)
        print("  Pushing cookie bundles to GitHub secrets...")
        print("=" * 60)
        print()

        for i, bundle in enumerate(bundles, 1):
            secret_name = f"COOKIES_BUNDLE_{i}"
            raw = json.dumps(bundle)
            b64_val = base64.b64encode(raw.encode("utf-8")).decode("utf-8")

            with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as tmp:
                tmp.write(b64_val)
                tmp_path = tmp.name

            try:
                result = subprocess.run(
                    ["gh", "secret", "set", secret_name, "--repo", "thomaspryor/Broadwayscore"],
                    stdin=open(tmp_path, "r"),
                    capture_output=True, text=True, timeout=30,
                )
                outlets = [k for k in bundle.keys() if not k.startswith("_")]
                if result.returncode == 0:
                    print(f"  ✓ {secret_name}: {len(outlets)} outlets pushed ({', '.join(outlets)})")
                else:
                    print(f"  ✗ {secret_name}: {result.stderr.strip()}")
            except FileNotFoundError:
                print(f"  ✗ {secret_name}: 'gh' CLI not found — install GitHub CLI first")
                break
            except Exception as e:
                print(f"  ✗ {secret_name}: {e}")
            finally:
                os.unlink(tmp_path)

    else:
        # Print commands for manual copy-paste
        print()
        print("=" * 60)
        print("  GitHub Secret Commands")
        print("  Run with --push to auto-push, or copy-paste these:")
        print("=" * 60)
        print()

        for cmd in gh_commands:
            print(f"# {cmd['group_name']}: {cmd['count']} cookies")
            print(f"printf '%s' '{cmd['b64'][:20]}...' > /tmp/cookies-b64.txt && gh secret set {cmd['name']} < /tmp/cookies-b64.txt")
            print()

    # Verify the freshly-saved cookies actually pull full review text (catches a
    # session that died server-side while its cookie expiry still looks healthy —
    # the failure that silently logged us out of The Stage for ~11 days). Free,
    # uses the residential IP we're already on. Non-fatal: a probe failure here
    # just means "go log into that site in Safari," not that extraction failed.
    if not dry_run:
        try:
            print()
            print("=" * 60)
            print("  Verifying logged-in state (extracted review body length)...")
            print("=" * 60)
            repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            subprocess.run(["node", "scripts/verify-cookie-login.js"], cwd=repo_root, timeout=300)
        except FileNotFoundError:
            print("  (skipped: 'node' not found)")
        except Exception as e:
            print(f"  (verify skipped: {e})")

    print()
    print("Done! Cookies saved locally" + (" and pushed to GitHub." if auto_push else "."))


if __name__ == "__main__":
    main()
