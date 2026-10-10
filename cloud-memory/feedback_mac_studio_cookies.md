---
name: Mac Studio cookie extraction
description: "Tahoe path changed; Terminal needs FDA; 11 COOKIES_BUNDLE_* secrets."
type: feedback
---

macOS 26 (Tahoe) moved Safari cookies from `~/Library/Cookies/Cookies.binarycookies` to `~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies`. The extraction script now checks both paths.

**Why:** Cookie extraction failed on Mac Studio because the old path doesn't exist on Tahoe.

**How to apply:** When running `extract-safari-cookies.py --push`, must use Terminal (not Warp) because Full Disk Access is per-app. Warp doesn't have FDA on this machine. The script handles both old and new cookie paths automatically.

Cookie secrets are now bundled: 11 `COOKIES_BUNDLE_*` secrets instead of 33 individual ones (freed 22 GitHub secret slots from 100→78).
