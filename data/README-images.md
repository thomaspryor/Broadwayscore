# Broadway MetaScores - Image Curation Guide

## Overview

Shows need 3 different image formats:
- **Square (1080x1080)** - Used for homepage cards/thumbnails
- **Portrait (480x720)** - Used for show detail page posters
- **Landscape (1440x580)** - Used for hero banners

## How to Add Images for a Show

### 1. Find Images on TodayTix

Visit the show's TodayTix page (example for Maybe Happy Ending):
```
https://www.todaytix.com/nyc/shows/41018-maybe-happy-ending-on-broadway
```

### 2. Inspect Network Tab

1. Open browser DevTools → Network tab
2. Filter by "ctfassets" or "images"
3. Look for image files with dimensions in the filename:
   - `*1080x1080*.jpg` = square
   - `*480x720*.jpg` = portrait
   - `*1440x580*.jpg` = landscape

### 3. Add to curated-images.json

Edit `data/curated-images.json` and add entry:

```json
{
  "images": {
    "show-slug": {
      "square": "https://images.ctfassets.net/.../show-name-1080x1080.jpg",
      "portrait": "https://images.ctfassets.net/.../show-name-480x720.jpg",
      "landscape": "https://images.ctfassets.net/.../show-name-1440x580.jpg"
    }
  }
}
```

**Important:** Use the base Contentful URL without query parameters. The script will add appropriate params automatically.

### 4. Apply Changes

Run the apply script:
```bash
node scripts/apply-curated-images.js
```

This will update `data/shows.json` with the properly formatted image URLs.

### 5. Verify

Check the updated images in `data/shows.json` for your show.

## Alternative: Automated Script (when available)

If TodayTix allows automated fetching:
```bash
node scripts/fetch-images.js
```

Note: This may fail due to rate limiting or blocking. Manual curation via `curated-images.json` is more reliable.

## Image URL Format

The apply script automatically adds Contentful query parameters:

- **Hero/Landscape**: `?w=1920&h=1080&fit=pad&q=90&bg=rgb:1a1a1a`
- **Thumbnail/Square**: `?h=450&fm=webp&q=90`
- **Poster/Portrait**: `?h=450&f=faces&fit=fill&fm=webp&q=90`

These params optimize each image for its use case while preserving quality.
